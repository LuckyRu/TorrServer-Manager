import { createRunner } from './helpers/test-runner.mjs';
import { ok, err } from '../shared/core/result.js';
import { isCurrentGeneration } from '../shared/core/generation-guard.js';
import { createLifecycle } from '../shared/core/lifecycle.js';
import { createStore } from '../domain/store.js';

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
    const store = createStore({ searchGeneration: 1, season: 2, customQuery: 'foo' });
    const stillTargeted = (state) => state.season === 3; // имитирует смену сезона под freshSearch
    if (isCurrentGeneration(store, 'searchGeneration', 1, alwaysAlive, stillTargeted)) {
        throw new Error('isStillValid=false должен давать false даже при совпадающем поколении');
    }
});

runner.test('isCurrentGeneration: isStillValid true and generation matches → true', () => {
    const store = createStore({ searchGeneration: 1, season: 2, customQuery: 'foo' });
    const stillTargeted = (state) => state.season === 2 && state.customQuery === 'foo';
    if (!isCurrentGeneration(store, 'searchGeneration', 1, alwaysAlive, stillTargeted)) {
        throw new Error('всё совпадает — должен давать true');
    }
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
