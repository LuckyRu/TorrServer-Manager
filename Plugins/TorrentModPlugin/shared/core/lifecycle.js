    export function createLifecycle() {
        var alive = true;
        var disposers = [];

        function isAlive() { return alive; }

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
