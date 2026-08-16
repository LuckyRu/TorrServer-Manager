import './helpers/mock-lampa.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

import { createRunner } from './helpers/test-runner.mjs';
import { parseRelease } from '../search/parse/release-parsing.js';
import { profileFor, indexersInGroup } from '../search/rules/tracker-profiles.js';
import { workFamily, usesAnimeIndexers, prefersLocalTitle } from '../search/profile/work-profile.js';
import { compileReleaseSelection } from '../search/profile/release-selection.js';
import { buildMovieQueries } from '../search/plan/movie-query-building.js';
import { buildSeriesQueries } from '../search/plan/series-query-building.js';
import { buildSearchPlan } from '../search/plan/indexer-search-strategies.js';
import { evaluateMediaTypeGate, evaluateSearchTitleGate } from '../search/gates/search-gates.js';
import { evaluateIdentityGate } from '../search/gates/gate-identity.js';

const { test, run } = createRunner();
const corpusRoot = path.join(import.meta.dirname, 'fixtures', 'extended-metadata');
const casesRoot = path.join(corpusRoot, 'cases');

const EXPECTED_RELEASE_KEYS = [
    'seasons', 'episodeFrom', 'episodeTo', 'explicitSeason', 'explicitEpisode', 'finalSeason',
    'releaseType', 'resolution', 'sourceType', 'hdr', 'audioChannels', 'audioTracks',
    'voiceTypes', 'voiceType', 'translators', 'releaseGroups', 'year', 'subtitles',
    'videoCodec', 'container', 'compatibility', 'compatibilityReason'
].sort();

function jsonFiles(directory) {
    const found = [];
    function visit(current) {
        fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) visit(full);
            else if (entry.isFile() && entry.name.endsWith('.json')) found.push(full);
        });
    }
    visit(directory);
    return found.sort();
}

function readCases(axis) {
    return jsonFiles(path.join(casesRoot, axis)).map((file) => ({
        file,
        relative: path.relative(corpusRoot, file),
        value: JSON.parse(fs.readFileSync(file, 'utf8'))
    }));
}

const trackerCases = readCases('trackers');
const familyCases = readCases('families');

test('корпус содержит 2250 трекерных и 1250 семейных файлов', () => {
    assert.equal(trackerCases.length, 2250);
    assert.equal(familyCases.length, 1250);

    const trackerCounts = Object.create(null);
    trackerCases.forEach(({ value }) => { trackerCounts[value.trackerId] = (trackerCounts[value.trackerId] || 0) + 1; });
    Object.keys(trackerCounts).forEach((tracker) => assert.equal(trackerCounts[tracker], 250, tracker));
    assert.equal(Object.keys(trackerCounts).length, 9);

    const familyCounts = Object.create(null);
    familyCases.forEach(({ value }) => { familyCounts[value.family] = (familyCounts[value.family] || 0) + 1; });
    Object.keys(familyCounts).forEach((family) => assert.equal(familyCounts[family], 250, family));
    assert.equal(Object.keys(familyCounts).length, 5);
});

test('каждый кейс имеет пять вариантов и полную ручную разметку', () => {
    const generatorSource = fs.readFileSync(path.join(corpusRoot, 'generate-corpus.mjs'), 'utf8');
    const definitionSource = fs.readFileSync(path.join(corpusRoot, 'corpus-definition.mjs'), 'utf8');
    assert.doesNotMatch(generatorSource + definitionSource, /search[\\/]parse/,
        'oracle не должен зависеть от production-парсера');

    const ids = new Set();
    const variants = new Map();
    trackerCases.concat(familyCases).forEach(({ relative, value }) => {
        assert.equal(value.schemaVersion, 1, relative);
        assert.equal(value.annotation.method, 'manual-semantic-table', relative);
        assert.deepEqual(Object.keys(value.annotation.expectedRelease).sort(), EXPECTED_RELEASE_KEYS, relative);
        assert.deepEqual(Object.keys(value.annotation.expectedSelection).sort(),
            ['coverage', 'family', 'title', 'tracker', 'version'], relative);
        assert.ok(!ids.has(value.id), 'duplicate id: ' + value.id);
        ids.add(value.id);
        const key = value.axis === 'family'
            ? [value.axis, value.family, value.work.rank].join(':')
            : [value.axis, value.trackerId, value.work.rank].join(':');
        if (!variants.has(key)) variants.set(key, new Set());
        variants.get(key).add(value.layoutVariant);
    });
    variants.forEach((items, key) => assert.deepEqual([...items].sort(), [1, 2, 3, 4, 5], key));
});

for (const tracker of [...new Set(trackerCases.map(({ value }) => value.trackerId))].sort()) {
    test(tracker + ': 50 раздач × 5 раскладок совпадают с oracle-разметкой', () => {
        trackerCases.filter(({ value }) => value.trackerId === tracker).forEach(({ relative, value }) => {
            const actual = parseRelease(value.title, profileFor(value.trackerId));
            assert.deepEqual(actual, value.annotation.expectedRelease, relative + '\n' + value.title);
            const item = { title: value.title, trackerId: value.trackerId, tracker: value.trackerId, release: actual };
            item.selection = compileReleaseSelection(item, value.target, undefined, true);
            assert.deepEqual(item.selection, value.annotation.expectedSelection, relative + ': selection');
        });
    });
}

for (const family of [...new Set(familyCases.map(({ value }) => value.family))].sort()) {
    test(family + ': 50 произведений × 5 вариантов собирают правильный поисковый пайплайн', () => {
        familyCases.filter(({ value }) => value.family === family).forEach(({ relative, value }) => {
            const expected = value.annotation.expectedPipeline;
            assert.equal(workFamily(value.target), expected.family, relative);
            assert.equal(usesAnimeIndexers(expected.family), expected.usesAnimeIndexers, relative);
            assert.equal(prefersLocalTitle(expected.family), expected.prefersLocalTitle, relative);

            const item = { title: value.title, trackerId: value.trackerId, tracker: value.trackerId };
            item.release = parseRelease(item.title, profileFor(item.trackerId));
            assert.deepEqual(item.release, value.annotation.expectedRelease, relative);
            item.selection = compileReleaseSelection(item, value.target, undefined, true);
            assert.deepEqual(item.selection, value.annotation.expectedSelection, relative + ': selection');
            assert.equal(evaluateMediaTypeGate(item, value.target).passes, true, relative + ': media-type');
            assert.equal(evaluateSearchTitleGate(item, value.target).passes, true, relative + ': title');
            assert.equal(evaluateIdentityGate(item, value.target).passes, true, relative + ': identity');

            const queries = value.target.mode === 'movie'
                ? buildMovieQueries(value.target)
                : buildSeriesQueries(value.target);
            assert.ok(queries.length > 0, relative + ': empty query list');
            assert.ok(queries[0].startsWith(expected.firstQuery), relative + ': ' + JSON.stringify(queries));

            const plan = buildSearchPlan(value.target, queries);
            const immediate = plan.filter((entry) => entry.when !== 'if-empty');
            assert.ok(immediate.length > 0, relative + ': empty immediate plan');
            if (expected.route === 'anime') {
                assert.deepEqual(immediate[0].indexerIds, indexersInGroup('anime'), relative);
            } else {
                immediate.forEach((entry) => {
                    assert.deepEqual(entry.excludeIndexerIds, indexersInGroup('anime'), relative);
                });
            }
        });
    });
}

await run();
