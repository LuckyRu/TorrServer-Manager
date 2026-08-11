// ---------- series file selection ----------
import { filePath, extensionScore } from './file-selection-common.js';

function directorySeason(path) {
    var parts = String(path || '').replace(/\\/g, '/').split('/');
    parts.pop();
    for (var index = parts.length - 1; index >= 0; index--) {
        var segment = parts[index].replace(/[._]/g, ' ').trim();
        var match = segment.match(/(?:^|[\s-])(?:seasons?|сезон(?:ы|а)?)\s*[\s-]*0*(\d{1,2})(?=$|[\s-])/i) ||
            segment.match(/(?:^|[\s-])0*(\d{1,2})\s*(?:seasons?|сезон(?:ы|а)?)(?=$|[\s-])/i) ||
            segment.match(/^S\s*0*(\d{1,2})(?=$|[\s-])/i);
        if (!match) continue;
        var season = parseInt(match[1], 10);
        if (season > 0 && season <= 99) return season;
    }
    return 0;
}

function leadingEpisode(path) {
    var fileName = String(path || '').replace(/\\/g, '/').split('/').pop() || '';
    var stem = fileName.replace(/\.[^.]+$/, '');
    var match = stem.match(/^\s*[\[(]\s*0*(\d{1,3})\s*[\])](?=$|[\s._-])/) ||
        stem.match(/^\s*0*(\d{1,3})(?=$|[\s._-])/);
    if (!match) return 0;
    var episode = parseInt(match[1], 10);
    return episode > 0 && episode <= 999 ? episode : 0;
}

export function parseSeriesFileLayout(file) {
    var path = filePath(file);
    var season = directorySeason(path);
    return {
        season: season,
        episode: season ? leadingEpisode(path) : 0
    };
}

export function scoreSeriesFile(file, target, parseSignals) {
    var path = filePath(file);
    var layout = parseSeriesFileLayout(file);
    var signals = parseSignals ? parseSignals(path) : null;
    var score = 0;

    if (layout.episode && target && target.episode) {
        score += layout.episode === target.episode ? 400 : -200;
    } else if (signals && target && target.episode) {
        if (signals.explicitEpisode && target.episode >= signals.episodeFrom && target.episode <= signals.episodeTo) score += 100;
        else if (signals.explicitEpisode) score -= 100;
    }

    if (layout.season && target && target.season) {
        score += layout.season === target.season ? 200 : -500;
    } else if (signals && signals.explicitSeason) {
        score += signals.seasons.indexOf(target && target.season) >= 0 ? 30 : -100;
    }

    return score + extensionScore(path);
}

export function pickSeriesFile(files, target, parseSignals) {
    var scored = (files || []).map(function (file) {
        return { file: file, score: scoreSeriesFile(file, target, parseSignals) };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.length ? scored[0].file : null;
}
