import { createRunner } from './helpers/test-runner.mjs';
import { ok, err } from '../shared/core/result.js';
import { isCurrentGeneration } from '../shared/core/generation-guard.js';
import { createLifecycle } from '../shared/core/lifecycle.js';
import { createStore } from '../domain/store.js';
import { debug, debugEnabled, diagnosticsSnapshot } from '../shared/core/log.js';
import { createRenderScheduler } from '../ui/render-scheduler.js';
import { reconcileKeyedChildren } from '../ui/keyed-dom.js';
import { createPerfMetrics } from '../shared/core/perf-metrics.js';
import { resolveContentRightIntent, resolvePickerRightIntent } from '../ui/navigation-intents.js';

const runner = createRunner();

runner.test('ok() wraps a value as a successful Result', () => {
    const result = ok(42);
    if (result.ok !== true) throw new Error('ok.ok должен быть true');
    if (result.value !== 42) throw new Error('ok.value потерян: ' + JSON.stringify(result));
});

runner.test('err() builds a failed Result with kind/message/retryable', () => {
    const result = err('network', 'Список серий недоступен', { retryable: true });
    if (result.ok !== false) throw new Error('err.ok должен быть false');
    if (result.error.kind !== 'network') throw new Error('kind потерян: ' + JSON.stringify(result));
    if (result.error.message !== 'Список серий недоступен') throw new Error('message потерян: ' + JSON.stringify(result));
    if (result.error.retryable !== true) throw new Error('retryable потерян: ' + JSON.stringify(result));
});

runner.test('err() defaults retryable to false and cause to undefined when omitted', () => {
    const result = err('empty', 'Ничего не найдено');
    if (result.error.retryable !== false) throw new Error('retryable по умолчанию должен быть false: ' + JSON.stringify(result));
    if (result.error.cause !== undefined) throw new Error('cause по умолчанию должен быть undefined: ' + JSON.stringify(result));
});

runner.test('err() carries an optional cause through unchanged', () => {
    const originalError = new Error('boom');
    const result = err('network', 'Сбой сети', { cause: originalError });
    if (result.error.cause !== originalError) throw new Error('cause не совпадает с переданным');
});

function alwaysAlive() { return false; }
function alwaysDestroyed() { return true; }

runner.test('isCurrentGeneration: destroyed → false regardless of generation match', () => {
    const store = createStore({ seasonGeneration: 1 });
    if (isCurrentGeneration(store, 'seasonGeneration', 1, alwaysDestroyed)) throw new Error('destroyed должен давать false');
});

runner.test('isCurrentGeneration: generation mismatch → false', () => {
    const store = createStore({ seasonGeneration: 1 });
    store.patch({ seasonGeneration: 2 }); // ушли на новое поколение, как при повторном setSeason
    if (isCurrentGeneration(store, 'seasonGeneration', 1, alwaysAlive)) throw new Error('устаревшее поколение должно давать false');
});

runner.test('isCurrentGeneration: generation match, no isStillValid → true', () => {
    const store = createStore({ seasonGeneration: 1 });
    if (!isCurrentGeneration(store, 'seasonGeneration', 1, alwaysAlive)) throw new Error('совпадающее поколение должно давать true');
});

runner.test('isCurrentGeneration: isStillValid false → false even if generation matches', () => {
    const store = createStore({ poolGeneration: 1, season: 2 });
    const stillTargeted = (state) => state.season === 3; // имитирует смену сезона под запрос пула
    if (isCurrentGeneration(store, 'poolGeneration', 1, alwaysAlive, stillTargeted)) {
        throw new Error('isStillValid=false должен давать false даже при совпадающем поколении');
    }
});

runner.test('isCurrentGeneration: isStillValid true and generation matches → true', () => {
    const store = createStore({ poolGeneration: 1, season: 2 });
    const stillTargeted = (state) => state.season === 2;
    if (!isCurrentGeneration(store, 'poolGeneration', 1, alwaysAlive, stillTargeted)) {
        throw new Error('всё совпадает — должен давать true');
    }
});

