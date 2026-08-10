    // Shared registry every async resource of one screen/session registers into, so one dispose()
    // tears down all of it; see docs/system-design/torrent-mod-parallel-search.md. Not tied to one
    // particular UI — playback uses the same primitive independently, with a parent scope owning
    // child (per-file) scopes.
    export function createLifecycle() {
        var alive = true;
        var disposers = [];

        function isAlive() { return alive; }

        // Returns an "untrack" fn to remove the cleanup without running it. If already disposed,
        // runs the cleanup immediately rather than discarding it — a stray async completion racing
        // teardown should still get cleaned up, just a tick late.
        function track(dispose) {
            if (!alive) { dispose(); return function () {}; }
            disposers.push(dispose);
            return function untrack() {
                var index = disposers.indexOf(dispose);
                if (index >= 0) disposers.splice(index, 1);
            };
        }

        // Cancelled automatically on dispose(); untracks itself once it fires normally.
        function scopedSetTimeout(fn, ms) {
            var untrack;
            var id = setTimeout(function () {
                if (untrack) untrack();
                fn();
            }, ms);
            untrack = track(function () { clearTimeout(id); });
            return id;
        }

        // Cancelled automatically on dispose(), but (unlike setTimeout) never self-terminates — the
        // caller must still clearInterval(id) itself on its own stop condition; the scope's cleanup
        // is only the last-resort net for a screen that closed before that.
        function scopedSetInterval(fn, ms) {
            var id = setInterval(fn, ms);
            track(function () { clearInterval(id); });
            return id;
        }

        // Unsubscribed automatically on dispose().
        function scopedSubscribe(store, listener) {
            var unsubscribe = store.subscribe(listener);
            track(unsubscribe);
            return unsubscribe;
        }

        // Nested scope, tracked by this parent immediately so a parent teardown can't forget it;
        // disposing the child directly untracks it from the parent instead of leaving a dead disposer.
        function child() {
            var nested = createLifecycle();
            var nestedDispose = nested.dispose;
            var untrack = track(function () { nestedDispose(); });
            nested.dispose = function (onDispose) {
                untrack();
                return nestedDispose(onDispose);
            };
            return nested;
        }

        // Idempotent (a second call is a no-op); runs cleanups in reverse registration order, each
        // individually try/caught so one throwing cleanup can't leak the rest.
        function dispose(onDispose) {
            if (!alive) return false;
            alive = false;
            disposers.slice().reverse().forEach(function (cleanup) {
                try { cleanup(); } catch (e) {}
            });
            disposers = [];
            if (onDispose) onDispose();
            return true;
        }

        return {
            isAlive: isAlive,
            track: track,
            setTimeout: scopedSetTimeout,
            setInterval: scopedSetInterval,
            subscribe: scopedSubscribe,
            child: child,
            dispose: dispose
        };
    }
