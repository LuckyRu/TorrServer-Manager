import { compact } from './utils.js';

function normalizedSize(item) {
    var value = Number(item && item.size);
    return isFinite(value) && value > 0 ? String(value) : '';
}

export function releaseIdentity(item) {
    var title = compact(item && item.title);
    var tracker = compact(item && item.tracker);
    var size = normalizedSize(item);
    if (title && size) return 'release|' + title + '|' + tracker + '|' + size;
    return 'source|' + compact(item && (item.magnet || item.link || (title + '|' + size)));
}

function hasMagnet(item) {
    return !!String(item && item.magnet || '').trim();
}

function numberValue(value) {
    var number = Number(value);
    return isFinite(number) ? number : 0;
}

export function preferRelease(existing, candidate) {
    if (!existing) return candidate;
    if (!candidate) return existing;
    if (hasMagnet(candidate) !== hasMagnet(existing)) return hasMagnet(candidate) ? candidate : existing;
    if (numberValue(candidate.seeders) !== numberValue(existing.seeders)) {
        return numberValue(candidate.seeders) > numberValue(existing.seeders) ? candidate : existing;
    }
    if (numberValue(candidate.peers) !== numberValue(existing.peers)) {
        return numberValue(candidate.peers) > numberValue(existing.peers) ? candidate : existing;
    }
    if (numberValue(candidate.publishedAt) !== numberValue(existing.publishedAt)) {
        return numberValue(candidate.publishedAt) > numberValue(existing.publishedAt) ? candidate : existing;
    }
    return existing;
}

export function mergeReleases(existing, incoming) {
    var positions = {};
    var merged = [];
    (existing || []).concat(incoming || []).forEach(function (item) {
        var id = releaseIdentity(item);
        if (!id) return;
        if (positions[id] === undefined) {
            positions[id] = merged.length;
            merged.push(item);
            return;
        }
        var position = positions[id];
        merged[position] = preferRelease(merged[position], item);
    });
    return merged;
}
