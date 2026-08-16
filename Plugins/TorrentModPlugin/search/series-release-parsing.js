import { parseRelease } from './release-parsing.js';

export function parseSeriesRelease(title, profile) {
    return parseRelease(title, profile);
}
