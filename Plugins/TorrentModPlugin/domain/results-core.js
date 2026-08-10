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

    export function searchQueryText(target) {
        return defaultSearchName(target.movie, target.englishTitle);
    }

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

    export function activeFilterLabels(state) {
        var labels = [];
        if (state.voiceType !== 'any') labels.push(state.voiceType);
        if (state.resolution !== 'any') labels.push(QUALITY_LABELS[state.resolution] || state.resolution);
        if (state.bitrate && state.bitrate !== 'any') labels.push(BITRATE_LABELS[state.bitrate] || state.bitrate);
        return labels;
    }

    export function candidatesForEpisode(pool, target, state) {
        var filtered = applyStateFilters(pool, state);
        var scored = filtered.filter(function (item) {
            item._score = scoreCandidate(item, target);
            return item._score.passes;
        });
        scored.sort(function (a, b) { return b._score.value - a._score.value || b.seeders - a.seeders; });
        return scored;
    }

    export function badgeText(matches, saved) {
        if (!matches.length) return 'раздачи не найдены';
        var best = findSavedDefault(matches, saved) || matches[0];
        var bits = [];
        if (best.release.resolution) bits.push(best.release.resolution);
        if (best.release.translator || best.release.voiceType) bits.push(best.release.translator || best.release.voiceType);
        bits.push(best.seeders + ' сид.');
        if (matches.length > 1) bits.push('+' + (matches.length - 1));
        return bits.join(' · ');
    }

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
        if (item.release.compatibility === 'risky') {
            bits.push('Риск: ' + (item.release.compatibilityReason || item.release.videoCodec || item.release.container || 'формат'));
        }
        return bits.join(' · ');
    }

    export function candidateIdentity(item) {
        return compact(item.magnet || (item.title + '|' + item.size));
    }

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
