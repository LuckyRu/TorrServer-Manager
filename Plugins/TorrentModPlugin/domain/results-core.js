    // ---------- results screen: core (pure state shape + pure logic) ----------
    //
    // Zero DOM/jQuery/Lampa.Explorer/Filter/Controller/Scroll awareness by design — every function
    // here takes its inputs as plain parameters and returns plain data, so it's the one layer of
    // the results screen that could in principle be exercised without a browser at all. Calling
    // into the already-separated search/metadata modules (scoring, season data) is fine — those
    // are data-layer, not UI-layer, dependencies. See domain/results-domain.js for the composition
    // root that owns mutable state and calls these, and ui/results-screen.js for the Lampa-facing view.
    import { defaultSearchName } from '../search/query-building.js';
    import { formatSize, compact } from '../shared/utils.js';
    import { buildSeasonItems } from '../metadata/season-picker.js';
    import { applyStateFilters, scoreCandidate, bitrateBucket, estimateBitrateForState } from '../search/scoring.js';

    export function createInitialState(object) {
        return {
            season: object.season || 0,
            voiceType: 'any',
            resolution: 'any',
            bitrate: 'any'
        };
    }

    export function isSeriesWithSeasons(movie) {
        return !!(movie.number_of_seasons);
    }

    // The search chip text: Lampa's own parse_lang search name — the exact thing the pool is
    // actually queried with (see query-building.js defaultSearchName). Deliberately NO season/
    // episode suffix: the whole-work pool is a plain title query, so showing "Футурама S02" in the
    // chip while searching just "Футурама" was a lie (and with the local pool model, clicking an
    // episode doesn't change the underlying query either).
    export function searchQueryText(target) {
        return defaultSearchName(target.movie);
    }

    // Options come from what's actually in the whole-work pool once it's loaded — no point offering
    // a "4K" filter for a season nothing 4K was ever found in — falling back to a generic static
    // list only while the pool is still loading (or for movies, which never populate one).
    export function poolValues(state, pluck, order) {
        var pool = state.pool || [];
        var present = {};
        pool.forEach(function (item) { var v = pluck(item); if (v) present[v] = true; });
        return order ? order.filter(function (v) { return present[v]; }) : Object.keys(present);
    }

    export var QUALITY_LABELS = { '2160p': '4K', '1080p': '1080p', '720p': '720p', '480p': '480p' };

    // Bucket keys must match scoring.js's bitrateBucket() output.
    export var BITRATE_LABELS = { 'b2': 'До 2 Мбит/с', 'b2-5': '2–5 Мбит/с', 'b5-12': '5–12 Мбит/с', 'b12': '12+ Мбит/с' };

    export function currentSeasonLabel(movie, hasSeasons, state) {
        if (!hasSeasons) return '';
        var found = buildSeasonItems(movie, state.season).filter(function (item) { return item.season === state.season; })[0];
        return found ? found.title : ('Сезон ' + state.season);
    }

    // Two of Lampa.Filter's three built-in chips ('sort'/'filter'), repurposed — confirmed live
    // this is exactly the native pattern, not a shortcut: Online Mod's own results screen does the
    // same thing (new Lampa.Filter(object), then filter.set('sort', its balancer list) and
    // filter.set('filter', its quality list)) rather than appending extra hand-built chips of its
    // own. 'sort' here is season (not literal sort order — Online Mod repurposes it too, for an
    // unrelated balancer picker, so the label/semantics aren't locked to the chip's own name).
    //
    // The 'filter' panel's shape (reset row first, then one row per dimension showing its current
    // value as a subtitle, each opening a nested Select on pick) is copied from Online Mod's own
    // `this.filter()` method, read directly rather than guessed — its `add(type, title)` helper
    // builds exactly this: `{title, subtitle: currentValue, items: subitems, stype: type}`, plus
    // a `{title: 'Сбросить фильтр', reset: true}` leaf with no `.items` (so Filter.show() calls
    // onSelect(type, a) directly, no nested submenu, on pick). Online Mod also repeats its 'sort'
    // dimension (balancer) inside this same panel for a one-stop view — we do the same with season.
    export function buildFilterItems(movie, hasSeasons, state) {
        var select = [{ title: 'Сбросить фильтр', reset: true }];

        if (hasSeasons) {
            select.push({
                title: 'Сезон',
                subtitle: currentSeasonLabel(movie, hasSeasons, state),
                kind: 'season',
                items: buildSeasonItems(movie, state.season)
            });
        }

        var voiceFound = poolValues(state, function (item) { return item.release.voiceType; });
        // Static fallback list only while the pool is still loading (pool === null); once loaded,
        // offer exactly what's in it — a ready-but-empty pool must not advertise options that
        // don't exist (found in review).
        var voiceOptions = state.pool ? (voiceFound.length ? voiceFound : []) : ['Дубляж', 'Многоголосый', 'Одноголосый', 'Оригинал'];
        var voiceItems = [{ title: 'Любой', value: 'any', selected: state.voiceType === 'any' }].concat(
            voiceOptions.map(function (v) {
                return { title: v, value: v, selected: state.voiceType === v };
            })
        );
        select.push({
            title: 'Перевод',
            subtitle: state.voiceType === 'any' ? 'Любой' : state.voiceType,
            kind: 'voice',
            items: voiceItems
        });

        var order = ['2160p', '1080p', '720p', '480p'];
        var qualityFound = poolValues(state, function (item) { return item.release.resolution; }, order);
        var qualityOptions = state.pool ? (qualityFound.length ? qualityFound : []) : ['2160p', '1080p', '720p'];
        var qualityItems = [{ title: 'Любое', value: 'any', selected: state.resolution === 'any' }].concat(
            qualityOptions.map(function (v) {
                return { title: QUALITY_LABELS[v] || v, value: v, selected: state.resolution === v };
            })
        );
        select.push({
            title: 'Качество',
            subtitle: state.resolution === 'any' ? 'Любое' : (QUALITY_LABELS[state.resolution] || state.resolution),
            kind: 'quality',
            items: qualityItems
        });

        // Bitrate dimension (Etap 3): the primary quality signal for anyone who understands it —
        // more informative than file size. Options are built ONLY from buckets actually present in
        // the pool (same poolValues mechanism as voice/quality), estimated per-episode bitrate.
        var bitrateOrder = ['b2', 'b2-5', 'b5-12', 'b12'];
        var bitrateFound = poolValues(state, function (item) {
            return bitrateBucket(estimateBitrateForState(item, state));
        }, bitrateOrder);
        var bitrateOptions = state.pool ? (bitrateFound.length ? bitrateFound : []) : bitrateOrder;
        var bitrateItems = [{ title: 'Любой', value: 'any', selected: (state.bitrate || 'any') === 'any' }].concat(
            bitrateOptions.map(function (v) {
                return { title: BITRATE_LABELS[v] || v, value: v, selected: state.bitrate === v };
            })
        );
        select.push({
            title: 'Битрейт',
            subtitle: (state.bitrate || 'any') === 'any' ? 'Любой' : (BITRATE_LABELS[state.bitrate] || state.bitrate),
            kind: 'bitrate',
            items: bitrateItems
        });

        return select;
    }

    // Season already has its own fast-access chip ('sort'), so the 'filter' chip's own summary
    // (shown on the collapsed toolbar chip itself, via filter.chosen) only needs voice+quality+
    // bitrate — repeating the season label there too would just duplicate what's already visible
    // next to it.
    export function activeFilterLabels(state) {
        var labels = [];
        if (state.voiceType !== 'any') labels.push(state.voiceType);
        if (state.resolution !== 'any') labels.push(QUALITY_LABELS[state.resolution] || state.resolution);
        if (state.bitrate && state.bitrate !== 'any') labels.push(BITRATE_LABELS[state.bitrate] || state.bitrate);
        return labels;
    }

    // Same gate + scoring pipeline a fresh search uses (matchesTranslation/state.resolution filter
    // via applyStateFilters, passesMatchGate via scoreCandidate), just run against an already-fetched
    // pool instead of a new network call — used both for the instant-click reuse path and for the
    // episode-row availability badges. `target` is built by the caller (ViewModel), not here — this
    // function has no access to `object`/closure state to build one itself.
    export function candidatesForEpisode(pool, target, state) {
        var filtered = applyStateFilters(pool, state);
        var scored = filtered.filter(function (item) {
            item._score = scoreCandidate(item, target);
            return item._score.passes;
        });
        scored.sort(function (a, b) { return b._score.value - a._score.value || b.seeders - a.seeders; });
        return scored;
    }

    export function badgeText(matches) {
        if (!matches.length) return 'раздачи не найдены';
        var best = matches[0];
        var bits = [];
        if (best.release.resolution) bits.push(best.release.resolution);
        if (best.release.translator || best.release.voiceType) bits.push(best.release.translator || best.release.voiceType);
        bits.push(best.seeders + ' сид.');
        if (matches.length > 1) bits.push('+' + (matches.length - 1));
        return bits.join(' · ');
    }

    // Availability floor on auto-play, checked against the *score* (seeders+peers combined,
    // log-scaled — see scoreCandidate), not raw seeders: a "confident" title/season/episode
    // match with an empty swarm would still auto-play without this — which stalls forever
    // instead of feeling like an online service. Below this we always show the picker so the
    // user can knowingly pick a thin release instead of getting stuck.
    export var MIN_AVAILABILITY_FOR_AUTOPLAY = 3;

    export function isConfidentMatch(best, next) {
        return best._score.availabilityScore >= MIN_AVAILABILITY_FOR_AUTOPLAY &&
            (!next || best._score.value - next._score.value >= 6 || best.seeders > next.seeders * 2);
    }

    export function publishedText(item) {
        if (!item.publishedAt) return '';
        var days = Math.floor((Date.now() - item.publishedAt) / 86400000);
        if (days <= 0) return 'сегодня';
        if (days === 1) return 'вчера';
        if (days < 30) return days + ' дн. назад';
        return new Date(item.publishedAt).toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' });
    }

    // Quality/source/translator/tracks line — everything parseRelease() can pull out of the raw
    // title, distinct from the tracker/seeds/size/date line below it. Two lines instead of one
    // because a torrent row has meaningfully more to say than an episode row. Estimated per-episode
    // bitrate (from item._score, computed by the last scoring pass for this candidate) goes first
    // among the technical bits — it's the primary quality signal for anyone who understands it.
    export function candidateBadgeText(item) {
        var bits = [];
        if (item._score && item._score.bitrateMbps) bits.push('~' + (Math.round(item._score.bitrateMbps * 10) / 10) + ' Mbps');
        if (item.release.resolution) bits.push(item.release.resolution);
        if (item.release.sourceType) bits.push(item.release.sourceType);
        if (item.release.hdr) bits.push(item.release.hdr);
        if (item.release.videoCodec) bits.push(item.release.videoCodec);
        if (item.release.container) bits.push(item.release.container);
        if (item.release.translator) bits.push(item.release.translator);
        else if (item.release.voiceType) bits.push(item.release.voiceType);
        if (item.release.audioTracks > 1) bits.push(item.release.audioTracks + ' ауд. дор.');
        else if (item.release.audioChannels) bits.push(item.release.audioChannels);
        if (item.release.subtitles) bits.push('субтитры');
        // Title-level compatibility warning ("древнее говно"): WebOS won't play XviD/DivX/MPEG-2/
        // VC-1/WMV/AVI without TorrServer transcoding. Not a hard gate — it's a visible warning and
        // a ranking penalty, since the title is only a heuristic (see scoring.formatPenalty). The
        // real codec is confirmed by ffprobe at play time (see smart-preload.js).
        if (item.release.compatibility === 'risky') {
            bits.push('Риск: ' + (item.release.compatibilityReason || item.release.videoCodec || item.release.container || 'формат'));
        }
        return bits.join(' · ');
    }

    // The stable identity of a torrent candidate — same rule search-backend uses for dedup
    // (magnet infoHash → link → title+size). Shared so the saved season default can be matched
    // against current pool entries with the exact same notion of "same release".
    export function candidateIdentity(item) {
        return compact(item.magnet || item.link || (item.title + '|' + item.size));
    }

    // Looks a saved season default (as stored by selection-interactor: {id, title, size}) up in the
    // candidate list for the current episode. Returns the pool item if the release is still there
    // (and has survived the current voice/quality/bitrate filters + gate, since it came from
    // candidates), otherwise null → caller falls back to candidates[0].
    export function findSavedDefault(candidates, savedDefault) {
        if (!savedDefault || !savedDefault.id || !candidates.length) return null;
        for (var i = 0; i < candidates.length; i++) {
            if (candidateIdentity(candidates[i]) === savedDefault.id) return candidates[i];
        }
        return null;
    }

    export function candidateSubtitleText(item) {
        var bits = [];
        if (item.tracker) bits.push(item.tracker);
        bits.push(item.seeders + ' сид. · ' + item.peers + ' пир.');
        var size = formatSize(item.size);
        if (size) bits.push(size);
        var published = publishedText(item);
        if (published) bits.push(published);
        return bits.join(' · ');
    }
