// ---------- series release parsing ----------
//
// Series keeps the complete season/episode signal set because it is used by the gate and by the
// episode-aware candidate scorer.
import { parseRelease } from './release-parsing.js';

export function parseSeriesRelease(title) {
    return parseRelease(title);
}
