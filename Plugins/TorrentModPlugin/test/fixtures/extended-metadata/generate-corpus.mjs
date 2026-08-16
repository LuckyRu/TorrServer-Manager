import fs from 'node:fs';
import path from 'node:path';
import {
    TRACKERS, FAMILIES, catalogs, trackerCatalog, familyTracker, semanticFor,
    renderTitle, expectedRelease, targetFor
} from './corpus-definition.mjs';

const root = import.meta.dirname;
const casesRoot = path.resolve(root, 'cases');

function assertInsideCases(candidate) {
    var resolved = path.resolve(candidate);
    if (resolved !== casesRoot && !resolved.startsWith(casesRoot + path.sep)) {
        throw new Error('Refusing to write outside cases directory: ' + resolved);
    }
    return resolved;
}

function resetDirectory(directory) {
    var resolved = assertInsideCases(directory);
    fs.rmSync(resolved, { recursive: true, force: true });
    fs.mkdirSync(resolved, { recursive: true });
}

function slug(value) {
    var normalized = String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    var result = normalized.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '');
    return (result || 'work').slice(0, 64).replace(/-+$/g, '');
}

function writeJson(file, value) {
    var resolved = assertInsideCases(file);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function baseCase(axis, tracker, family, work, variant) {
    var semantic = semanticFor(work);
    var title = renderTitle(tracker, work, semantic, variant);
    return {
        schemaVersion: 1,
        id: [axis, tracker, family || 'none', String(work.rank).padStart(3, '0'), 'v' + variant].join(':'),
        axis: axis,
        trackerId: tracker,
        family: family,
        work: { rank: work.rank, title: work.title, year: work.year, mode: work.mode },
        layoutVariant: variant,
        title: title,
        annotation: {
            method: 'manual-semantic-table',
            expectedRelease: expectedRelease(tracker, semantic, work.year)
        },
        provenance: {
            popularitySource: 'tmdb-popular-curated-2026-08-16',
            trackerGrammarSource: 'local-jackett-live-corpus',
            grammarReference: 'docs/reference/torrent-mod-tracker-formats.md#3-форматы-по-трекерам',
            generatedBy: 'generate-corpus.mjs'
        }
    };
}

function generateTrackerCases() {
    var directory = path.join(casesRoot, 'trackers');
    resetDirectory(directory);
    TRACKERS.forEach(function (tracker) {
        trackerCatalog(tracker).forEach(function (work) {
            for (var variant = 1; variant <= 5; variant++) {
                var value = baseCase('tracker', tracker, null, work, variant);
                var folder = String(work.rank).padStart(3, '0') + '-' + slug(work.title);
                writeJson(path.join(directory, tracker, folder, 'v' + variant + '.json'), value);
            }
        });
    });
}

function generateFamilyCases() {
    var directory = path.join(casesRoot, 'families');
    resetDirectory(directory);
    FAMILIES.forEach(function (family) {
        catalogs[family].forEach(function (work) {
            for (var variant = 1; variant <= 5; variant++) {
                var tracker = familyTracker(family, variant);
                var value = baseCase('family', tracker, family, work, variant);
                value.target = targetFor(family, work, semanticFor(work));
                value.annotation.expectedPipeline = {
                    family: family,
                    firstQuery: work.title,
                    usesAnimeIndexers: family === 'anime' || family === 'donghua',
                    prefersLocalTitle: family === 'asian-live',
                    route: family === 'anime' || family === 'donghua' ? 'anime' : 'general'
                };
                var folder = String(work.rank).padStart(3, '0') + '-' + slug(work.title);
                writeJson(path.join(directory, family, folder, 'v' + variant + '.json'), value);
            }
        });
    });
}

fs.mkdirSync(casesRoot, { recursive: true });
generateTrackerCases();
generateFamilyCases();

console.log('Generated 2250 tracker cases and 1250 family cases in ' + casesRoot);
