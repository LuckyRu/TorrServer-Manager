    // Staleness guard: trusts a response only if `generation` still matches the store's current
    // value; see docs/system-design/torrent-mod-domain-architecture.md. `isStillValid` is an optional
    // extra check for callers where a generation match alone isn't enough (e.g. freshSearch, since
    // setSeason() bumps seasonGeneration but not searchGeneration).
    export function isCurrentGeneration(store, generationKey, generation, isDestroyed, isStillValid) {
        if (isDestroyed()) return false;
        var state = store.get();
        if (state[generationKey] !== generation) return false;
        if (isStillValid && !isStillValid(state)) return false;
        return true;
    }
