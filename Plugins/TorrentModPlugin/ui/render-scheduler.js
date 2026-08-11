export function createRenderScheduler(scope, render) {
    var pending = {};
    var scheduled = false;
    var untrackFrame = null;
    var cancelFrame = null;

    function clearFrame(cancel) {
        if (cancel && cancelFrame) cancelFrame();
        cancelFrame = null;
        if (untrackFrame) {
            untrackFrame();
            untrackFrame = null;
        }
    }

    function flush() {
        clearFrame(false);
        scheduled = false;
        var reasons = pending;
        pending = {};
        if (scope.isAlive()) render(reasons);
    }

    function schedule(reason) {
        if (reason) pending[reason] = true;
        if (scheduled) return;
        scheduled = true;

        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            var frame = window.requestAnimationFrame(flush);
            cancelFrame = function () { window.cancelAnimationFrame(frame); };
            untrackFrame = scope.track(cancelFrame);
        } else {
            scope.setTimeout(flush, 16);
        }
    }

    return {
        invalidate: schedule,
        flushNow: function () {
            if (!scheduled) return;
            clearFrame(true);
            flush();
        },
        hasPending: function () { return scheduled; }
    };
}
