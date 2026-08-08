// ---------- series file selection ----------
import { filePath, extensionScore } from './file-selection-common.js';

export function scoreSeriesFile(file, target, parseSignals) {
    var path = filePath(file);
    var signals = parseSignals ? parseSignals(path) : null;
    if (!signals) return extensionScore(path);

    var score = 0;
    if (target && target.episode) {
        if (signals.explicitEpisode && target.episode >= signals.episodeFrom && target.episode <= signals.episodeTo) score += 100;
        else if (signals.explicitEpisode) score -= 100;
    }
    if (signals.explicitSeason) score += signals.seasons.indexOf(target && target.season) >= 0 ? 30 : -100;
    return score + extensionScore(path);
}

export function pickSeriesFile(files, target, parseSignals) {
    var scored = (files || []).map(function (file) {
        return { file: file, score: scoreSeriesFile(file, target, parseSignals) };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.length ? scored[0].file : null;
}
