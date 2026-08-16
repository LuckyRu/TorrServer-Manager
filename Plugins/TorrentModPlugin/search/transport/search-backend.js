    import { buildQueries as buildQueriesForTarget } from '../plan/query-building.js';
    import { mergeReleases } from '../../shared/release-identity.js';
    import { startParallelSearch } from './parallel-search.js';
    import { buildSearchPlan } from '../plan/indexer-search-strategies.js';
    import { workFamily } from '../profile/work-profile.js';
    import { compileReleaseSelection } from '../profile/release-selection.js';
    import { profileFor } from '../rules/tracker-profiles.js';
    import { evaluateMediaTypeGate, evaluateSearchTitleGate } from '../gates/search-gates.js';
    import { log, warn, debug, debugEnabled } from '../../shared/core/log.js';

    // Отзывчивость определяется не суммой работы, а размером её наибольшего неразрываемого куска.
    // Потолок в записях гарантирует точку выхода на любом устройстве, бюджет времени укорачивает
    // срез там, где устройство медленнее ожидаемого (Chromium телевизора против desktop V8).
    var SLICE_MAX_ITEMS = 32;
    var SLICE_BUDGET_MS = 8;

    function now() {
        return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    }

    function yieldToEventLoop(scope) {
        return new Promise(function (resolve) {
            if (scope && scope.setTimeout) scope.setTimeout(resolve, 0);
            else setTimeout(resolve, 0);
        });
    }

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

    function mapTorrent(raw, parseReleaseForMode, tracker, verbose) {
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
        if (verbose) {
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

    // collectRejected собирает заголовки и детали каждого отказа — до 300 объектов на ответ
    // трекера. Счётчики причин дёшевы и нужны экрану всегда, детали — только диагностике.
    function createGateSummary(stage, collectRejected) {
        var input = 0;
        var rejected = 0;
        var reasonCounts = {};
        var rejectedTitles = [];
        var rejectedDetails = [];
        return {
            accepted: function () { return input - rejected; },
            add: function (passes, title, reason, details) {
                input++;
                if (passes) return;
                rejected++;
                var key = reason || 'unknown';
                reasonCounts[key] = (reasonCounts[key] || 0) + 1;
                if (!collectRejected || rejectedTitles.length >= 100) return;
                rejectedTitles.push(title);
                // Причина рядом с заголовком, а не только в общем счётчике: иначе на вопрос
                // «почему отброшена именно эта раздача» ответить нечем.
                rejectedDetails.push({ title: title, reason: reason, details: details });
            },
            done: function () {
                return {
                    stage: stage, input: input, accepted: input - rejected, filtered: rejected,
                    reasonCounts: reasonCounts, rejectedTitles: rejectedTitles, rejected: rejectedDetails
                };
            }
        };
    }

    // Ключ считается до разбора и потому смотрит только на сырые поля Jackett.
    function rawIdentity(raw) {
        if (!raw) return '';
        var title = raw.Title || raw.title || '';
        if (!title) return '';
        return title + '|' + (raw.Size || raw.size || 0);
    }

    // Один проход по сырой выдаче вместо четырёх: разбор и оба гейта — чистые поэлементные
    // функции, поэтому слияние стадий не меняет результат, но снимает три промежуточных массива
    // и позволяет отбросить дубль до самой дорогой работы. `seen` переживает запросы одного
    // трекера, поэтому вторая формулировка запроса не разбирает ту же раздачу заново.
    function runSearchGates(rawResults, target, parseReleaseForMode, source, query, tracker, seen, scope) {
        var duplicates = seen || Object.create(null);
        // Флаг читается один раз на ответ трекера, а не на каждую раздачу.
        var verbose = debugEnabled();
        var parseSummary = createGateSummary('parse', verbose);
        var mediaSummary = createGateSummary('media-type', verbose);
        var titleSummary = createGateSummary('title', verbose);
        var accepted = [];
        var considered = 0;
        var list = rawResults || [];
        var index = 0;

        function handle(raw) {
            var key = rawIdentity(raw);
            if (key) {
                if (duplicates[key]) return;
                duplicates[key] = true;
            }
            considered++;

            var parsed = mapTorrent(raw, parseReleaseForMode, tracker, verbose);
            parseSummary.add(parsed.passes, parsed.title, parsed.reason, parsed.details);
            if (!parsed.passes) return;

            var item = parsed.item;
            var media = evaluateMediaTypeGate(item, target);
            mediaSummary.add(media.passes, item.title, media.reason, media.details);
            if (!media.passes) return;

            var title = evaluateSearchTitleGate(item, target);
            titleSummary.add(title.passes, item.title, title.reason, title.details);
            if (!title.passes) return;

            // Это transport boundary: только успешно прошедшие intake-гейты получают accepted
            // selection metadata. Дальше UI не имеет права снова проверять строку заголовка.
            // Анализ названия переиспользуется из гейта, а не считается второй раз.
            item.selection = compileReleaseSelection(item, target, title.details.analysis, true);
            accepted.push(item);
        }

        function processSlice() {
            var sliceStart = now();
            var processed = 0;
            while (index < list.length) {
                handle(list[index++]);
                processed++;
                if (processed >= SLICE_MAX_ITEMS || now() - sliceStart >= SLICE_BUDGET_MS) break;
            }
            if (index < list.length) return yieldToEventLoop(scope).then(processSlice);
            return finish();
        }

        return processSlice();

        function finish() {
        var stages = [parseSummary.done(), mediaSummary.done(), titleSummary.done()];
        var filtered = considered - accepted.length;
        var summary = {
            query: query || target.englishTitle || target.movie.title || target.movie.name || '',
            source: source,
            input: considered,
            duplicates: (rawResults || []).length - considered,
            accepted: accepted.length,
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
            stages: stages
        };
        // Счётчики причин — маленький объект и главное, что нужно для «почему пусто». Полная
        // сводка с заголовками отказов уходит только в диагностический буфер.
        if (filtered) {
            log('search', 'Фильтрация ' + source + ': принято ' + accepted.length + ' из ' + considered,
                summary.reasonCounts);
            debug('search', 'Фильтрация ' + source + ': подробности', summary);
        } else {
            debug('search', 'Фильтрация ' + source + ': без отсева', summary);
        }
        // Счётчики нужны не только логу: по ним экран отвечает на вопрос «почему пусто».
        // raw считает различные раздачи: повторы одного заголовка по разным запросам плана —
        // это один и тот же релиз, а не две находки.
        accepted.stats = {
            raw: considered,
            video: mediaSummary.accepted(),
            title: titleSummary.accepted()
        };
        return accepted;
        }
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

            // Последовательно, а не Promise.all: цель чанкования — не занимать main thread, и
            // параллельный разбор всех трекеров сразу свёл бы её на нет.
            return deferWork(function () {
                var mapped = [];
                return Object.keys(byTracker).reduce(function (chain, id) {
                    return chain.then(function () {
                        var bucket = byTracker[id];
                        return runSearchGates(bucket.raw, target, parseReleaseForMode,
                            bucket.name, queries.join(' | '),
                            { id: bucket.id, name: bucket.name, profile: profileFor(bucket.id, bucket.name) });
                    }).then(function (items) { mapped = mapped.concat(items); });
                }, Promise.resolve()).then(function () {
                    return { results: mergeReleases([], mapped), indexers: indexers, failed: false };
                });
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
        var waveListReports = 0;
        var waveListsReady = false;

        function fallbackDecisionPending() {
            return !escalated && deferred.length > 0 && acceptedTotal === 0;
        }

        function trackerDone(state) {
            return waveListsReady && state.scheduledQueries > 0 &&
                state.completedQueries >= state.scheduledQueries && !fallbackDecisionPending();
        }

        // items — дельта с прошлой доставки, а не всё накопленное. Получатель прогоняет каждый
        // доставленный элемент через слияние по всему пулу, поэтому переотправка накопленного
        // делала стоимость квадратичной по числу трекеров. Накопленный размер отдаётся отдельным
        // числом: он нужен диагностике, но не требует копирования массива.
        function trackerUpdate(state, query, delta) {
            var done = trackerDone(state);
            if (done && state.terminalReported) return;
            if (done) state.terminalReported = true;
            onIndexerResult({
                id: state.id, name: state.name, ok: state.ok, error: state.ok ? null : state.error,
                // UI показывает wall-clock полного цикла трекера. Сумма Jackett elapsed по
                // параллельным запросам завышала бы реальное время в несколько раз.
                elapsedMs: state.startedAt ? Date.now() - state.startedAt : state.queryElapsedMs,
                queryElapsedMs: state.queryElapsedMs,
                items: delta || [], totalItems: state.items.length,
                query: query || state.lastQuery || '',
                done: done,
                completedQueries: state.completedQueries,
                totalQueries: state.scheduledQueries,
                stats: { raw: state.raw || 0, video: state.video || 0, title: state.title || 0 }
            });
        }

        function flushTrackerUpdates() {
            Object.keys(indexerState).forEach(function (id) {
                trackerUpdate(indexerState[id]);
            });
        }

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
            flushTrackerUpdates();
            onDone(!anyOk);
        }

        function stateFor(entry) {
            if (!indexerState[entry.id]) {
                indexerState[entry.id] = {
                    id: entry.id, items: [], ok: false, error: null, queryElapsedMs: 0,
                    name: entry.name, startedAt: 0, scheduledQueries: 0, completedQueries: 0,
                    terminalReported: false, lastQuery: '',
                    // Живёт весь поиск: запросы плана возвращают в основном одну и ту же выдачу.
                    seenRaw: Object.create(null)
                };
            }
            return indexerState[entry.id];
        }

        // Возвращает то, что реально изменилось: добавленные раздачи и вытеснившие их варианты
        // (mergeReleases кладёт на место победителя другой объект). Сравнение по ссылке, без
        // повторного вычисления releaseIdentity.
        function mergeItems(state, items) {
            var before = state.items;
            state.items = mergeReleases(before, items);
            if (state.items === before) return [];
            var previous = new Set(before);
            return state.items.filter(function (item) { return !previous.has(item); });
        }

        function addStats(state, stats) {
            if (!stats) return;
            state.raw = (state.raw || 0) + stats.raw;
            state.video = (state.video || 0) + stats.video;
            state.title = (state.title || 0) + stats.title;
        }

        function reportIndexerList(indexerList, context) {
            if (context.listReported) return;
            context.listReported = true;
            (indexerList || []).forEach(function (entry) {
                configuredIndexers[entry.id] = { id: entry.id, name: entry.name };
                context.listed[entry.id] = entry;
                var state = stateFor(entry);
                if (!state.startedAt) state.startedAt = Date.now();
                state.scheduledQueries++;
            });
            if (onIndexerList) onIndexerList(Object.keys(configuredIndexers).map(function (id) { return configuredIndexers[id]; }));
            waveListReports++;
            if (waveListReports >= wave.length) {
                waveListsReady = true;
                flushTrackerUpdates();
            }
        }

        function finishMissingIndexers(context, failed) {
            Object.keys(context.listed).forEach(function (id) {
                if (context.received[id]) return;
                var listed = context.listed[id];
                var state = stateFor(listed);
                state.completedQueries++;
                state.lastQuery = context.plan.query;
                if (!state.ok) state.error = failed ? 'Не удалось получить ответ' : 'Трекер не вернул итог';
                trackerUpdate(state, context.plan.query);
            });
        }

        function startWave(plans) {
            wave = plans;
            completedQueries = 0;
            waveListReports = 0;
            waveListsReady = false;
            plans.forEach(function (plan) {
                var context = { plan: plan, listed: {}, received: {}, listReported: false };
                handles.push(startParallelSearch(plan.query, function (entry) {
                    context.received[entry.id] = true;
                    var state = stateFor(entry);
                    pendingMappings++;
                    deferWork(function () {
                        return entry.ok
                            ? runSearchGates(entry.results || [], target, parseReleaseForMode, entry.name, plan.query,
                                { id: entry.id, name: entry.name, profile: profileFor(entry.id, entry.name) },
                                state.seenRaw, scope)
                            : [];
                    }, scope).then(function (mapped) {
                        state.ok = state.ok || entry.ok;
                        state.error = state.ok ? null : entry.error;
                        state.queryElapsedMs += Number(entry.elapsedMs) || 0;
                        state.completedQueries++;
                        state.lastQuery = plan.query;
                        anyOk = anyOk || entry.ok;
                        var acceptedBefore = acceptedTotal;
                        acceptedTotal += mapped.length;
                        var delta = mergeItems(state, mapped);
                        addStats(state, mapped.stats);
                        trackerUpdate(state, plan.query, delta);
                        // Первый принятый кандидат окончательно отменяет if-empty волну. Уже
                        // завершившиеся трекеры теперь можно честно перевести в terminal.
                        if (!acceptedBefore && acceptedTotal) flushTrackerUpdates();
                    }, function (error) {
                        state.completedQueries++;
                        state.lastQuery = plan.query;
                        state.error = String(error && error.message || error);
                        warn('search', 'Ошибка обработки ответа ' + entry.name + ': ' + state.error);
                        trackerUpdate(state, plan.query);
                    }).then(function () {
                        pendingMappings--;
                        completeWhenReady();
                    }, function (error) {
                        pendingMappings--;
                        warn('search', 'Ошибка доставки результата ' + entry.name + ': ' + String(error && error.message || error));
                        completeWhenReady();
                    });
                }, function (failed) {
                    finishMissingIndexers(context, failed);
                    completedQueries++;
                    completeWhenReady();
                }, scope, function (indexerList) {
                    reportIndexerList(indexerList, context);
                }, plan));
            });
        }

        startWave(wave);

        return { cancel: function () { handles.forEach(function (handle) { handle.cancel(); }); } };
    }
