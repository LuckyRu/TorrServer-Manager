    import { formatSize, compact } from '../shared/utils.js';
    import { buildSeasonItems } from '../metadata/season-picker.js';
    import { evaluateCandidatePool, payloadBucket, estimatePayloadForState } from '../search/scoring.js';
    import { filtersOf } from './filter-state.js';
    import { releaseIdentity } from '../shared/release-identity.js';

    export function createInitialState(object) {
        return {
            season: object.season || 0,
            filters: {
                voiceType: 'any',
                translator: 'any',
                resolution: 'any',
                bitrate: 'any'
            }
        };
    }

    export function isSeriesWithSeasons(movie) {
        return !!(movie.number_of_seasons);
    }

    export function poolValues(state, pluck, order) {
        var pool = state.pool || [];
        var present = {};
        pool.forEach(function (item) { var v = pluck(item); if (v) present[v] = true; });
        return order ? order.filter(function (v) { return present[v]; }) : Object.keys(present);
    }

    // Раздача несёт несколько переводов сразу, поэтому меню строится из объединения, а не из
    // одного значения на раздачу.
    export function poolVoiceTypes(pool) {
        var found = [];
        var seen = {};
        (pool || []).forEach(function (item) {
            var release = item.release || {};
            var values = release.voiceTypes && release.voiceTypes.length
                ? release.voiceTypes
                : (release.voiceType ? [release.voiceType] : []);
            values.forEach(function (value) {
                if (!value || seen[value]) return;
                seen[value] = true;
                found.push(value);
            });
        });
        return found;
    }

    export function poolTranslators(pool) {
        var found = [];
        var seen = {};
        (pool || []).forEach(function (item) {
            ((item.release && item.release.translators) || []).forEach(function (translator) {
                if (!translator || seen[translator]) return;
                seen[translator] = true;
                found.push(translator);
            });
        });
        return found;
    }

    export var QUALITY_LABELS = { '2160p': '4K', '1080p': '1080p', '720p': '720p', '480p': '480p' };

    // Persisted filter keys stay stable; labels and calculation describe total torrent payload.
    export var PAYLOAD_LABELS = { 'b2': 'До 2 Мбит/с', 'b2-5': '2–5 Мбит/с', 'b5-12': '5–12 Мбит/с', 'b12': '12+ Мбит/с' };

    export function currentSeasonLabel(movie, hasSeasons, state) {
        if (!hasSeasons) return '';
        var found = buildSeasonItems(movie, state.season).filter(function (item) { return item.season === state.season; })[0];
        return found ? found.title : ('Сезон ' + state.season);
    }

    export function buildFilterItems(movie, hasSeasons, state) {
        var filters = filtersOf(state);
        var select = [{ title: 'Сбросить фильтр', reset: true }];

        if (hasSeasons) {
            select.push({
                title: 'Сезон',
                subtitle: currentSeasonLabel(movie, hasSeasons, state),
                kind: 'season',
                items: buildSeasonItems(movie, state.season)
            });
        }

        var voiceFound = poolVoiceTypes(state.pool);
        var voiceOptions = state.pool ? (voiceFound.length ? voiceFound : []) : ['Дубляж', 'Многоголосый', 'Одноголосый', 'Оригинал'];
        var voiceItems = [{ title: 'Любой', value: 'any', selected: filters.voiceType === 'any' }].concat(
            voiceOptions.map(function (v) {
                return { title: v, value: v, selected: filters.voiceType === v };
            })
        );
        select.push({
            title: 'Перевод',
            subtitle: filters.voiceType === 'any' ? 'Любой' : filters.voiceType,
            kind: 'voice',
            items: voiceItems
        });

        var translatorOptions = poolTranslators(state.pool);
        if (filters.translator && filters.translator !== 'any' && translatorOptions.indexOf(filters.translator) < 0) {
            translatorOptions.push(filters.translator);
        }
        var translatorItems = [{ title: 'Любая', value: 'any', selected: (filters.translator || 'any') === 'any' }].concat(
            translatorOptions.map(function (translator) {
                return { title: translator, value: translator, selected: filters.translator === translator };
            })
        );
        select.push({
            title: 'Студия',
            subtitle: (filters.translator || 'any') === 'any' ? 'Любая' : filters.translator,
            kind: 'translator',
            items: translatorItems
        });

        var order = ['2160p', '1080p', '720p', '480p'];
        var qualityFound = poolValues(state, function (item) { return item.release.resolution; }, order);
        var qualityOptions = state.pool ? (qualityFound.length ? qualityFound : []) : ['2160p', '1080p', '720p'];
        var qualityItems = [{ title: 'Любое', value: 'any', selected: filters.resolution === 'any' }].concat(
            qualityOptions.map(function (v) {
                return { title: QUALITY_LABELS[v] || v, value: v, selected: filters.resolution === v };
            })
        );
        select.push({
            title: 'Качество',
            subtitle: filters.resolution === 'any' ? 'Любое' : (QUALITY_LABELS[filters.resolution] || filters.resolution),
            kind: 'quality',
            items: qualityItems
        });

        var bitrateOrder = ['b2', 'b2-5', 'b5-12', 'b12'];
        var bitrateFound = poolValues(state, function (item) {
            var payload = estimatePayloadForState(item, state, movie, hasSeasons ? 'series' : 'movie');
            return payload.confidence === 'high' || payload.confidence === 'medium' ? payloadBucket(payload.mbps) : '';
        }, bitrateOrder);
        var bitrateOptions = state.pool ? (bitrateFound.length ? bitrateFound : []) : bitrateOrder;
        var bitrateItems = [{ title: 'Любой', value: 'any', selected: (filters.bitrate || 'any') === 'any' }].concat(
            bitrateOptions.map(function (v) {
                return { title: PAYLOAD_LABELS[v] || v, value: v, selected: filters.bitrate === v };
            })
        );
        select.push({
            title: 'Поток (оценка)',
            subtitle: (filters.bitrate || 'any') === 'any' ? 'Любой' : (PAYLOAD_LABELS[filters.bitrate] || filters.bitrate),
            kind: 'bitrate',
            items: bitrateItems
        });

        return select;
    }

    export function activeFilterLabels(state) {
        var filters = filtersOf(state);
        var labels = [];
        if (filters.voiceType !== 'any') labels.push(filters.voiceType);
        if (filters.translator && filters.translator !== 'any') labels.push(filters.translator);
        if (filters.resolution !== 'any') labels.push(QUALITY_LABELS[filters.resolution] || filters.resolution);
        if (filters.bitrate && filters.bitrate !== 'any') labels.push(PAYLOAD_LABELS[filters.bitrate] || filters.bitrate);
        return labels;
    }

    export function candidatesForEpisode(pool, target, state) {
        return evaluateCandidatePool(pool, target, state).items;
    }

    export function badgeText(matches, saved) {
        if (!matches.length) return 'раздачи не найдены';
        var best = findSavedDefault(matches, saved) || matches[0];
        return badgeTextForBest(best, matches.length);
    }

    export function badgeTextForBest(best, count) {
        if (!best) return 'раздачи не найдены';
        var bits = [];
        if (best.release.resolution) bits.push(best.release.resolution);
        if (best.release.translators && best.release.translators.length) bits.push(best.release.translators.join(', '));
        else if (best.release.voiceType) bits.push(best.release.voiceType);
        bits.push(best.seeders + ' сид.');
        if (count > 1) bits.push('+' + (count - 1));
        return bits.join(' · ');
    }

    export var MIN_AVAILABILITY_FOR_AUTOPLAY = 4;
    export var MIN_SEEDERS_FOR_AUTOPLAY = 3;

    export function isConfidentMatch(best, next) {
        return !!best && !!best._score && best.seeders >= MIN_SEEDERS_FOR_AUTOPLAY &&
            best._score.matchScore >= 40 &&
            best._score.availabilityScore >= MIN_AVAILABILITY_FOR_AUTOPLAY &&
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
        if (item._score && item._score.payloadMbps) {
            bits.push('~' + (Math.round(item._score.payloadMbps * 10) / 10) + ' Mbps');
            if (item._score.payloadConfidence === 'low') bits.push('грубая оценка');
        }
        if (item.release.resolution) bits.push(item.release.resolution);
        if (item.release.sourceType) bits.push(item.release.sourceType);
        if (item.release.hdr) bits.push(item.release.hdr);
        if (item.release.videoCodec) bits.push(item.release.videoCodec);
        if (item.release.container) bits.push(item.release.container);
        if (item.release.translators && item.release.translators.length) bits.push(item.release.translators.join(', '));
        else if (item.release.voiceType) bits.push(item.release.voiceType);
        if (item.release.audioTracks > 1) bits.push(item.release.audioTracks + ' ауд. дор.');
        else if (item.release.audioChannels) bits.push(item.release.audioChannels);
        if (item.release.subtitles) bits.push('субтитры');
        if (item.release.compatibility === 'risky') {
            bits.push('GST-риск: ' + (item.release.compatibilityReason || item.release.videoCodec || item.release.container || 'формат'));
        }
        return bits.join(' · ');
    }

    export function candidateIdentity(item) {
        return releaseIdentity(item);
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
        var leechers = item.leechers !== undefined ? item.leechers : item.peers;
        bits.push(item.seeders + ' сид. · ' + leechers + ' лич.');
        var size = formatSize(item.size);
        if (size) bits.push(size);
        var published = publishedText(item);
        if (published) bits.push(published);
        return bits.join(' · ');
    }
