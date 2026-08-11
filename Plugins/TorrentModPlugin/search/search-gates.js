    import { baseTitles, normalizedTitleKey } from './query-building.js';

    var MIN_TITLE_SIMILARITY = 0.34;
    var STOPWORDS = {};
    ['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'is', 'it'].forEach(function (word) { STOPWORDS[word] = true; });
    ['и', 'в', 'на', 'о', 'из', 'для', 'по', 'с', 'а', 'к', 'у'].forEach(function (word) { STOPWORDS[word] = true; });

    function decodeEntities(value) {
        return String(value || '')
            .replace(/&#0*39;|&apos;/gi, "'")
            .replace(/&quot;/gi, '"')
            .replace(/&amp;/gi, '&');
    }

    function cleanTitleSegment(value) {
        var segment = decodeEntities(value).trim();
        segment = segment.replace(/^(?:S\d{1,2}E\d{1,3}(?:[-–]E?\d{1,3})?|E\d{1,3}(?:[-–]E?\d{1,3})?)\s*[-:|]?\s*/i, '').trim();
        var bracketIndex = segment.search(/[([]/);
        if (bracketIndex >= 0) segment = segment.slice(0, bracketIndex);
        var technicalIndex = segment.search(/\b(?:S\d{1,2}E\d{1,3}|S\d{1,2}|E\d{1,3}|\d{3,4}p|4K|UHD|WEB-?DL(?:Rip)?|WEBRip|BDRip|Blu-?Ray|Remux|HDTV|HDRip|DVDRip|H\.?26[45]|HEVC|AVC)\b/i);
        if (technicalIndex > 0) segment = segment.slice(0, technicalIndex);
        return segment.replace(/[,:;\s-]+$/g, '').trim();
    }

    export function extractSearchTitleSegments(rawTitle) {
        return decodeEntities(rawTitle).split(/[\/|]/).map(cleanTitleSegment).filter(Boolean);
    }

    function significantTokens(value) {
        return normalizedTitleKey(value).split(' ').filter(function (token) {
            return token.length > 2 && !STOPWORDS[token];
        });
    }

    function segmentSimilarity(segment, name) {
        var compactName = normalizedTitleKey(name);
        var compactSegment = normalizedTitleKey(segment);
        if (!compactName || !compactSegment) return 0;
        if (compactSegment === compactName) return 1;
        if (!/\s/.test(compactName) && !/\s/.test(compactSegment)) {
            return compactName.indexOf(compactSegment) >= 0 || compactSegment.indexOf(compactName) >= 0 ? 1 : 0;
        }

        var nameTokens = compactName.split(' ');
        var segmentTokens = compactSegment.split(' ');
        var wanted = significantTokens(name);
        if (!wanted.length) return 0;
        var hits = wanted.filter(function (token) { return segmentTokens.indexOf(token) >= 0; }).length;
        if (wanted.length > 1 && hits === wanted.length) return 1;
        if (segmentTokens.length !== nameTokens.length) return 0;
        var allHits = nameTokens.filter(function (token) { return segmentTokens.indexOf(token) >= 0; }).length;
        if (wanted.length > 1 && hits < 2) return 0;
        if (wanted.length === 1 && nameTokens.length > 1 && allHits / nameTokens.length < 0.75) return 0;
        return hits / wanted.length;
    }

    function titleAnalysis(title, movie, englishTitle) {
        var segments = extractSearchTitleSegments(title);
        var names = baseTitles(movie || {}, englishTitle);
        var scores = segments.map(function (segment) {
            var best = 0;
            names.forEach(function (name) { best = Math.max(best, segmentSimilarity(segment, name)); });
            return best;
        });
        return {
            segments: segments,
            scores: scores,
            similarity: scores.reduce(function (best, score) { return Math.max(best, score); }, 0)
        };
    }

    export function titleSimilarity(title, movie, englishTitle) {
        return titleAnalysis(title, movie, englishTitle).similarity;
    }

    function looksLikeConflictingTitle(segment, names) {
        if (/(?:lostfilm|alexfilm|newstudio|release|tracker|rip|group|team|studio)/i.test(segment)) return false;
        var segmentTokens = significantTokens(segment);
        if (segmentTokens.some(function (token) {
            return names.some(function (name) { return significantTokens(name).indexOf(token) >= 0; });
        })) return false;
        return segmentTokens.length >= 2;
    }

    export function evaluateSearchTitleGate(item, target) {
        var analysis = titleAnalysis(item && item.title, target && target.movie, target && target.englishTitle);
        if (analysis.similarity < MIN_TITLE_SIMILARITY) {
            return { passes: false, reason: 'title-mismatch', details: { segments: analysis.segments, similarity: analysis.similarity } };
        }

        var firstMatch = -1;
        for (var matchIndex = 0; matchIndex < analysis.scores.length; matchIndex++) {
            if (analysis.scores[matchIndex] >= MIN_TITLE_SIMILARITY) { firstMatch = matchIndex; break; }
        }
        for (var i = 0; i < firstMatch; i++) {
            if (analysis.scores[i] < MIN_TITLE_SIMILARITY && looksLikeConflictingTitle(analysis.segments[i], baseTitles((target && target.movie) || {}, target && target.englishTitle))) {
                return {
                    passes: false,
                    reason: 'conflicting-title',
                    details: { segment: analysis.segments[i], matchedSegment: analysis.segments[firstMatch] }
                };
            }
        }
        return { passes: true, reason: '', details: { similarity: analysis.similarity } };
    }

    function videoEvidence(release) {
        var values = [];
        if (release.explicitSeason) values.push('season');
        if (release.explicitEpisode) values.push('episode');
        if (release.resolution) values.push('resolution:' + release.resolution);
        if (release.sourceType) values.push('source:' + release.sourceType);
        if (release.videoCodec) values.push('codec:' + release.videoCodec);
        if (release.container) values.push('container:' + release.container);
        return values;
    }

    function targetContains(target, pattern) {
        return baseTitles((target && target.movie) || {}, target && target.englishTitle).some(function (title) {
            return pattern.test(title);
        });
    }

    export function evaluateMediaTypeGate(item, target) {
        var title = decodeEntities(item && item.title);
        var release = (item && item.release) || {};
        var evidence = videoEvidence(release);
        var visualEvidence = Boolean(release.resolution || release.sourceType || release.videoCodec || release.container);

        if (/\b(?:pdf|fb2|epub|djvu|mobi|azw3?|docx?|rtf)\b/i.test(title)) {
            return { passes: false, reason: 'ebook-or-document', details: { evidence: evidence } };
        }
        if (/\brepack\b|\bsteam-?rip\b|\b(?:pc|xbox|ps[345]|switch)\b[^\n]{0,80}\b(?:dlc|gog|steam|лиценз)/i.test(title)) {
            return { passes: false, reason: 'game-distribution', details: { evidence: evidence } };
        }

        var audioMarker = /\b(?:mp3|flac|ape|wav|m4b|lossless|soundtrack|ost|hörbuch)\b|аудиокниг|аудиоверси|саундтрек|(?:^|[\s[(])score(?:[\s\/,):]|$)/i;
        if (audioMarker.test(title) && !visualEvidence) {
            return { passes: false, reason: 'audio-only', details: { evidence: evidence } };
        }

        var extrasMarker = /дополнительн(?:ые|ый) материал|special features?|bonus materials?|making[ ._-]*of|behind[ ._-]*the[ ._-]*scenes/i;
        if (extrasMarker.test(title) && !targetContains(target, extrasMarker)) {
            return { passes: false, reason: 'extras-or-bonus', details: { evidence: evidence } };
        }

        if (target && target.mode === 'series' && evidence.length === 0) {
            return { passes: false, reason: 'missing-video-signal', details: { evidence: evidence } };
        }
        return { passes: true, reason: '', details: { evidence: evidence } };
    }

    export function passesSearchTitleGate(item, target) {
        return evaluateSearchTitleGate(item, target).passes;
    }
