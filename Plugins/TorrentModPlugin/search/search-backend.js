    import { buildQueries as buildQueriesForTarget } from './query-building.js';
    import { compact } from '../shared/utils.js';
    import { mergeReleases } from '../shared/release-identity.js';
    import { startParallelSearch } from './parallel-search.js';
    import { buildSearchPlan } from './indexer-search-strategies.js';
    import { workFamily } from './work-profile.js';
    import { profileFor } from './tracker-profiles.js';
    import { evaluateMediaTypeGate, evaluateSearchTitleGate } from './search-gates.js';
    import { log, warn, debug, debugEnabled } from '../shared/core/log.js';

    function deferWork(work, scope) {
        return new Promise(function (resolve, reject) {
            var run = function () {
                try { resolve(work()); }
                catch (error) { reject(error); }
            };
            if (scope && scope.setTimeout) scope.setTimeout(run, 0);
            else setTimeout(run, 0);
        });
    }

    function mapTorrent(raw, parseReleaseForMode, tracker) {
        if (!raw) {
            return { item: null, title: 'Без названия', passes: false, reason: 'empty-record', details: {} };
        }
        var magnet = raw.MagnetUri || raw.Magnet || '';
        var link = raw.Link || raw.downloadUrl || '';
        if (!magnet && /^magnet:/i.test(link)) magnet = link;
        var title = raw.Title || raw.title || 'Без названия';
        var published = Date.parse(raw.PublishDate || raw.publishDate || raw.pubDate || '');
        var release = null;
        var parseError = '';
        if (parseReleaseForMode) {
            try {
                release = parseReleaseForMode(title, tracker && tracker.profile);
            } catch (error) {
                parseError = String(error && error.message || error);
            }
        }
        var rawLeechers = raw.Peers !== undefined ? raw.Peers : (raw.Peer !== undefined ? raw.Peer : raw.leechers);
        var leechers = parseInt(rawLeechers, 10) || 0;
        var item = {
            title: title,
            // tracker остаётся тем, что прислал Jackett: это поле входит в releaseIdentity, по
            // которой схлопывается пул и хранится сохранённый выбор пользователя (ADR-0005).
            tracker: raw.Tracker || raw.indexer || (tracker && tracker.name) || '',
            // id индексатора — ключ правил трекера. Отображаемое имя для этого не годится:
            // пользователь переименовывает индексаторы в UI Jackett.
            trackerId: (tracker && tracker.id) || '',
            size: raw.Size || raw.size || 0,
            seeders: parseInt(raw.Seeders || raw.Seed || raw.seeders, 10) || 0,
            leechers: leechers,
            peers: leechers,
            publishedAt: isNaN(published) ? 0 : published,
            magnet: magnet,
            link: link,
            release: release
        };
        var rejectedReason = !magnet && !link ? 'missing-download-link' : (parseError ? 'metadata-parse-error' : '');
        if (parseError) warn('search', 'Не удалось разобрать метаданные раздачи "' + title + '": ' + parseError);
        if (debugEnabled()) {
            debug('search', 'metadata-parse', {
                parsed: !rejectedReason, rejectedReason: rejectedReason, title: title, tracker: item.tracker,
                hasMagnet: Boolean(magnet), hasLink: Boolean(link), size: item.size,
                seeders: item.seeders, leechers: item.leechers, publishedAt: item.publishedAt,
                metadata: release, parseError: parseError
            });
        }
        return {
            item: rejectedReason ? null : item,
            title: title,
            passes: !rejectedReason,
            reason: rejectedReason,
            details: parseError ? { parseError: parseError } : {}
        };
    }

    function reasonCounts(decisions) {
        var counts = {};
        decisions.forEach(function (decision) {
            if (decision.passes) return;
            var reason = decision.reason || 'unknown';
            counts[reason] = (counts[reason] || 0) + 1;
        });
        return counts;
    }

    function summarizeGate(stage, decisions) {
        var rejectedTitles = [];
        var rejectedDetails = [];
        var rejected = 0;
        decisions.forEach(function (decision) {
            if (decision.passes) return;
            rejected++;
            if (rejectedTitles.length >= 100) return;
            rejectedTitles.push(decision.title);
            // Причина рядом с заголовком, а не только в общем счётчике: иначе на вопрос
            // «почему отброшена именно эта раздача» ответить нечем.
            rejectedDetails.push({ title: decision.title, reason: decision.reason, details: decision.details });
        });
        return {
            stage: stage,
            input: decisions.length,
            accepted: decisions.length - rejected,
            filtered: rejected,
            reasonCounts: reasonCounts(decisions),
            rejectedTitles: rejectedTitles,
            rejected: rejectedDetails
        };
    }

    function applyGate(items, evaluator, stage, target) {
        var decisions = items.map(function (item) {
            var decision = evaluator(item, target);
            return {
                item: item,
                title: item.title,
                passes: decision.passes,
                reason: decision.reason,
                details: decision.details
            };
        });
        var summary = summarizeGate(stage, decisions);
        return {
            items: decisions.filter(function (decision) { return decision.passes; }).map(function (decision) { return decision.item; }),
            summary: summary
        };
    }

    function runSearchGates(rawResults, target, parseReleaseForMode, source, query, tracker) {
        var parsedDecisions = rawResults.map(function (raw) { return mapTorrent(raw, parseReleaseForMode, tracker); });
        var parseSummary = summarizeGate('parse', parsedDecisions);
        var parsed = parsedDecisions.filter(function (decision) { return decision.passes; }).map(function (decision) { return decision.item; });
        var media = applyGate(parsed, evaluateMediaTypeGate, 'media-type', target);
        var title = applyGate(media.items, evaluateSearchTitleGate, 'title', target);
        var stages = [parseSummary, media.summary, title.summary];
        var filtered = rawResults.length - title.items.length;
        var summary = {
            query: query || target.englishTitle || target.movie.title || target.movie.name || '',
            source: source,
            input: rawResults.length,
            accepted: title.items.length,
            filtered: filtered,
            reasonCounts: stages.reduce(function (all, stage) {
                Object.keys(stage.reasonCounts).forEach(function (reason) {
                    all[reason] = (all[reason] || 0) + stage.reasonCounts[reason];
                });
                return all;
            }, {}),
            rejectedTitles: stages.reduce(function (all, stage) {
                return all.concat(stage.rejectedTitles);
            }, []).slice(0, 100),
            stages: stages.map(function (stage) {
                return {
                    stage: stage.stage, input: stage.input, accepted: stage.accepted,
                    filtered: stage.filtered, reasonCounts: stage.reasonCounts, rejected: stage.rejected
                };
            })
        };
        if (filtered) log('search', 'Фильтрация ' + source + ': принято ' + title.items.length + ' из ' + rawResults.length, summary);
        else debug('search', 'Фильтрация ' + source + ': без отсева', summary);
        return title.items;
    }

    function searchOneQuery(text, options) {
        return new Promise(function (resolve) {
            var rawResults = [];
            var indexers = [];
            var anyOk = false;
            startParallelSearch(text, function (entry) {
                anyOk = anyOk || entry.ok;
                indexers.push({ id: entry.id, name: entry.name, ok: entry.ok, error: entry.error, elapsedMs: entry.elapsedMs });
                // Сырые записи запоминают свой индексатор: правила трекера применяются при разборе.
                if (entry.ok) (entry.results || []).forEach(function (raw) {
                    rawResults.push({ raw: raw, id: entry.id, name: entry.name });
                });
            }, function (failed) {
                resolve({ rawResults: rawResults, indexers: indexers, failed: failed || !anyOk });
            }, undefined, undefined, options);
        });
    }

    export function searchTorrentMod(target, parseReleaseForMode, buildQueriesForMode) {
        var queries = (buildQueriesForMode || buildQueriesForTarget)(target);
        if (!queries.length) return Promise.resolve({ results: [], indexers: [], failed: true });

        var plans = buildSearchPlan(target, queries);
        return Promise.all(plans.map(function (plan) { return searchOneQuery(plan.query, plan); })).then(function (responses) {
            var ok = responses.filter(function (response) { return !response.failed; });
            if (!ok.length) return { results: [], indexers: [], failed: true };

            var byTracker = {};
            var indexers = [];
            ok.forEach(function (response) {
                response.rawResults.forEach(function (entry) {
                    var bucket = byTracker[entry.id] || (byTracker[entry.id] = { id: entry.id, name: entry.name, raw: [] });
                    bucket.raw.push(entry.raw);
                });
                indexers = indexers.concat(response.indexers);
            });

            return deferWork(function () {
                var mapped = [];
                Object.keys(byTracker).forEach(function (id) {
                    var bucket = byTracker[id];
                    mapped = mapped.concat(runSearchGates(bucket.raw, target, parseReleaseForMode,
                        bucket.name, queries.join(' | '),
                        { id: bucket.id, name: bucket.name, profile: profileFor(bucket.id, bucket.name) }));
                });
                return { results: mergeReleases([], mapped), indexers: indexers, failed: false };
            });
        });
    }

    export function searchTorrentModProgressive(target, parseReleaseForMode, buildQueriesForMode, onIndexerResult, onDone, scope, onIndexerList) {
        var queries = (buildQueriesForMode || buildQueriesForTarget)(target);
        if (!queries.length) { onDone(true); return { cancel: function () {} }; }

        var planned = buildSearchPlan(target, queries);
        // Профиль произведения раньше не попадал в лог вообще: по прогону нельзя было понять,
        // почему ушли именно эти запросы и именно на эти трекеры.
        log('search', 'план поиска: ' + workFamily(target) + (target.ongoing ? ', онгоинг' : ''), {
            family: workFamily(target),
            mode: target.mode,
            ongoing: !!target.ongoing,
            aliases: (target.aliases || []).length,
            season: target.season,
            episode: target.episode,
            plan: planned.map(function (plan) {
                return {
                    query: plan.query,
                    // Без этого поля по логу нельзя отличить запрос первой волны от отложенного,
                    // а значит нельзя понять, почему их ушло больше или меньше ожидаемого.
                    when: plan.when || 'always',
                    include: plan.indexerIds || null,
                    exclude: plan.excludeIndexerIds || null
                };
            })
        });
        var handles = [];
        var anyOk = false;
        var indexerState = {};
        var configuredIndexers = {};
        var pendingMappings = 0;
        var completionSent = false;
        var acceptedTotal = 0;

        // План делится на волны. Отложенные запросы («если пусто») уходят, только когда первая
        // волна не дала ни одной прошедшей гейт раздачи. Так дополнительное название стоит
        // ничего в обычном случае и спасает recall там, где угадать имя с первого раза нельзя:
        // parse_lang у пользователя может дать оригинал, которого нет в индексе русских трекеров.
        var immediate = planned.filter(function (plan) { return plan.when !== 'if-empty'; });
        var deferred = planned.filter(function (plan) { return plan.when === 'if-empty'; });
        var wave = immediate.length ? immediate : deferred;
        if (!immediate.length) deferred = [];
        var completedQueries = 0;
        var escalated = false;

        function completeWhenReady() {
            if (completionSent || completedQueries < wave.length || pendingMappings > 0) return;
            if (!acceptedTotal && deferred.length && !escalated) {
                escalated = true;
                var next = deferred;
                deferred = [];
                log('search', 'ничего не найдено первой волной — эскалация: ' +
                    next.map(function (plan) { return '"' + plan.query + '"'; }).join(', '));
                startWave(next);
                return;
            }
            completionSent = true;
            onDone(!anyOk);
        }

        function stateFor(entry) {
            if (!indexerState[entry.id]) {
                indexerState[entry.id] = { items: [], ok: false, error: null, elapsedMs: 0, name: entry.name };
            }
            return indexerState[entry.id];
        }

        function mergeItems(state, items) {
            state.items = mergeReleases(state.items, items);
        }

        function reportIndexerList(indexerList) {
            (indexerList || []).forEach(function (entry) {
                configuredIndexers[entry.id] = { id: entry.id, name: entry.name };
            });
            if (onIndexerList) onIndexerList(Object.keys(configuredIndexers).map(function (id) { return configuredIndexers[id]; }));
        }

        function startWave(plans) {
            wave = plans;
            completedQueries = 0;
            plans.forEach(function (plan) {
                handles.push(startParallelSearch(plan.query, function (entry) {
                    var state = stateFor(entry);
                    pendingMappings++;
                    deferWork(function () {
                        return entry.ok
                            ? runSearchGates(entry.results || [], target, parseReleaseForMode, entry.name, plan.query,
                                { id: entry.id, name: entry.name, profile: profileFor(entry.id, entry.name) })
                            : [];
                    }, scope).then(function (mapped) {
                        state.ok = state.ok || entry.ok;
                        state.error = state.ok ? null : entry.error;
                        state.elapsedMs += Number(entry.elapsedMs) || 0;
                        anyOk = anyOk || entry.ok;
                        acceptedTotal += mapped.length;
                        mergeItems(state, mapped);
                        onIndexerResult({
                            id: entry.id, name: state.name, ok: state.ok, error: state.error,
                            elapsedMs: state.elapsedMs, items: state.items.slice(), query: plan.query
                        });
                    }, function (error) {
                        state.error = String(error && error.message || error);
                        warn('search', 'Ошибка обработки ответа ' + entry.name + ': ' + state.error);
                        onIndexerResult({
                            id: entry.id, name: state.name, ok: state.ok, error: state.error,
                            elapsedMs: state.elapsedMs, items: state.items.slice(), query: plan.query
                        });
                    }).then(function () {
                        pendingMappings--;
                        completeWhenReady();
                    }, function (error) {
                        pendingMappings--;
                        warn('search', 'Ошибка доставки результата ' + entry.name + ': ' + String(error && error.message || error));
                        completeWhenReady();
                    });
                }, function (failed) {
                    completedQueries++;
                    completeWhenReady();
                }, scope, reportIndexerList, plan));
            });
        }

        startWave(wave);

        return { cancel: function () { handles.forEach(function (handle) { handle.cancel(); }); } };
    }
