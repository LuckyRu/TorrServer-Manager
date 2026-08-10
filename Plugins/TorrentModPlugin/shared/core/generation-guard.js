    export function isCurrentGeneration(store, generationKey, generation, isDestroyed, isStillValid) {
        if (isDestroyed()) return false;
        var state = store.get();
        if (state[generationKey] !== generation) return false;
        if (isStillValid && !isStillValid(state)) return false;
        return true;
    }
