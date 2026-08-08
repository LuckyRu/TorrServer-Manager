    // ---------- core: lifecycle guard ----------
    //
    // Unifies the FORM of "is this thing still alive, and how do I tear it down exactly once" — not
    // any particular lifetime. domain/results-domain.js's isDestroyed() (a closure-flag function) and
    // playback/smart-preload.js's per-session `session.alive` boolean + `session.dispose()` were two
    // independently-invented mechanisms doing the same job with different shapes. They deliberately
    // guard two DIFFERENT lifetimes (playback intentionally outlives the results screen — see
    // results-domain.js's own header comment) and stay that way; this primitive only gives both a
    // shared shape to build on, migrated one at a time as each side comes up for its own change.
    export function createLifecycle() {
        var alive = true;
        return {
            isAlive: function () { return alive; },
            // Idempotent: a second dispose() call is a no-op (returns false) rather than re-running
            // onDispose or flipping already-false state — matches both of the mechanisms this
            // replaces, which already had to guard against being torn down twice.
            dispose: function (onDispose) {
                if (!alive) return false;
                alive = false;
                if (onDispose) onDispose();
                return true;
            }
        };
    }
