    import { baseTitles, normalizedTitleKey } from '../plan/query-building.js';
    import { profileFor } from '../rules/tracker-profiles.js';

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
        // «Season 4» и «4 сезон» — технический хвост, а не часть названия: без этого раздача
        // «The Boys Season 4» не совпадала с целью «The Boys» вообще.
        var technicalIndex = segment.search(/\b(?:S\d{1,2}E\d{1,3}|S\d{1,2}|E\d{1,3}|\d{3,4}p|4K|UHD|WEB-?DL(?:Rip)?|WEBRip|BDRip|Blu-?Ray|Remux|HDTV|HDRip|DVDRip|H\.?26[45]|HEVC|AVC|Seasons?\s*\d)\b/i);
        if (technicalIndex < 0) technicalIndex = segment.search(/\d{1,2}\s*(?:сезон|season)|(?:сезон|серии|серия)\s*[:№]/i);
        if (technicalIndex > 0) segment = segment.slice(0, technicalIndex);
        return segment.replace(/[,:;\s-]+$/g, '').trim();
    }

    // Вертикальная черта у одного и того же трекера разделяет то названия, то поля метаданных
    // («Ru | En | 2026 | WebRip» против «… | D | Red Head Sound»). Поэтому делим по обоим
    // разделителям, а поля выбрасываем по их собственному виду, а не по имени трекера.
    var METADATA_FIELD = [
        /^[DPLAO]\d?(?:\s*,\s*[DPLAO]\d?)*$/i,
        /^(?:dub|mvo|avo|dvo|vo|sub|subs|rus|eng|ukr|jap|orig(?:inal)?)(?:\s*,\s*(?:dub|mvo|avo|dvo|vo|sub|subs|rus|eng|ukr|jap|orig(?:inal)?))*$/i,
        /^(?:4k|uhd|sdr|hdr\d*\+?|dolby\s*vision.*|\d{1,2}-?bit|\d{3,4}[pi])$/i,
        /^(?:19|20)\d{2}(?:\s*[-–]\s*(?:19|20)\d{2})?$/,
        /^(?:web-?dl(?:-?rip)?|webrip|bdrip|bdremux|remux|blu-?ray|hdtv|hdrip|dvdrip|camrip)(?:[\s-].*)?$/i
    ];

    function looksLikeMetadataField(segment) {
        var text = String(segment || '').trim();
        if (!text) return true;
        return METADATA_FIELD.some(function (pattern) { return pattern.test(text); });
    }

    export function extractSearchTitleSegments(rawTitle, profile) {
        var text = decodeEntities(rawTitle);
        ((profile && profile.strip) || []).forEach(function (pattern) { text = text.replace(pattern, ' '); });
        var separators = (profile && profile.titleSeparators === 'slash') ? /\// : /[\/|]/;
        return text.split(separators)
            .map(cleanTitleSegment)
            .filter(function (segment) { return segment && !looksLikeMetadataField(segment); });
    }

    function profileOf(item) {
        return profileFor(item && item.trackerId, item && item.tracker);
    }

    function significantTokens(value) {
        return normalizedTitleKey(value).split(' ').filter(function (token) {
            return token.length > 2 && !STOPWORDS[token];
        });
    }

    var CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/;
    var CJK_MIN_CHARS = 3;

    // Название, у которого совпали все значимые слова, но добавлены свои: «Игра в кальмара: Вызов»
    // при цели «Игра в кальмара». Из заголовка нельзя понять, это то же произведение под более
    // полным именем или соседнее — поэтому не отказ, а ослабленное совпадение; решает пул (§1.3).
    var EXTENDED_TITLE_SCORE = 0.6;

    function segmentMatch(segment, name) {
        var compactName = normalizedTitleKey(name);
        var compactSegment = normalizedTitleKey(segment);
        if (!compactName || !compactSegment) return { score: 0, extended: false };
        if (compactSegment === compactName) return { score: 1, extended: false };

        if (!/\s/.test(compactName) && !/\s/.test(compactSegment)) {
            // Подстрока допустима только для письменностей без пробелов: там иначе не совпадёт
            // ничего. Для остальных она превращала «Оно» в «Кукушонок», «Звонок» и «Метроном».
            var bothCjk = CJK.test(compactName) && CJK.test(compactSegment);
            if (!bothCjk) return { score: 0, extended: false };
            var shorter = Math.min(compactName.length, compactSegment.length);
            if (shorter < CJK_MIN_CHARS) return { score: 0, extended: false };
            var contained = compactName.indexOf(compactSegment) >= 0 || compactSegment.indexOf(compactName) >= 0;
            return contained ? { score: 1, extended: compactName.length !== compactSegment.length } : { score: 0, extended: false };
        }

        var nameTokens = compactName.split(' ');
        var segmentTokens = compactSegment.split(' ');
        var wanted = significantTokens(name);
        if (!wanted.length) return { score: 0, extended: false };
        var hits = wanted.filter(function (token) { return segmentTokens.indexOf(token) >= 0; }).length;

        if (hits === wanted.length) {
            var extra = segmentTokens.filter(function (token) {
                return token.length > 2 && !STOPWORDS[token] && nameTokens.indexOf(token) < 0;
            });
            if (!extra.length) return { score: 1, extended: false };
            // Расширение — это название целиком, а за ним добавка: «Игра в кальмара: Вызов».
            // Если слова цели просто рассыпаны по сегменту, это чужой заголовок, а не расширение:
            // «The Beach Boys - The Pet Sounds Sessions» не является расширением «The Boys».
            var isPrefix = nameTokens.every(function (token, index) { return segmentTokens[index] === token; });
            return isPrefix ? { score: EXTENDED_TITLE_SCORE, extended: true } : { score: 0, extended: false };
        }

        if (segmentTokens.length !== nameTokens.length) return { score: 0, extended: false };
        var allHits = nameTokens.filter(function (token) { return segmentTokens.indexOf(token) >= 0; }).length;
        if (wanted.length > 1 && hits < 2) return { score: 0, extended: false };
        if (wanted.length === 1 && nameTokens.length > 1 && allHits / nameTokens.length < 0.75) return { score: 0, extended: false };
        return { score: hits / wanted.length, extended: false };
    }

    function segmentSimilarity(segment, name) {
        return segmentMatch(segment, name).score;
    }

    function titleAnalysis(title, movie, englishTitle, aliases, profile) {
        var segments = extractSearchTitleSegments(title, profile);
        var names = baseTitles(movie || {}, englishTitle, aliases);
        var matches = segments.map(function (segment) {
            var best = { score: 0, extended: false };
            names.forEach(function (name) {
                var match = segmentMatch(segment, name);
                // При равном счёте точное совпадение вытесняет расширенное.
                if (match.score > best.score || (match.score === best.score && best.extended && !match.extended)) best = match;
            });
            return best;
        });
        var winner = matches.reduce(function (best, match) {
            if (match.score > best.score || (match.score === best.score && best.extended && !match.extended)) return match;
            return best;
        }, { score: 0, extended: false });
        return {
            segments: segments,
            matches: matches,
            scores: matches.map(function (match) { return match.score; }),
            similarity: winner.score,
            extended: winner.score > 0 && winner.extended
        };
    }

    // Совпало ли название точно, или только с добавленными словами. Пул использует это, чтобы
    // не показывать спин-офф, когда само произведение найдено.
    export function evaluateTitleMatch(item, target) {
        return titleAnalysis(item && item.title, target && target.movie, target && target.englishTitle, target && target.aliases, profileOf(item));
    }

    export function titleSimilarity(title, movie, englishTitle, aliases) {
        return titleAnalysis(title, movie, englishTitle, aliases).similarity;
    }

    function scriptOf(value) {
        var text = String(value || '');
        if (CJK.test(text)) return 'cjk';
        if (/[а-яё]/i.test(text)) return 'cyr';
        if (/[a-z]/i.test(text)) return 'lat';
        return '';
    }

    function looksLikeConflictingTitle(segment, names, matchedSegment, exactMatch, localTitle) {
        if (/(?:lostfilm|alexfilm|newstudio|release|tracker|rip|group|team|studio)/i.test(segment)) return false;
        // Заголовок вида «Ромадзи | English | Локализованное» — это одно произведение под
        // разными названиями, а не два разных. Настоящий конфликт («Настоящая война / Игра
        // престолов» — документальный фильм о сериале) отличается тем, что чужой заголовок
        // написан на том же языке, что и локализованное название цели, и на том же, что
        // совпавший сегмент. Достаточно разойтись с любым из двух, чтобы это была раскладка
        // названий, а не подмена произведения.
        var segmentScript = scriptOf(segment);
        if (exactMatch && segmentScript) {
            if (segmentScript !== scriptOf(matchedSegment)) return false;
            if (localTitle && segmentScript !== scriptOf(localTitle)) return false;
        }
        var segmentTokens = significantTokens(segment);
        if (segmentTokens.some(function (token) {
            return names.some(function (name) { return significantTokens(name).indexOf(token) >= 0; });
        })) return false;
        return segmentTokens.length >= 2;
    }

    // Названия соседних работ франшизы из TMDB-коллекции. Совпадение с ними сильнее, чем с
    // целью, означает, что раздача про соседнюю работу: «Дюна: Пророчество» при цели «Дюна».
    function matchesSiblingWork(segments, target) {
        var negatives = (target && target.negativeAliases) || [];
        if (!negatives.length) return null;
        var ownKeys = {};
        baseTitles((target && target.movie) || {}, target && target.englishTitle, target && target.aliases)
            .forEach(function (name) { ownKeys[normalizedTitleKey(name)] = true; });
        for (var i = 0; i < segments.length; i++) {
            for (var j = 0; j < negatives.length; j++) {
                if (ownKeys[normalizedTitleKey(negatives[j])]) continue;
                if (segmentMatch(segments[i], negatives[j]).score === 1) return negatives[j];
            }
        }
        return null;
    }

    export function evaluateSearchTitleGate(item, target) {
        var analysis = titleAnalysis(item && item.title, target && target.movie, target && target.englishTitle, target && target.aliases, profileOf(item));
        if (analysis.similarity < MIN_TITLE_SIMILARITY) {
            return { passes: false, reason: 'title-mismatch', details: { segments: analysis.segments, similarity: analysis.similarity } };
        }

        var firstMatch = -1;
        for (var matchIndex = 0; matchIndex < analysis.scores.length; matchIndex++) {
            if (analysis.scores[matchIndex] >= MIN_TITLE_SIMILARITY) { firstMatch = matchIndex; break; }
        }
        for (var i = 0; i < firstMatch; i++) {
            if (analysis.scores[i] < MIN_TITLE_SIMILARITY && looksLikeConflictingTitle(analysis.segments[i], baseTitles((target && target.movie) || {}, target && target.englishTitle, target && target.aliases), analysis.segments[firstMatch], analysis.matches[firstMatch].score === 1 && !analysis.matches[firstMatch].extended, ((target && target.movie) || {}).name || ((target && target.movie) || {}).title || '')) {
                return {
                    passes: false,
                    reason: 'conflicting-title',
                    details: { segment: analysis.segments[i], matchedSegment: analysis.segments[firstMatch] }
                };
            }
        }
        var sibling = matchesSiblingWork(analysis.segments, target);
        if (sibling && analysis.extended) {
            return { passes: false, reason: 'other-work-in-franchise', details: { sibling: sibling } };
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
        return baseTitles((target && target.movie) || {}, target && target.englishTitle, target && target.aliases).some(function (title) {
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
