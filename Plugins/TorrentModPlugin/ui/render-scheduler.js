export function createRenderScheduler(scope, render) {
    var pending = {};
    var scheduled = false;
    var untrackFrame = null;

    function flush() {
        if (untrackFrame) {
            untrackFrame();
            untrackFrame = null;
        }
        scheduled = false;
        var reasons = pending;
        pending = {};
        render(reasons);
    }

    function schedule(reason) {
        if (reason) pending[reason] = true;
        if (scheduled) return;
        scheduled = true;

        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            var frame = window.requestAnimationFrame(flush);
            untrackFrame = scope.track(function () { window.cancelAnimationFrame(frame); });
        } else {
            scope.setTimeout(flush, 0);
        }
    }

    return {
        invalidate: schedule,
        flushNow: flush,
        hasPending: function () { return scheduled; }
    };
}
