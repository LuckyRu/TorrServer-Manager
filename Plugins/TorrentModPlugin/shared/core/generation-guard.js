    // ---------- core: generation-based staleness guard ----------
    //
    // Replaces four near-identical, hand-rolled staleness checks in domain/episodes-interactor.js
    // (loadEpisodes, loadAllTorrents, ensureSeasonLoaded) and domain/selection-interactor.js
    // (freshSearch) with one shared function — closing a real gap plain value comparison can't:
    // switching season 2 -> 3 -> 2 again quickly, the *first* season-2 request's late response would
    // pass a naive "season !== requestedSeason" check (season really is 2 again) even though a
    // second, newer season-2 fetch is also in flight and should win. Each interactor call that starts
    // a fresh async op captures the store's current generation counter before awaiting; the response
    // is only trusted if that counter still matches when it resolves.
    //
    // Deliberately NOT a bigger "guarded task" wrapper (bump generation, run, commit) — what each of
    // the four sites actually commits to the store on success/failure genuinely differs (a flat
    // status field vs. a seasonLoads[season] map entry vs. an extra in-flight dedup unrelated to
    // generations at all), so forcing them through one onStart/onResult callback shape would be
    // indirection over code that already reads fine inline. This is the one piece that's identical at
    // all four sites: the check itself.
    //
    // isStillValid is optional — only freshSearch needs it today (a generation match alone isn't
    // enough there: setSeason() bumps seasonGeneration but not searchGeneration, so a customQuery
    // search made for the old season could still pass a bare generation check after the season
    // changed underneath it).
    export function isCurrentGeneration(store, generationKey, generation, isDestroyed, isStillValid) {
        if (isDestroyed()) return false;
        var state = store.get();
        if (state[generationKey] !== generation) return false;
        if (isStillValid && !isStillValid(state)) return false;
        return true;
    }
