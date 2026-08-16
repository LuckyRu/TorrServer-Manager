// Гейт идентичности: та ли это вещь, а не насколько она хороша. Отвечает на вопросы «тот ли
// сезон», «та ли серия», «не сезонный ли это пак под фильм», «тот ли год».
//
// Год и расширенное название проверяются относительно пула, а не абсолютно: кандидат
// отбрасывается, только если в пуле есть точное совпадение, которым его можно заменить.
// Абсолютный гейт по году уничтожил бы аниме-трекеры (года нет в принципе), многолетние паки
// и все сезоны сериала кроме первого — см. §5 архитектурного документа.

import { yearMatches } from '../parse/release-year.js';
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

// Аниме нумеруют серии сквозным счётом: у релиза «E892» никакого сезона в заголовке нет, а
// TMDB держит ту же серию как сезон N, серия M. Сумма серий предыдущих сезонов даёт сквозной
// номер — но она врёт на спецвыпусках и рекапах, поэтому такой номер может только **принять**
// кандидата и никогда не служит основанием для отказа: сезон у релиза не назван, и ошибиться
// в сторону лишнего кандидата дешевле, чем потерять единственный верный.
function absoluteEpisode(target) {
    var seasons = (target.movie && Array.isArray(target.movie.seasons)) ? target.movie.seasons : [];
    if (!seasons.length || !target.season || target.season <= 1) return 0;
    var offset = 0;
    for (var i = 0; i < seasons.length; i++) {
        var number = parseInt(seasons[i].season_number, 10);
        var count = parseInt(seasons[i].episode_count, 10) || 0;
        if (number > 0 && number < target.season) offset += count;
    }
    return offset > 0 ? offset + target.episode : 0;
}

function episodeNumbers(target, release) {
    var numbers = [target.episode];
    if (release.explicitSeason) return numbers;
    var absolute = absoluteEpisode(target);
    if (absolute && numbers.indexOf(absolute) < 0) numbers.push(absolute);
    return numbers;
}

function lastSeasonNumber(target) {
    var seasons = (target.movie && Array.isArray(target.movie.seasons)) ? target.movie.seasons : [];
    var last = 0;
    seasons.forEach(function (season) {
        var number = parseInt(season.season_number, 10);
        if (number > last) last = number;
    });
    return last;
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

    if (release.explicitSeason && release.seasons.indexOf(target.season) < 0) {
        return { passes: false, reason: 'season-mismatch', details: { seasons: release.seasons, wanted: target.season } };
    }
    // «Финальный сезон» без номера: какой он по счёту, знает только TMDB. Если последний сезон
    // известен и это не он — раздача не о нём. Если неизвестен, отказывать не за что.
    if (!release.explicitSeason && release.finalSeason) {
        var last = lastSeasonNumber(target);
        if (last && target.season && target.season !== last) {
            return { passes: false, reason: 'season-mismatch', details: { finalSeason: last, wanted: target.season } };
        }
    }
    // Полнометражка аниме — не серия. Отказ только когда спрашивают конкретную серию: в общем
    // пуле произведения фильму по франшизе место есть, а кандидатом на третий эпизод он быть
    // не может, сколько бы у него ни было сидов.
    if (target.episode && release.releaseType === 'movie' && !release.explicitEpisode) {
        return { passes: false, reason: 'movie-release-for-episode', details: { releaseType: release.releaseType } };
    }
    if (target.episode && release.explicitEpisode) {
        var wanted = episodeNumbers(target, release);
        var covered = wanted.some(function (number) {
            return number >= release.episodeFrom && number <= release.episodeTo;
        });
        if (!covered) {
            return {
                passes: false,
                reason: 'episode-out-of-range',
                details: { from: release.episodeFrom, to: release.episodeTo, wanted: wanted }
            };
        }
    }
    return { passes: true, reason: '', details: {} };
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

    // Расширенное название («Игра в кальмара: Вызов») уступает точному, когда точное найдено.
    apply('title-extension',
        function (item) { return item._titleExtended === false; },
        function (item) { return item._titleExtended === true; });

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
