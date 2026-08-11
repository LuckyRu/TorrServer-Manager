    export function createStore(initialState, options) {
        var state = initialState;
        var listeners = [];
        var revisions = options && options.revisions ? options.revisions : {};

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

        function subscribeSelector(select, listener, equal) {
            var compare = equal || function (left, right) { return left === right; };
            var selected = select(state);
            return subscribe(function (nextState) {
                var nextSelected = select(nextState);
                if (compare(nextSelected, selected)) return;
                var previousSelected = selected;
                selected = nextSelected;
                listener(nextSelected, previousSelected);
            });
        }

        function patch(partial) {
            var previous = state;
            var next = partial;
            Object.keys(revisions).forEach(function (field) {
                if (!Object.prototype.hasOwnProperty.call(partial, field) || partial[field] === previous[field]) return;
                if (next === partial) next = Object.assign({}, partial);
                var revisionField = revisions[field];
                next[revisionField] = (Number(previous[revisionField]) || 0) + 1;
            });
            state = Object.assign({}, state, next);
            listeners.slice().forEach(function (listener) { listener(state, previous); });
            return state;
        }

        return { get: get, subscribe: subscribe, subscribeSelector: subscribeSelector, patch: patch };
    }
