    // ---------- results screen (Lampa.Component) ----------
    //
    // Component lifecycle confirmed against the real (unminified) Lampa source, not just
    // app.min.js/live scripting — see docs/reference/lampa-plugin-api.md's "Component/Activity"
    // section. create()/render() are effectively required (an absent one throws inside
    // ActivitySlide's try/catch and silently swaps in the built-in nocomponent fallback);
    // start()/pause()/stop()/resize()/destroy()/back() are all optional, called only if present.
    import { baseTitles } from '../search/query-building.js';
    import { scoreCandidate, applyStateFilters } from '../search/scoring.js';
    import { searchTorrentMod } from '../search/search-backend.js';
    import { buildSeasonItems } from '../metadata/season-picker.js';
    import { startDownload } from '../playback/smart-preload.js';
    import { canonicalTimeline, progressText, episodeCounts, fetchSeason } from '../metadata/tmdb.js';
    import { enabled, pad, escapeHtml, notify, debugLogCandidates, formatSize, cancelSearch } from '../shared/utils.js';

    // Primary content is EPISODE metadata (from TMDB), not raw torrent search results — matching
    // an episode to an actual torrent is a secondary, mostly-automatic step that happens only
    // once an episode is picked (auto-play on a confident match, a small picker otherwise).
    // Season/translation live in the toolbar (the slot Online Mod uses for its balancer picker);
    // anything else is a plain filter list.
    // Left info panel + toolbar row + scrollable list — all built on Lampa.Explorer, the same
    // helper the native full-card view and Online Mod itself use (confirmed live: its
    // constructor auto-populates the left panel from object.movie, no hand-built markup for
    // that part needed at all). Toolbar controls use Lampa's own real
    // `.simple-button.simple-button--filter` markup (also confirmed live) instead of custom
    // CSS, so they inherit native styling for free.
    export function TorrentModComponent(object) {
        var movie = object.movie || {};
        var explorer = new Lampa.Explorer(object);
        var scroll = new Lampa.Scroll({ mask: true, over: true, step: 250 });
        var grid = $('<div class="torrent-mod__list"></div>');
        var status = $('<div class="torrent-mod__status"></div>');
        var hasSeasons = !!(movie.number_of_seasons);
        var state = {
            season: object.season || 0,
            voiceType: 'any',
            resolution: 'any',
            seasonPool: null,
            seasonPoolPromise: null,
            seasonPoolSeason: null
        };
        var episodeRows = {};

        function searchQueryText(target) {
            var titles = baseTitles(target.movie);
            var base = titles[0] || '';
            if (target.episode) return base + ' S' + pad(target.season) + 'E' + pad(target.episode);
            if (target.season) return base + ' S' + pad(target.season);
            return base;
        }

        // Options come from what's actually in the season pool once it's loaded — no point offering
        // a "4K" filter for a season nothing 4K was ever found in — falling back to a generic static
        // list only while the pool is still loading (or for movies, which never populate one).
        function poolValues(pluck, order) {
            var pool = state.seasonPool || [];
            var present = {};
            pool.forEach(function (item) { var v = pluck(item); if (v) present[v] = true; });
            return order ? order.filter(function (v) { return present[v]; }) : Object.keys(present);
        }

        var QUALITY_LABELS = { '2160p': '4K', '1080p': '1080p', '720p': '720p', '480p': '480p' };

        function currentSeasonLabel() {
            if (!hasSeasons) return '';
            var found = buildSeasonItems(movie, state.season).filter(function (item) { return item.season === state.season; })[0];
            return found ? found.title : ('Сезон ' + state.season);
        }

        // Two of Lampa.Filter's three built-in chips ('sort'/'filter'), repurposed — confirmed live
        // this is exactly the native pattern, not a shortcut: Online Mod's own results screen does the
        // same thing (new Lampa.Filter(object), then filter.set('sort', its balancer list) and
        // filter.set('filter', its quality list)) rather than appending extra hand-built chips of its
        // own. 'sort' here is season (not literal sort order — Online Mod repurposes it too, for an
        // unrelated balancer picker, so the label/semantics aren't locked to the chip's own name).
        //
        // The 'filter' panel's shape (reset row first, then one row per dimension showing its current
        // value as a subtitle, each opening a nested Select on pick) is copied from Online Mod's own
        // `this.filter()` method, read directly rather than guessed — its `add(type, title)` helper
        // builds exactly this: `{title, subtitle: currentValue, items: subitems, stype: type}`, plus
        // a `{title: 'Сбросить фильтр', reset: true}` leaf with no `.items` (so Filter.show() calls
        // onSelect(type, a) directly, no nested submenu, on pick). Online Mod also repeats its 'sort'
        // dimension (balancer) inside this same panel for a one-stop view — we do the same with season.
        function buildFilterItems() {
            var select = [{ title: 'Сбросить фильтр', reset: true }];

            if (hasSeasons) {
                select.push({
                    title: 'Сезон',
                    subtitle: currentSeasonLabel(),
                    kind: 'season',
                    items: buildSeasonItems(movie, state.season)
                });
            }

            var voiceFound = poolValues(function (item) { return item.release.voiceType; });
            var voiceItems = [{ title: 'Любой', value: 'any', selected: state.voiceType === 'any' }].concat(
                (voiceFound.length ? voiceFound : ['Дубляж', 'Многоголосый', 'Одноголосый', 'Оригинал']).map(function (v) {
                    return { title: v, value: v, selected: state.voiceType === v };
                })
            );
            select.push({
                title: 'Перевод',
                subtitle: state.voiceType === 'any' ? 'Любой' : state.voiceType,
                kind: 'voice',
                items: voiceItems
            });

            var order = ['2160p', '1080p', '720p', '480p'];
            var qualityFound = poolValues(function (item) { return item.release.resolution; }, order);
            var qualityItems = [{ title: 'Любое', value: 'any', selected: state.resolution === 'any' }].concat(
                (qualityFound.length ? qualityFound : ['2160p', '1080p', '720p']).map(function (v) {
                    return { title: QUALITY_LABELS[v] || v, value: v, selected: state.resolution === v };
                })
            );
            select.push({
                title: 'Качество',
                subtitle: state.resolution === 'any' ? 'Любое' : (QUALITY_LABELS[state.resolution] || state.resolution),
                kind: 'quality',
                items: qualityItems
            });

            return select;
        }

        // Season already has its own fast-access chip ('sort'), so the 'filter' chip's own summary
        // (shown on the collapsed toolbar chip itself, via filter.chosen) only needs voice+quality —
        // repeating the season label there too would just duplicate what's already visible next to it.
        function activeFilterLabels() {
            var labels = [];
            if (state.voiceType !== 'any') labels.push(state.voiceType);
            if (state.resolution !== 'any') labels.push(QUALITY_LABELS[state.resolution] || state.resolution);
            return labels;
        }

        function syncFilterChips() {
            if (hasSeasons) filter.chosen('sort', [currentSeasonLabel()]);
            filter.chosen('filter', activeFilterLabels());
            filter.set('filter', buildFilterItems());
        }

        var initialTitles = baseTitles(movie);
        var filter = new Lampa.Filter({
            movie: movie,
            search: searchQueryText({ movie: movie, season: state.season }),
            search_one: initialTitles[0],
            search_two: initialTitles[1]
        });
        var toolbar = filter.render();

        // onSearch/onSelect aren't optional defaults — Filter.prototype.show() and the SearchInput
        // flow call `this.onSearch`/`this.onSelect` directly with no built-in no-op fallback (confirmed
        // by reading both in app.min.js), so a caller that forgets to assign one gets a hard TypeError
        // the moment the chip is actually used, not a silent no-op.
        // Restoring focus after ANY pick, not just after Back — confirmed live and by reading
        // app.min.js that this matters: a *successful* pick with no further nesting (reset, a direct
        // season pick off the fast chip, a direct search-suggestion pick) closes the selectbox via
        // `hide$3()`, a completely different internal path from the Back/cancel one (`close$a()`) —
        // `hide$3()` only flips the `selectbox--open` body class, it never touches `Controller` and
        // never calls `onBack`. Only a *nested* pick (opens a child Select, e.g. Перевод→Дубляж) happens
        // to self-heal, because Filter's own code reopens a fresh Select right after (which re-toggles
        // 'select' itself) — by the time the user finally presses Back on *that*, the real
        // `close$a()`/`onBack` path runs and restores things correctly. A flat, non-reopening pick has
        // no such second chance: nothing after it ever calls `onBack`, so without an explicit restore
        // here the controller is left pointing at a closed, dead selectbox forever. Restoring
        // unconditionally after every pick is safe even on the nested/reopening branches — Filter's own
        // `show()` call immediately after just re-toggles to 'select' again, harmless synchronous churn.
        function restoreContentFocus() {
            try { Lampa.Controller.toggle('content'); } catch (e) {}
        }

        filter.onSearch = function (value) {
            if (!value) return;
            state.customQuery = value;
            toolbar.find('.filter--search > div').text(value).removeClass('hide');
            restoreContentFocus();
            selectEpisode(state.lastEpisode || 0);
        };
        filter.onSelect = function (type, a, b) {
            if (a && a.reset) {
                state.voiceType = 'any';
                state.resolution = 'any';
                syncFilterChips();
                restoreContentFocus();
                annotateEpisodeRows();
                return;
            }
            if (type === 'sort') {
                restoreContentFocus();
                if (a.season === state.season) return;
                state.season = a.season;
                syncFilterChips();
                loadEpisodes();
                return;
            }
            if (type !== 'filter' || !b) return;
            if (a.kind === 'season') {
                restoreContentFocus();
                if (b.season === state.season) return;
                state.season = b.season;
                syncFilterChips();
                loadEpisodes();
                return;
            }
            if (a.kind === 'voice') state.voiceType = b.value;
            else if (a.kind === 'quality') state.resolution = b.value;
            syncFilterChips();
            restoreContentFocus();
            annotateEpisodeRows();
        };
        // Select.show()'s own native close() (confirmed by reading it in app.min.js) never restores
        // the previously-active controller itself — it only hides the overlay and calls whatever
        // onBack the caller supplied. Leaving this as a no-op (the first version of this code did)
        // means every Select.show Filter opens — search suggestions, the season list, the nested
        // Перевод/Качество menu — leaves 'select' as the permanently-active controller once closed:
        // arrow keys and back both go dead, confirmed live even with a plain vanilla Lampa.Select.show
        // call with no Filter/Torrent Mod involved at all. Restoring focus to 'content' explicitly is
        // the caller's job, same as the preload overlay's own cancel() already does correctly.
        filter.onBack = function () { Lampa.Controller.toggle('content'); };

        if (hasSeasons) {
            filter.set('sort', buildSeasonItems(movie, state.season));
            // The chip's own label text ("Сортировать") is baked into Filter's template and not
            // renameable via public API — Online Mod does the exact same direct-DOM-text override for
            // its own repurposed 'sort' chip (confirmed live: its rendered label reads "Балансер", not
            // "Сортировать"), so this is the established technique, not a workaround.
            toolbar.find('.filter--sort span').text('Сезон');
        }
        syncFilterChips();

        scroll.append(grid);
        explorer.appendHead(toolbar);
        // status lives in the head region too (not appendFiles, alongside the scroll) — it's fixed
        // chrome above the scrollable list, the same as toolbar, and .minus() below only measures
        // .explorer__files-head as a whole: if status sat outside it, its own height would go
        // uncounted and the list would still under- or over-shoot Explorer's own left-card bottom
        // by exactly status's height, the same class of misalignment the toolbar-height mixup was.
        explorer.appendHead(status);
        explorer.appendFiles(scroll.render());

        // .minus(el) tells Scroll to subtract el's own height from the scroll area's available
        // height — without an argument it never constrains itself to the viewport at all, which was
        // the actual cause of both the missing bottom mask/gradient and the last rows being
        // permanently out of reach: an unconstrained container has nothing to internally scroll
        // *within*, so hover:focus's own scroll.update() calls (see row()) have no effect.
        //
        // The element passed matters, and matters precisely: passing `toolbar` itself (Filter's own
        // rendered output, before/independent of being mounted) subtracted the *wrong* height —
        // confirmed live: with `toolbar` as the argument, this list's own scroll bottom landed at a
        // different Y than Explorer's own left-card scroll bottom (703px vs 759px in one real test),
        // breaking the aligned full-width fade Online Mod has (its left card and right list bottoms
        // are pixel-identical — algebraically guaranteed once both subtract the *same* real toolbar
        // height from the *same* window.innerHeight baseline). Online Mod's own call is
        // `scroll.minus(files.render().find('.explorer__files-head'))` — the actual mounted
        // `.explorer__files-head` container Explorer wraps around the toolbar, queried *after*
        // `appendHead`, not the bare pre-mount element. Matched here the same way.
        scroll.minus(explorer.render(true).querySelector('.explorer__files-head'));

        // Row markup/CSS ported 1:1 from the real, currently-installed Online Mod (inspected live
        // via this app's own /app/ in a browser, DOM + computed styles — not guessed): icon is an
        // absolutely-positioned 2.4em circle at top:-0.3em/left:0, title/subtitle just get
        // padding-left to clear it, rather than a flex row. Own class names, their exact technique.
        //
        // The hover:focus -> scroll.update() wire-up below isn't decorative — it's the one piece that
        // makes keyboard/remote scrolling actually work, and it was missing entirely before (real user
        // report: navigation moved focus but the viewport didn't follow it). Confirmed by reading Online
        // Mod's own `this.append` verbatim: `item.on('hover:focus', e => scroll.update($(e.target),
        // true)); scroll.append(item);` — not some separate Lampa "list" class, the exact same
        // Scroll+Controller primitives this file already uses, just with this one hookup Lampa's own
        // Navigator never does on its own (Navigator.move only ever shifts the .focus class between
        // collection elements — scrolling the element into view is entirely the caller's job, wired
        // per item, same shape as the collectionSet/collectionFocus/onBack contract elsewhere in this
        // file). Centralized here in row() so every list in this component (episodes, candidates,
        // messages) gets it automatically instead of needing it wired at each call site.
        function row(title, subtitle) {
            var el = $(
                '<div class="torrent-mod-row selector">' +
                '<div class="torrent-mod-row__icon">' +
                '<svg viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">' +
                '<circle cx="64" cy="64" r="56" stroke="currentColor" stroke-width="16"></circle>' +
                '<path d="M90.5 64.3827L50 87.7654L50 41L90.5 64.3827Z" fill="currentColor"></path>' +
                '</svg></div>' +
                '<div class="torrent-mod-row__title">' + escapeHtml(title) + '</div>' +
                (subtitle ? '<div class="torrent-mod-row__subtitle">' + escapeHtml(subtitle) + '</div>' : '') +
                '<div class="torrent-mod-row__badge"></div>' +
                '</div>'
            );
            el.on('hover:focus', function (e) { scroll.update($(e.target), true); });
            return el;
        }

        function renderEpisodes(episodes) {
            grid.empty();
            episodeRows = {};
            episodes.forEach(function (episode) {
                var number = parseInt(episode.episode_number, 10);
                var view = canonicalTimeline(movie, state.season, number);
                var node = row(
                    'Сезон ' + state.season + ' / Серия ' + number + (episode.name ? ' — ' + episode.name : ''),
                    [episode.air_date, progressText(view)].filter(Boolean).join(' · ')
                );
                if (view && Lampa.Timeline && Lampa.Timeline.render) node.append(Lampa.Timeline.render(view));
                node.on('hover:enter', function () { selectEpisode(number); });
                grid.append(node);
                episodeRows[number] = node;
            });
            refreshGrid();
            annotateEpisodeRows();
        }

        function showMessage(message, retry) {
            status.text(message);
            grid.empty();
            if (retry) {
                var retryNode = row('Повторить', '');
                retryNode.on('hover:enter', retry);
                grid.append(retryNode);
            }
            refreshGrid();
        }

        // Lampa.Explorer.toggle() (called below in this.start) only ever registers ONE named
        // controller — 'explorer', for the left info card — with its own back:Activity.backward()
        // and right:Controller.toggle('content'). It does NOT register 'content' for us; that's
        // left to the caller (confirmed by reading Explorer's toggle() in app.min.js — its own
        // `right` handler just does Controller.toggle('content') and trusts something else owns
        // that name). Without registering it ourselves, Controller.collectionSet() calls from
        // renderEpisodes/renderCandidateList/showMessage silently land on whatever controller happens
        // to be active at that moment (usually still 'explorer', since these often run before the
        // user ever presses right) — overwriting Explorer's own left-card focus collection with our
        // grid rows while leaving Explorer's left/back/toggle handlers in place. That's the actual
        // cause of the broken/erratic back button: back ends up bound to whichever controller last
        // had our rows stomped into its collection, not to a controller we actually own. Registering
        // 'content' properly — symmetric with Explorer's own 'explorer' entry, back returns focus to
        // 'explorer' instead of leaving the activity — makes this screen a well-behaved participant
        // in Lampa's own Controller/Activity navigation instead of a foreign, bolted-on screen.
        //
        // Registered fresh in this.start (not here at construction time) because ActivitySlide.start()
        // — Lampa's own framework code, confirmed live in app.min.js — unconditionally re-registers its
        // own placeholder 'content' controller on every start/restart of this activity (e.g. whenever
        // the user returns here from a pushed sub-screen) *before* calling our component's start(). A
        // one-time registration in the constructor would only win on the very first entry and silently
        // revert to the framework placeholder after any such round-trip.
        //
        // collectionSet(html, append) collects '.selector' elements from BOTH html and append into one
        // flat, spatially-navigable collection (confirmed by reading its body in app.min.js — append's
        // matches just get concat()-ed onto html's). Online Mod's own results screen does exactly this:
        // collectionSet(scroll.render(), files.render()) — its filter/balancer chip row and its result
        // rows end up in the SAME collection, so up/down naturally walks from one into the other. Passing
        // `grid` here instead of `toolbar` was wrong twice over: grid is already a DOM descendant of
        // scroll, so it added nothing, and it left `toolbar` (search/season/voice/filters chips) out of
        // every collection entirely — confirmed live, arrow keys could not reach the toolbar at all, only
        // mouse/touch could. `toolbar` as the second argument fixes both.
        function refreshGrid() {
            try {
                var current = Lampa.Controller.enabled();
                if (current && current.name === 'content') {
                    Lampa.Controller.collectionSet(scroll.render(true), toolbar);
                    Lampa.Controller.collectionFocus(false, scroll.render(true));
                }
            } catch (e) {}
            // Lampa.Layer's own internal .layer--wheight sweep (what actually turns scroll.minus()'s
            // stored element reference into a real height) only re-runs on its own triggers, not on
            // every mutation inside the marked element — found live: our head region's height changes
            // as `status` text comes and goes (e.g. "Ищем S07E01…" during a search, then '' once
            // results render), and without forcing a recompute here the scroll height/mask stayed
            // pinned to whatever headH happened to be true the *first* time Layer swept it, silently
            // drifting the right list's scroll bottom away from the left card's by however much the
            // head's height changed since — confirmed live (18.25px off after a search resolved,
            // matching an earlier, taller head snapshot; Lampa.Layer.update() alone closed it back to
            // 0). Called every time grid content changes since that's exactly when the head is most
            // likely to have just changed size too.
            try { Lampa.Layer.update(); } catch (e) {}
        }

        // The bare `Navigator` below is Lampa's own global (window.Navigator.move/canmove), not the
        // browser's native one — confirmed live (`typeof window.Navigator.move === 'function'`).
        // Every other Lampa API in this file goes through the `Lampa.` namespace; this one doesn't
        // because Lampa itself doesn't put it there.
        function registerContentController() {
            Lampa.Controller.add('content', {
                link: this,
                toggle: function () {
                    Lampa.Controller.collectionSet(scroll.render(true), toolbar);
                    Lampa.Controller.collectionFocus(false, scroll.render(true));
                },
                left: function () { if (Navigator.canmove('left')) Navigator.move('left'); else Lampa.Controller.toggle('explorer'); },
                right: function () { Navigator.move('right'); },
                up: function () { if (Navigator.canmove('up')) Navigator.move('up'); else Lampa.Controller.toggle('explorer'); },
                down: function () { Navigator.move('down'); },
                back: function () { Lampa.Controller.toggle('explorer'); }
            });
        }

        function loadEpisodes() {
            status.text('Загрузка списка серий…');
            fetchSeason(movie, state.season).catch(function (error) {
                console.warn('Torrent Mod: TMDB season fetch failed', error);
                return [];
            }).then(function (episodes) {
                episodes = episodes || [];
                var runtimes = episodes.map(function (e) { return parseInt(e.runtime, 10) || 0; }).filter(Boolean);
                state.seasonEpisodeCount = episodes.length || (episodeCounts(movie)[state.season] || 0);
                state.avgRuntimeMinutes = runtimes.length ? runtimes.reduce(function (a, b) { return a + b; }, 0) / runtimes.length : 0;

                if (!episodes.length) {
                    var fallbackCount = episodeCounts(movie)[state.season] || 0;
                    for (var i = 1; i <= fallbackCount; i++) episodes.push({ episode_number: i, name: 'Серия ' + i });
                }
                if (!episodes.length) { showMessage('Список серий недоступен', loadEpisodes); return; }
                status.text('');
                state.episodesCache = episodes;
                renderEpisodes(episodes);
                ensureSeasonPool();
            });
        }

        // As soon as we know the season (title + season number + TMDB's own runtime/episode-count
        // data for a correct per-episode bitrate estimate), there's nothing episode-specific left to
        // wait for — every episode's own torrent search would use the same season-wide query terms
        // anyway (see buildQueries: no `episode` on the target means season-pack-style queries only).
        // So search once, in the background, right when the episode list loads, instead of once per
        // click: the results enrich the episode list (availability badges) and the Перевод/Фильтры
        // chips (only offer voice/quality options that actually exist in this season) *before* the
        // user commits to anything, and let a click resolve instantly instead of waiting out another
        // Jackett round trip when the pool already covers it (see selectEpisode).
        function ensureSeasonPool() {
            if (!hasSeasons) return Promise.resolve([]);
            if (state.seasonPoolPromise && state.seasonPoolSeason === state.season) return state.seasonPoolPromise;
            state.seasonPoolSeason = state.season;
            state.seasonPool = null;
            var target = {
                movie: object.movie,
                season: state.season,
                episode: 0,
                seasonEpisodeCount: state.seasonEpisodeCount,
                avgRuntimeMinutes: state.avgRuntimeMinutes
            };
            state.seasonPoolPromise = searchTorrentMod(target).then(function (response) {
                if (state.seasonPoolSeason !== state.season) return []; // season changed mid-flight
                state.seasonPool = response.failed ? [] : response.results;
                filter.set('filter', buildFilterItems());
                annotateEpisodeRows();
                return state.seasonPool;
            });
            return state.seasonPoolPromise;
        }

        // Same gate + scoring pipeline selectEpisode's own fresh search uses (matchesTranslation,
        // state.resolution filter, passesMatchGate via scoreCandidate), just run against the
        // already-fetched season pool instead of a new network call — used both for the instant-click
        // reuse path and for the episode-row availability badges.
        function candidatesForEpisode(pool, number) {
            var target = {
                movie: object.movie,
                season: state.season,
                episode: number,
                seasonEpisodeCount: state.seasonEpisodeCount,
                avgRuntimeMinutes: state.avgRuntimeMinutes
            };
            var filtered = applyStateFilters(pool, state);
            var scored = filtered.filter(function (item) {
                item._score = scoreCandidate(item, target);
                return item._score.passes;
            });
            scored.sort(function (a, b) { return b._score.value - a._score.value || b.seeders - a.seeders; });
            return scored;
        }

        function badgeText(matches) {
            if (!matches.length) return 'раздачи не найдены';
            var best = matches[0];
            var bits = [];
            if (best.release.resolution) bits.push(best.release.resolution);
            if (best.release.translator || best.release.voiceType) bits.push(best.release.translator || best.release.voiceType);
            bits.push(best.seeders + ' сид.');
            if (matches.length > 1) bits.push('+' + (matches.length - 1));
            return bits.join(' · ');
        }

        function annotateEpisodeRows() {
            if (!state.seasonPool) return;
            Object.keys(episodeRows).forEach(function (key) {
                var number = parseInt(key, 10);
                var matches = candidatesForEpisode(state.seasonPool, number);
                episodeRows[key].find('.torrent-mod-row__badge').text(badgeText(matches));
            });
        }

        // Availability floor on auto-play, checked against the *score* (seeders+peers combined,
        // log-scaled — see scoreCandidate), not raw seeders: a "confident" title/season/episode
        // match with an empty swarm would still auto-play without this — which stalls forever
        // instead of feeling like an online service. Below this we always show the picker so the
        // user can knowingly pick a thin release instead of getting stuck.
        var MIN_AVAILABILITY_FOR_AUTOPLAY = 3;

        function finishSelection(candidates, target) {
            var best = candidates[0];
            var next = candidates[1];
            var confident = best._score.availabilityScore >= MIN_AVAILABILITY_FOR_AUTOPLAY &&
                (!next || best._score.value - next._score.value >= 6 || best.seeders > next.seeders * 2);

            if (confident) startDownload(best, target);
            else renderCandidateList(candidates.slice(0, 15), target);
        }

        function selectEpisode(episode) {
            state.lastEpisode = episode;
            var target = {
                movie: object.movie,
                season: state.season,
                episode: episode,
                seasonEpisodeCount: state.seasonEpisodeCount,
                avgRuntimeMinutes: state.avgRuntimeMinutes,
                customQuery: state.customQuery
            };
            toolbar.find('.filter--search > div').text(state.customQuery || searchQueryText(target));
            var hadCustomQuery = !!state.customQuery;
            state.customQuery = null;

            // The season-wide background search (kicked off when the episode list loaded, see
            // ensureSeasonPool) already covers exactly this query shape for anything without an
            // explicit episode tag — reuse it instead of a fresh multi-second Jackett round trip when
            // it already has a gate-passing match for this episode. Skipped for a custom query (an
            // explicit override always gets its own fresh search) or when the pool has nothing usable
            // for this specific episode — a targeted SxxExx query can surface single-episode torrents
            // the season-level query terms missed, so falling through to a real search here is a
            // recall safety net, not just a loading-state fallback.
            var reused = !hadCustomQuery && state.seasonPool ? candidatesForEpisode(state.seasonPool, episode) : [];
            if (reused.length) { finishSelection(reused, target); return; }

            status.text('Ищем' + (episode ? ' S' + pad(state.season) + 'E' + pad(episode) : '') + '…');
            searchTorrentMod(target).then(function (response) {
                if (response.failed) { notify('Jackett недоступен или не ответил'); status.text(''); return; }
                var pool = applyStateFilters(response.results, state);
                if (!pool.length) { notify('Ничего не найдено'); status.text(''); return; }

                // matchScore is a hard gate here, not a ranking input (see scoreCandidate): wrong
                // title/season/episode candidates are dropped entirely, never just ranked lower.
                pool.forEach(function (item) { item._score = scoreCandidate(item, target); });
                if (enabled('torrent_mod_debug', false)) debugLogCandidates(pool, target);
                var candidates = pool.filter(function (item) { return item._score.passes; });
                candidates.sort(function (a, b) { return b._score.value - a._score.value || b.seeders - a.seeders; });
                status.text('');
                if (!candidates.length) { notify('Похожих раздач не нашлось'); return; }

                finishSelection(candidates, target);
            });
        }

        function publishedText(item) {
            if (!item.publishedAt) return '';
            var days = Math.floor((Date.now() - item.publishedAt) / 86400000);
            if (days <= 0) return 'сегодня';
            if (days === 1) return 'вчера';
            if (days < 30) return days + ' дн. назад';
            return new Date(item.publishedAt).toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' });
        }

        // Quality/source/translator/tracks line — everything parseRelease() can pull out of the raw
        // title, distinct from the tracker/seeds/size/date line below it. Two lines instead of one
        // because a torrent row has meaningfully more to say than an episode row.
        function candidateBadgeText(item) {
            var bits = [];
            if (item.release.resolution) bits.push(item.release.resolution);
            if (item.release.sourceType) bits.push(item.release.sourceType);
            if (item.release.hdr) bits.push(item.release.hdr);
            if (item.release.codec) bits.push(item.release.codec);
            if (item.release.translator) bits.push(item.release.translator);
            else if (item.release.voiceType) bits.push(item.release.voiceType);
            if (item.release.audioTracks > 1) bits.push(item.release.audioTracks + ' ауд. дор.');
            else if (item.release.audioChannels) bits.push(item.release.audioChannels);
            if (item.release.subtitles) bits.push('субтитры');
            return bits.join(' · ');
        }

        function candidateSubtitleText(item) {
            var bits = [];
            if (item.tracker) bits.push(item.tracker);
            bits.push(item.seeders + ' сид. · ' + item.peers + ' пир.');
            var size = formatSize(item.size);
            if (size) bits.push(size);
            var published = publishedText(item);
            if (published) bits.push(published);
            return bits.join(' · ');
        }

        // Renders torrent candidates as the screen's own primary content instead of a Select overlay —
        // same row markup/badge slot as episode rows, richer info because there's more of it to show.
        // For series this replaces the episode list temporarily (a "К списку серий" row returns to it,
        // via the already-loaded state.episodesCache — no refetch); for movies it *is* the primary
        // content, there being no episode list to return to.
        function renderCandidateList(candidates, target) {
            grid.empty();
            episodeRows = {};
            if (hasSeasons && state.episodesCache) {
                var backNode = row('← К списку серий', '');
                backNode.on('hover:enter', function () { status.text(''); renderEpisodes(state.episodesCache); });
                grid.append(backNode);
            }
            candidates.forEach(function (item) {
                var node = row(item.title, candidateSubtitleText(item));
                node.find('.torrent-mod-row__badge').text(candidateBadgeText(item));
                node.on('hover:enter', function () { startDownload(item, target); });
                grid.append(node);
            });
            refreshGrid();
        }

        function start() {
            if (!hasSeasons) { status.text(''); selectEpisode(0); return; }
            loadEpisodes();
        }

        this.create = function () { return this.render(true); };
        this.render = function (js) { return explorer.render(js); };
        this.start = function () { explorer.toggle(); registerContentController(); start(); };
        this.pause = function () {};
        this.stop = function () {};
        this.destroy = function () {
            cancelSearch();
            try { scroll.destroy(); } catch (e) {}
            try { explorer.destroy(); } catch (e) {}
        };
    }
