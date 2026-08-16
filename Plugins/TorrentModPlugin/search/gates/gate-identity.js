// Гейт идентичности: та ли это вещь, а не насколько она хороша. Отвечает на вопросы «тот ли
// сезон», «та ли серия», «не сезонный ли это пак под фильм», «тот ли год».
//
// Год и расширенное название проверяются относительно пула, а не абсолютно: кандидат
// отбрасывается, только если в пуле есть точное совпадение, которым его можно заменить.
// Абсолютный гейт по году уничтожил бы аниме-трекеры (года нет в принципе), многолетние паки
// и все сезоны сериала кроме первого — см. §5 архитектурного документа.

import { yearMatches } from '../parse/release-year.js';
import { coverageDecision } from '../profile/release-selection.js';
import { MODE_MOVIE } from '../../shared/state.js';

function yearOf(value) {
    var year = parseInt(String(value || '').slice(0, 4), 10);
    return year > 1800 ? year : 0;
}

export function targetYear(target) {
    var movie = (target && target.movie) || {};
    if (!target || target.mode === MODE_MOVIE) return yearOf(movie.release_date || movie.first_air_date);

    var seasons = Array.isArray(movie.seasons) ? movie.seasons : [];
    for (var i = 0; i < seasons.length; i++) {
        if (parseInt(seasons[i].season_number, 10) === target.season) {
            var seasonYear = yearOf(seasons[i].air_date);
            if (seasonYear) return seasonYear;
        }
    }
    return yearOf(movie.first_air_date || movie.release_date);
}

// Сезонный пак, попавший в поиск фильма. Одного «S1» мало — эта запись слишком легко возникает
// из шума вроде «BDRip S1 5.1»; нужен второй сигнал: диапазон серий или слово «сезон».
function looksLikeSeriesPack(item) {
    var release = item.release || {};
    if (!release.explicitSeason) return false;
    return release.explicitEpisode || /сезон|season/i.test(String(item.title || ''));
}

export function evaluateIdentityGate(item, target) {
    var release = (item && item.release) || {};
    target = target || {};

    if (target.mode === MODE_MOVIE) {
        if (looksLikeSeriesPack(item)) {
            return { passes: false, reason: 'series-pack-for-movie', details: { seasons: release.seasons } };
        }
        return { passes: true, reason: '', details: {} };
    }

    var coverage = coverageDecision(item, target);
    if (coverage.match === 'none') {
        return {
            passes: false,
            reason: coverage.reason,
            details: {
                coverageMatch: coverage.match,
                coverageClaim: coverage.claim,
                coverage: coverage.metadata.coverage,
                wanted: { season: target.season, episode: target.episode },
                releaseType: release.releaseType || ''
            }
        };
    }
    return {
        passes: true,
        reason: '',
        details: {
            coverageMatch: coverage.match,
            coverageClaim: coverage.claim,
            absoluteEpisode: coverage.absoluteEpisode || 0,
            coverageReason: coverage.reason || ''
        }
    };
}

// Относительные правила: применяются к уже прошедшему гейт пулу и только при наличии замены.
// Каждое возвращает список отклонённых, поэтому пул физически не может опустеть.
export function narrowToExactMatches(scored, target) {
    var wantedYear = targetYear(target);
    var rejected = [];

    function apply(name, isExact, isWrong) {
        var exact = scored.filter(isExact);
        if (!exact.length) return;
        var kept = [];
        scored.forEach(function (item) {
            if (isWrong(item)) rejected.push({ item: item, reason: name });
            else kept.push(item);
        });
        scored = kept;
    }

    // Расширенное название («Игра в кальмара: Вызов») уступает точному только в той же группе
    // трекеров и для того же известного варианта названия. Иначе короткий alias аниме делал
    // полноценное ромадзи «расширением» и исчезал из-за точного русского названия с Tapochek.
    var hasStructuredTitle = scored.some(function (item) {
        return item._titleEvidence && item._titleEvidence.matchedTitleKey;
    });
    if (hasStructuredTitle) {
        var exactTitleGroups = {};
        scored.forEach(function (item) {
            var evidence = item._titleEvidence || {};
            if (evidence.kind !== 'extension' && evidence.matchedTitleKey) {
                exactTitleGroups[(evidence.trackerGroup || 'general') + '|' + evidence.matchedTitleKey] = true;
            }
        });
        var titleKept = [];
        scored.forEach(function (item) {
            var evidence = item._titleEvidence || {};
            var key = (evidence.trackerGroup || 'general') + '|' + (evidence.matchedTitleKey || '');
            if (evidence.kind === 'extension' && exactTitleGroups[key]) {
                rejected.push({ item: item, reason: 'title-extension' });
            } else titleKept.push(item);
        });
        scored = titleKept;
    } else {
        // Совместимость для внешних потребителей, которые ещё передают старый boolean.
        apply('title-extension',
            function (item) { return item._titleExtended === false; },
            function (item) { return item._titleExtended === true; });
    }

    // Неоднозначный E01-E12 без сезона остаётся fallback-ом, пока это единственный вариант.
    // Явный Sxx или подтверждённая сквозная нумерация вытесняют его для конкретной серии.
    apply('seasonless-coverage-shadowed',
        function (item) { return item._coverageMatch === 'exact'; },
        function (item) { return item._coverageMatch === 'ambiguous'; });

    // Год отбрасывает одноимённое, только если год цели известен и в пуле есть попадание в него.
    if (wantedYear) {
        apply('year-mismatch',
            function (item) { return yearMatches(item.release && item.release.year, wantedYear) === true; },
            function (item) {
                var year = item.release && item.release.year;
                if (!year || year.confidence !== 'high') return false;
                return yearMatches(year, wantedYear) === false;
            });
    }

    return { items: scored, rejected: rejected };
}