runner.test('store.subscribeSelector реагирует только на изменившуюся проекцию', () => {
    const store = createStore({ pool: [], filters: { translator: 'any' }, status: 'idle' });
    const calls = [];
    store.subscribeSelector(
        (state) => [state.pool, state.filters],
        (next, previous) => calls.push({ next, previous }),
        (left, right) => left[0] === right[0] && left[1] === right[1]
    );
    store.patch({ status: 'loading' });
    store.patch({ filters: { translator: 'LostFilm' } });
    if (calls.length !== 1 || calls[0].next[1].translator !== 'LostFilm') throw new Error(JSON.stringify(calls));
});

runner.test('store revisions меняются только при смене отслеживаемой ссылки', () => {
    const pool = [];
    const store = createStore({ pool, poolRevision: 0, status: 'idle' }, { revisions: { pool: 'poolRevision' } });
    store.patch({ status: 'loading' });
    store.patch({ pool });
    if (store.get().poolRevision !== 0) throw new Error('revision изменилась без нового пула');
    store.patch({ pool: pool.slice() });
    if (store.get().poolRevision !== 1) throw new Error('revision не изменилась с новым пулом');
});

runner.test('verbose diagnostics пишет в ограниченный buffer без обязательного console', () => {
    const previousWindow = globalThis.window;
    globalThis.window = { TorrentModDiagnostics: { verbose: true, consoleOutput: false, maxEntries: 2 } };
    try {
        if (!debugEnabled()) throw new Error('verbose не включился');
        debug('test', 'one', { value: 1 });
        debug('test', 'two');
        debug('test', 'three');
        const entries = diagnosticsSnapshot();
        if (entries.length !== 2 || entries[0].message !== 'two' || entries[1].message !== 'three') {
            throw new Error(JSON.stringify(entries));
        }
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});

runner.test('performance diagnostics собирает bounded summary без влияния на domain state', () => {
    const previousWindow = globalThis.window;
    const previousLog = console.log;
    globalThis.window = { TorrentModDiagnostics: { performance: true } };
    console.log = () => {};
    try {
        const scope = createLifecycle();
        const metrics = createPerfMetrics(scope, { title: 'fixture' });
        metrics.searchState('loading');
        metrics.poolPatched(1);
        const value = metrics.measure('episode-projection', () => 42);
        metrics.count('layerUpdates');
        metrics.gauge('mountedPickerRows', 39);
        metrics.poolRendered();
        metrics.searchState('ready');

        const sessions = window.TorrentModDiagnostics.performanceSnapshot();
        if (value !== 42 || sessions.length !== 1) throw new Error(JSON.stringify(sessions));
        const summary = sessions[0];
        if (summary.measures['episode-projection'].count !== 1) throw new Error(JSON.stringify(summary));
        if (summary.measures['pool-patch-to-render'].count !== 1) throw new Error(JSON.stringify(summary));
        if (summary.counters.layerUpdates !== 1 || summary.gauges.mountedPickerRows !== 39) {
            throw new Error(JSON.stringify(summary));
        }
        scope.dispose();
        if (window.TorrentModDiagnostics.performanceSnapshot().length !== 1) throw new Error('dispose продублировал summary');
    } finally {
        console.log = previousLog;
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});

runner.test('series right navigation сохраняет маршруты picker и filter', () => {
    if (resolveContentRightIntent({ episodeFocused: true, candidateFocused: false, filterAvailable: true }) !== 'picker') {
        throw new Error('right на серии должен открывать picker');
    }
    if (resolveContentRightIntent({ episodeFocused: false, candidateFocused: true, filterAvailable: true }) !== 'filter') {
        throw new Error('right на списке кандидатов должен открывать фильтр');
    }
    if (resolveContentRightIntent({ episodeFocused: false, candidateFocused: true, filterAvailable: false }) !== 'move-right') {
        throw new Error('при отсутствии filter-chip нельзя перехватывать right');
    }
    if (resolvePickerRightIntent({ filterAvailable: true }) !== 'filter-after-close') {
        throw new Error('right из picker должен сначала закрыть overlay и открыть фильтр');
    }
    if (resolvePickerRightIntent({ filterAvailable: false }) !== 'close') {
        throw new Error('picker без filter-chip должен только закрываться');
    }
});

runner.test('render scheduler объединяет invalidations в один frame и отменяется lifecycle', () => {
    const previousWindow = globalThis.window;
    const frames = new Map();
    let nextFrame = 1;
    globalThis.window = {
        requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
        cancelAnimationFrame(id) { frames.delete(id); }
    };
    try {
        const scope = createLifecycle();
        const commits = [];
        const scheduler = createRenderScheduler(scope, (reasons) => commits.push(reasons));
        scheduler.invalidate('content');
        scheduler.invalidate('badges');
        if (frames.size !== 1) throw new Error('создано кадров: ' + frames.size);
        const callback = frames.values().next().value;
        frames.clear();
        callback();
        if (commits.length !== 1 || !commits[0].content || !commits[0].badges) throw new Error(JSON.stringify(commits));

        scheduler.invalidate('immediate');
        scheduler.flushNow();
        if (frames.size !== 0 || commits.length !== 2 || !commits[1].immediate) {
            throw new Error('flushNow не отменил ожидающий rAF: ' + JSON.stringify(commits));
        }

        scheduler.invalidate('picker');
        scope.dispose();
        if (frames.size !== 0) throw new Error('dispose не отменил rAF');
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});

runner.test('keyed DOM reconcile не трогает стабильный порядок и двигает только нужные узлы', () => {
    function fakeContainer(initial) {
        return {
            children: initial.slice(),
            insertBefore(node, before) {
                const old = this.children.indexOf(node);
                if (old >= 0) this.children.splice(old, 1);
                const index = before ? this.children.indexOf(before) : this.children.length;
                this.children.splice(index < 0 ? this.children.length : index, 0, node);
            },
            removeChild(node) {
                const index = this.children.indexOf(node);
                if (index >= 0) this.children.splice(index, 1);
            }
        };
    }
    const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' }, d = { id: 'd' };
    const container = fakeContainer([a, b, c]);
    if (reconcileKeyedChildren(container, [a, b, c]) !== 0) throw new Error('стабильный порядок мутировал');
    if (reconcileKeyedChildren(container, [d, a, b, c]) !== 1) throw new Error('вставка одного узла сделала лишнюю работу');
    reconcileKeyedChildren(container, [a, c, d]);
    if (container.children.map((node) => node.id).join(',') !== 'a,c,d') throw new Error(JSON.stringify(container.children));
});

runner.test('createLifecycle: isAlive() starts true', () => {
    const lifecycle = createLifecycle();
    if (!lifecycle.isAlive()) throw new Error('только что созданный lifecycle должен быть alive');
});

runner.test('createLifecycle: dispose() flips isAlive() to false and runs onDispose', () => {
    const lifecycle = createLifecycle();
    let disposeCalled = false;
    const returned = lifecycle.dispose(() => { disposeCalled = true; });
    if (returned !== true) throw new Error('первый dispose() должен вернуть true');
    if (lifecycle.isAlive()) throw new Error('isAlive() должен стать false после dispose()');
    if (!disposeCalled) throw new Error('onDispose не вызван');
});

runner.test('createLifecycle: dispose() is idempotent — second call is a no-op', () => {
    const lifecycle = createLifecycle();
    let disposeCalls = 0;
    lifecycle.dispose(() => { disposeCalls++; });
    const secondReturn = lifecycle.dispose(() => { disposeCalls++; });
    if (secondReturn !== false) throw new Error('повторный dispose() должен вернуть false');
    if (disposeCalls !== 1) throw new Error('onDispose должен вызваться ровно один раз, вызван ' + disposeCalls + ' раз');
});

runner.test('createLifecycle: dispose() without onDispose does not throw', () => {
    const lifecycle = createLifecycle();
    lifecycle.dispose();
    if (lifecycle.isAlive()) throw new Error('isAlive() должен стать false даже без onDispose');
});

runner.test('createLifecycle: parent dispose disposes child scope', () => {
    const parent = createLifecycle();
    const child = parent.child();
    let cleaned = 0;
    child.track(() => cleaned++);
    parent.dispose();
    if (child.isAlive()) throw new Error('child остался жив после parent.dispose()');
    if (cleaned !== 1) throw new Error('cleanup child должен выполниться ровно один раз');
});

runner.test('createLifecycle: explicit child dispose не завершает parent', () => {
    const parent = createLifecycle();
    const child = parent.child();
    child.dispose();
    if (!parent.isAlive()) throw new Error('child.dispose() завершил parent');
    parent.dispose();
});

await runner.run();
