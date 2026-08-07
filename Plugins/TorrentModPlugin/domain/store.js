    // ---------- domain: store (generic observable state, no domain knowledge) ----------
    //
    // Lampa itself has zero reactivity of any kind (confirmed against its real source — see
    // docs/reference/lampa-plugin-api.md) — there is no framework primitive to subscribe to a state
    // change, so this ~25-line pub-sub is the whole of what we build ourselves rather than adopt a
    // library for. Deliberately generic and small: this file has no idea what "season" or "episode"
    // means, on purpose — staleness/dependency policy (generation counters etc.) lives in the domain
    // layer that actually understands it (results-state.js), not baked in here. A single flat store
    // with one subscription, not per-field/per-topic pub-sub: this is a TV remote-control UI where
    // every state transition is already a discrete, deliberate action (a D-pad press, a network
    // response resolving) at most a few times a minute, not continuous high-frequency input — the
    // performance problem topic-based pub-sub solves in a web app doesn't exist here, so building a
    // second layer of subscription machinery for it would be pure ceremony.
    export function createStore(initialState) {
        var state = initialState;
        var listeners = [];

        function get() {
            return state;
        }

        function subscribe(listener) {
            listeners.push(listener);
            return function unsubscribe() {
                var index = listeners.indexOf(listener);
                if (index >= 0) listeners.splice(index, 1);
            };
        }

        // Shallow-merges `partial` into a *new* top-level object, so any field the caller didn't
        // touch keeps its old reference — that's what makes a plain `state.x !== previous.x` check
        // in the view a valid, cheap way to decide what changed, no deep-diffing needed.
        function patch(partial) {
            var previous = state;
            state = Object.assign({}, state, partial);
            listeners.slice().forEach(function (listener) { listener(state, previous); });
            return state;
        }

        return { get: get, subscribe: subscribe, patch: patch };
    }
