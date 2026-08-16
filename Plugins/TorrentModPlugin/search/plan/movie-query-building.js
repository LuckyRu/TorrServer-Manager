import { buildAnimeQueries, queryNames } from './query-building.js';
import { isAnimeTarget } from '../profile/work-profile.js';

export function buildMovieQueries(target) {
    // Аниме-фильм раньше не получал ни alias-запросов, ни маршрута в аниме-трекеры, а при
    // отсутствии английского названия список запросов выходил пустым — и пользователю
    // показывалось «Jackett не ответил», хотя Jackett не спрашивали.
    if (isAnimeTarget(target)) return buildAnimeQueries(Object.assign({}, target, { season: 0, episode: 0 }));

    // queryNames подставляет локальное название, когда parse_lang дал непоисковое письмо, и
    // ключует по normalizedTitleKey — compact вырезал CJK целиком и оставлял пустой список.
    return queryNames(target).slice(0, 1);
}
