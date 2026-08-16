// Семейство произведения — единственное место, где решается «это аниме / дунхуа / дорама /
// западная анимация / всё остальное». Раньше решение было одной строкой «анимация И Азия», из-за
// чего дорамы, китайское игровое кино и аниме-фильмы шли общим путём и не находились вовсе
// (замеры — §1.5 docs/system-design/torrent-mod-search-architecture.md).

import { MODE_MOVIE } from '../../shared/state.js';

export var FAMILY_ANIME = 'anime';
export var FAMILY_DONGHUA = 'donghua';
export var FAMILY_ASIAN_LIVE = 'asian-live';
export var FAMILY_WESTERN_ANIMATION = 'western-animation';
export var FAMILY_GENERAL = 'general';

var JAPANESE = { ja: true, JP: true };
var CHINESE = { zh: true, CN: true, TW: true, HK: true };
var ASIAN = { ja: true, zh: true, ko: true, th: true, JP: true, CN: true, TW: true, HK: true, KR: true, TH: true };

function regionTokens(movie) {
    var tokens = [];
    var language = String(movie.original_language || '').toLowerCase();
    if (language) tokens.push(language);
    (Array.isArray(movie.origin_country) ? movie.origin_country : []).forEach(function (country) {
        tokens.push(String(country || '').toUpperCase());
    });
    return tokens;
}

function isAnimation(movie) {
    var ids = (Array.isArray(movie.genre_ids) ? movie.genre_ids : []).map(String);
    if (ids.indexOf('16') >= 0) return true;
    return (Array.isArray(movie.genres) ? movie.genres : []).some(function (genre) {
        var name = String((genre && (genre.name || genre)) || '').toLowerCase();
        return /animation|анимац|мультфильм|мультсериал|动画|アニメ|애니/.test(name);
    });
}

function anyToken(tokens, table) {
    return tokens.some(function (token) { return table[token] === true; });
}

export function workFamily(target) {
    var movie = (target && target.movie) || {};
    var tokens = regionTokens(movie);
    var animation = isAnimation(movie);
    var asian = anyToken(tokens, ASIAN);

    if (animation && !asian) return FAMILY_WESTERN_ANIMATION;
    if (animation && anyToken(tokens, CHINESE) && !anyToken(tokens, JAPANESE)) return FAMILY_DONGHUA;
    if (animation) return FAMILY_ANIME;
    if (asian) return FAMILY_ASIAN_LIVE;
    return FAMILY_GENERAL;
}

// Аниме и дунхуа публикуются на профильных трекерах — туда идут адресные alias-запросы.
// Дорамы там не лежат: их держат общие трекеры, поэтому маршрут для них обычный.
export function usesAnimeIndexers(family) {
    return family === FAMILY_ANIME || family === FAMILY_DONGHUA;
}

// Русскоязычные трекеры индексируют локализованное название. Запрос корейским или китайским
// письмом не находит на них ничего — он обязан начинаться с локального названия.
export function prefersLocalTitle(family) {
    return family === FAMILY_ASIAN_LIVE;
}

// Исторический вход: аниме-профиль запросов. Теперь он охватывает и фильмы — раньше первая
// строка отсекала всё, кроме сериалов, и аниме-фильм не получал ни alias-запросов, ни маршрута.
export function isAnimeTarget(target) {
    return usesAnimeIndexers(workFamily(target));
}

export function isAnimeMovie(target) {
    return target && target.mode === MODE_MOVIE && isAnimeTarget(target);
}
