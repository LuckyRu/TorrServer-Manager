    // ---------- core: Result/Outcome ----------
    //
    // A consistent success/failure shape for async domain operations, used point-by-point where it
    // fixes a real gap — not a blanket rewrite of every response shape in the plugin. In particular,
    // search/search-backend.js's `{results, indexers, failed}` is left alone: it's already
    // informationally equivalent to a two-outcome Result for its three current callers, so converting
    // it would be pure churn with no bug fixed. Introduced first for metadata/tmdb.js's fetchSeason,
    // which today CANNOT express "the fetch failed" at all — shared/utils.js's request() is built on
    // a Promise that never rejects (network failure resolves to `null`, same as "no data"), so a
    // network error and a legitimately empty TMDB season were structurally indistinguishable.
    //
    // error.kind is a short machine-readable tag (e.g. 'network'), not shown to the user directly —
    // error.message is the human-facing string (already how every existing error string in this
    // plugin is written, in Russian, matching the rest of the UI).

    export function ok(value) {
        return { ok: true, value: value };
    }

    export function err(kind, message, options) {
        options = options || {};
        return {
            ok: false,
            error: {
                kind: kind,
                message: message,
                retryable: !!options.retryable,
                cause: options.cause
            }
        };
    }
