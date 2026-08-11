import { diagnosticsState, log } from './log.js';

function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function configured(diagnostics) {
    if (diagnostics && diagnostics.performance === true) return true;
    try {
        var value = Lampa.Storage.field('torrent_mod_perf_diagnostics');
        return value === true || value === 1 || value === 'true' || value === '1';
    } catch (e) { return false; }
}

function percentile(values, percentileValue) {
    if (!values.length) return 0;
    var sorted = values.slice().sort(function (left, right) { return left - right; });
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

function summarizeMeasures(measures) {
    var result = {};
    Object.keys(measures).forEach(function (name) {
        var values = measures[name];
        var total = values.reduce(function (sum, value) { return sum + value; }, 0);
        result[name] = {
            count: values.length,
            totalMs: Math.round(total * 100) / 100,
            maxMs: Math.round(Math.max.apply(Math, values) * 100) / 100,
            p95Ms: Math.round(percentile(values, 0.95) * 100) / 100
        };
    });
    return result;
}

function disabledMetrics() {
    return {
        enabled: false,
        measure: function (name, action) { return action(); },
        count: function () {},
        gauge: function () {},
        observe: function () {},
        poolPatched: function () {},
        poolRendered: function () {},
        searchState: function () {},
        snapshot: function () { return null; },
        finish: function () {}
    };
}

export function createPerfMetrics(scope, details) {
    var diagnostics = diagnosticsState();
    if (!configured(diagnostics)) return disabledMetrics();

    var sequence = 0;
    var searchSequence = 0;
    var session = null;
    var pendingPoolPatches = {};
    var observers = [];

    if (!Array.isArray(diagnostics.performanceSessions)) diagnostics.performanceSessions = [];
    diagnostics.performanceSnapshot = function () {
        return diagnostics.performanceSessions.slice();
    };

    function startSession() {
        searchSequence++;
        session = {
            id: Date.now().toString(36) + '-' + searchSequence,
            startedAt: Date.now(),
            details: details || {},
            measures: {},
            counters: {},
            longTasks: [],
            finished: false
        };
        pendingPoolPatches = {};
    }

    function ensureSession() {
        if (!session || session.finished) startSession();
        return session;
    }

    function recordMeasure(name, duration) {
        var current = ensureSession();
        if (!current.measures[name]) current.measures[name] = [];
        current.measures[name].push(duration);
    }

    function measure(name, action) {
        var start = now();
        var markName = 'torrent-mod:' + name + ':' + (++sequence);
        var canMark = typeof performance !== 'undefined' && performance.mark && performance.measure;
        if (canMark) performance.mark(markName + ':start');
        try { return action(); }
        finally {
            var duration = now() - start;
            recordMeasure(name, duration);
            if (canMark) {
                try {
                    performance.mark(markName + ':end');
                    performance.measure(markName, markName + ':start', markName + ':end');
                    if (performance.clearMarks) {
                        performance.clearMarks(markName + ':start');
                        performance.clearMarks(markName + ':end');
                    }
                    if (performance.clearMeasures) performance.clearMeasures(markName);
                } catch (e) {}
            }
        }
    }

    function count(name, value) {
        var current = ensureSession();
        current.counters[name] = (current.counters[name] || 0) + (value == null ? 1 : value);
    }

    function gauge(name, value) {
        var current = ensureSession();
        if (!current.gauges) current.gauges = {};
        current.gauges[name] = value;
        var maximumName = 'max' + name.charAt(0).toUpperCase() + name.slice(1);
        current.gauges[maximumName] = Math.max(current.gauges[maximumName] || 0, value);
    }

    function observe(root) {
        if (!root || typeof MutationObserver === 'undefined') return;
        var observer = new MutationObserver(function (records) {
            count('domMutations', records.length);
            records.forEach(function (record) {
                count('domNodesAdded', record.addedNodes ? record.addedNodes.length : 0);
                count('domNodesRemoved', record.removedNodes ? record.removedNodes.length : 0);
            });
        });
        observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
        observers.push(observer);
    }

    function poolPatched(revision) {
        pendingPoolPatches[revision] = now();
    }

    function poolRendered() {
        var renderedAt = now();
        Object.keys(pendingPoolPatches).forEach(function (revision) {
            recordMeasure('pool-patch-to-render', renderedAt - pendingPoolPatches[revision]);
        });
        pendingPoolPatches = {};
    }

    function snapshot(reason) {
        if (!session) return null;
        return {
            id: session.id,
            startedAt: session.startedAt,
            finishedAt: Date.now(),
            reason: reason || '',
            details: session.details,
            measures: summarizeMeasures(session.measures),
            counters: Object.assign({}, session.counters),
            gauges: Object.assign({}, session.gauges || {}),
            longTasks: session.longTasks.slice(),
            longTaskCount: session.longTasks.length
        };
    }

    function finish(reason) {
        if (!session || session.finished) return;
        var summary = snapshot(reason);
        session.finished = true;
        diagnostics.performanceSessions.push(summary);
        if (diagnostics.performanceSessions.length > 20) diagnostics.performanceSessions.shift();
        log('perf', 'сессия поиска завершена (' + reason + ')', summary);
    }

    function searchState(status) {
        if (status === 'loading' && (!session || session.finished)) startSession();
        else if (status === 'ready' || status === 'error') finish(status);
    }

    if (typeof PerformanceObserver !== 'undefined') {
        try {
            var longTaskObserver = new PerformanceObserver(function (list) {
                list.getEntries().forEach(function (entry) {
                    var current = ensureSession();
                    current.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
                });
            });
            longTaskObserver.observe({ entryTypes: ['longtask'] });
            observers.push(longTaskObserver);
        } catch (e) {}
    }

    scope.track(function () {
        observers.forEach(function (observer) { try { observer.disconnect(); } catch (e) {} });
        observers = [];
        finish('dispose');
    });

    return {
        enabled: true,
        measure: measure,
        count: count,
        gauge: gauge,
        observe: observe,
        poolPatched: poolPatched,
        poolRendered: poolRendered,
        searchState: searchState,
        snapshot: snapshot,
        finish: finish
    };
}
