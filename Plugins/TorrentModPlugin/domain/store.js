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

        function patch(partial) {
            var previous = state;
            state = Object.assign({}, state, partial);
            listeners.slice().forEach(function (listener) { listener(state, previous); });
            return state;
        }

        return { get: get, subscribe: subscribe, patch: patch };
    }
