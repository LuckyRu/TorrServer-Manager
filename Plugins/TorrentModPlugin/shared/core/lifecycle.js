    // ---------- core: lifecycle scope ----------
    //
    // A single object every async resource tied to one "plugin launch" (one movie/series screen,
    // from Activity push to back-navigation) registers into — timers, store subscriptions, anything
    // with a cleanup step — so leaving the screen disposes ALL of it through one dispose() call,
    // instead of N separately-remembered destroy() methods that are easy to forget to update when a
    // new timer is added. This happened for real, twice, in this project's history before this
    // existed: the pool AND season auto-retry timers (episodes-interactor.js) each needed a
    // destroy() retrofitted in after the fact, once test leaks (dangling timers bleeding into later
    // tests) and the general "outlives its screen" risk surfaced them — see CLAUDE.md's own account.
    // Requested directly by the user after that: a designed, reusable scope, not another one-off
    // destroy() per module that has to be remembered.
    //
    // Deliberately does NOT cover playback/smart-preload.js's own session lifecycle — that lifetime
    // is intentionally DECOUPLED from this screen's (a download keeps polling after the user backs
    // out, by design, documented at length elsewhere in CLAUDE.md) — this scope is specifically for
    // "things that must die when the results screen does," not a plugin-wide catch-all.
    export function createLifecycle() {
        var alive = true;
        var disposers = [];

        function isAlive() { return alive; }

        // Register an arbitrary cleanup function, run once on dispose(). Returns an "untrack"
        // function that removes it WITHOUT running it — for a resource that already cleaned up
        // after itself (e.g. a one-shot timer that already fired normally). If the scope is already
        // disposed, runs the cleanup immediately instead of silently discarding it: registering
        // after dispose() almost always means a stray async completion racing teardown, and leaking
        // the resource forever would be worse than disposing it one tick late.
        function track(dispose) {
            if (!alive) { dispose(); return function () {}; }
            disposers.push(dispose);
            return function untrack() {
                var index = disposers.indexOf(dispose);
                if (index >= 0) disposers.splice(index, 1);
            };
        }

        // Scoped setTimeout: cancelled automatically on dispose(). Untracks itself the moment it
        // fires normally — nothing left to cancel at that point, no reason to hold the disposer
        // reference forever for what is (by far) the common case, a timer that just runs to
        // completion.
        function scopedSetTimeout(fn, ms) {
            var untrack;
            var id = setTimeout(function () {
                if (untrack) untrack();
                fn();
            }, ms);
            untrack = track(function () { clearTimeout(id); });
            return id;
        }

        // Scoped setInterval: cancelled automatically on dispose(). Unlike setTimeout, an interval
        // never self-terminates, so there is no "fires once, untracks itself" case — the caller is
        // still expected to clearInterval(id) itself on its own normal stop condition (e.g. a
        // status-ticking interval stopping once the state it was ticking for settles); the returned
        // id is a plain native interval id, so that call works exactly as it always has. The scope's
        // own tracked cleanup is only the LAST-RESORT net for "the screen closed before that normal
        // stop condition was ever reached."
        function scopedSetInterval(fn, ms) {
            var id = setInterval(fn, ms);
            track(function () { clearInterval(id); });
            return id;
        }

        // Scoped store subscription: unsubscribed automatically on dispose().
        function scopedSubscribe(store, listener) {
            var unsubscribe = store.subscribe(listener);
            track(unsubscribe);
            return unsubscribe;
        }

        // Idempotent: a second dispose() call is a no-op (returns false) rather than re-running
        // cleanups or flipping already-false state. Runs cleanups in reverse registration order
        // (last-registered, first-disposed) — the usual convention for teardown stacks, and means a
        // resource that happens to depend on an earlier one (rare here, but not impossible) tears
        // down first. Each cleanup is individually try/caught so one throwing doesn't stop the rest
        // from running — a screen tearing down must not leave HALF its resources leaked because one
        // cleanup function had a bug.
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
            dispose: dispose
        };
    }
