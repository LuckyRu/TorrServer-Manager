    // ---------- results screen (Lampa.Component) ----------
    //
    // Component lifecycle confirmed against the real (unminified) Lampa source, not just
    // app.min.js/live scripting — see docs/reference/lampa-plugin-api.md's "Component/Activity"
    // section. create()/render() are effectively required (an absent one throws inside
    // ActivitySlide's try/catch and silently swaps in the built-in nocomponent fallback);
    // start()/pause()/stop()/resize()/destroy()/back() are all optional, called only if present.
    //
    // View subscribes to a domain Store instead of exposing a named-callback `view` port — Lampa has
    // no reactivity of any kind (confirmed against its real source) so this subscribe/notify loop is
    // entirely our own convention, not framework-provided, same as the callback-port version before
    // it was. What changed: the domain (Plugins/TorrentModPlugin/domain/) now owns state + the
    // async/business processes (interactors) that update it and calls `store.patch(...)`; this file
    // owns exactly the things that touch Lampa.Explorer/Scroll/Filter/Controller/DOM/jQuery, plus the
    // Lampa.Component contract itself, and has one `store.subscribe(render)` that diffs the new state
    // against the previous and calls whichever of its own DOM-update functions the diff implies.
    // Local/global waiting states and dependency (staleness) resolution live in the domain's own
    // status/generation fields (domain/results-state.js) — this file just renders whatever they say.
    import { escapeHtml, cancelSearch } from '../shared/utils.js';
    import { baseTitles } from '../search/query-building.js';
    import { buildSeasonItems } from '../metadata/season-picker.js';
    import { canonicalTimeline, progressText } from '../metadata/tmdb.js';
    import { candidateBadgeText, candidateSubtitleText, searchQueryText, isSeriesWithSeasons } from '../domain/results-core.js';
    import { selectFilterChipData, selectFilterItems, selectEpisodeBadges } from '../domain/results-selectors.js';
    import { createResultsDomain } from '../domain/results-domain.js';

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
    function createResultsView(options) {
        var object = options.object;
        var movie = options.movie;
        var hasSeasons = options.hasSeasons;
        var domain = options.domain;

        var explorer = new Lampa.Explorer(object);
        var scroll = new Lampa.Scroll({ mask: true, over: true, step: 250 });
        var grid = $('<div class="torrent-mod__list"></div>');
        var status = $('<div class="torrent-mod__status"></div>');
        var episodeRows = {};

        // Side picker panel (right-arrow on an episode row): a slide-in overlay listing torrents
        // for that episode. Own Scroll + Controller, surface-fixed like the old preload overlay.
        // Hidden with inline display:none (not just the CSS transform) so a panel that somehow
        // outlives its screen can never be visible.
        var picker = $('<div class="torrent-mod-picker" style="display:none"></div>');
        var pickerScroll = new Lampa.Scroll({ mask: true, over: true, step: 250 });
        var pickerBody = $('<div class="torrent-mod-picker__body"></div>');
        pickerScroll.append(pickerBody);
        picker.append(pickerScroll.render());
        var focusedEpisodeNode = null;
        var viewDestroyed = false;

        function openPickerPanel() {
            if (viewDestroyed) return;
            var st = domain.store.get().picker || {};
            pickerBody.empty();
            picker.show();
            if (st.status === 'loading') {
                pickerBody.append($('<div class="torrent-mod-picker__empty">Ищем раздачи…</div>'));
            } else if (!st.items || !st.items.length) {
                pickerBody.append($('<div class="torrent-mod-picker__empty">Раздач не найдено</div>'));
            } else {
                var target = st.target;
                st.items.forEach(function (item) {
                    var node = row(item.title, candidateSubtitleText(item), pickerScroll);
                    node.find('.torrent-mod-row__badge').text(candidateBadgeText(item));
                    node.on('hover:enter', function () { domain.selection.playPickerCandidate(item, target); });
                    pickerBody.append(node);
                });
            }
            picker.addClass('torrent-mod-picker--open');
            try {
                Lampa.Controller.add('torrent_mod_picker', {
                    toggle: function () {
                        if (viewDestroyed) return;
                        Lampa.Controller.collectionSet(pickerScroll.render(true), pickerBody);
                        Lampa.Controller.collectionFocus(false, pickerScroll.render(true));
                    },
                    left: requestClosePicker,
                    back: requestClosePicker,
                    right: function () { if (!viewDestroyed) Navigator.move('right'); },
                    up: function () { if (!viewDestroyed) Navigator.move('up'); },
                    down: function () { if (!viewDestroyed) Navigator.move('down'); }
                });
                Lampa.Controller.toggle('torrent_mod_picker');
            } catch (e) {}
        }

        // DOM/controller cleanup ONLY — never touches domain state. Called from render when
        // picker.open flips to false (which was itself produced by domain.closePicker), so no
        // second store.patch → no recursive render (found by the architect).
        function hidePickerDom() {
            picker.removeClass('torrent-mod-picker--open');
            picker.hide();
            try { Lampa.Controller.toggle('content'); } catch (e) {}
            if (focusedEpisodeNode && focusedEpisodeNode[0] && focusedEpisodeNode[0].offsetParent) {
                try { Lampa.Controller.collectionFocus(focusedEpisodeNode[0], scroll.render(true)); } catch (e2) {}
            }
            focusedEpisodeNode = null;
        }

        // User-initiated close (left/back in the panel): flip domain state (render will hide the
        // DOM via hidePickerDom) and hide immediately as a belt-and-suspenders.
        function requestClosePicker() {
            if (viewDestroyed) return;
            try { domain.selection.closePicker(); } catch (e) {}
            hidePickerDom();
        }

        var initialSeason = object.season || 0;
        var initialTitles = baseTitles(movie);
        // Keep a reference to the params object: Lampa.Filter reads `params.search` live when
        // building its search-suggestion list (selectSearch marks the item whose query equals
        // params.search as selected), so updating this object keeps the "which query is active"
        // marker in the widget in sync with the real search — otherwise, after a search change,
        // reopening the search chip still highlighted the old query (confirmed by the user).
        var filterParams = {
            movie: movie,
            search: searchQueryText({ movie: movie, season: initialSeason }),
            search_one: initialTitles[0],
            search_two: initialTitles[1]
        };
        var filter = new Lampa.Filter(filterParams);
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
            toolbar.find('.filter--search > div').text(value).removeClass('hide');
            restoreContentFocus();
            domain.selection.searchWithQuery(value);
        };
        filter.onSelect = function (type, a, b) {
            if (a && a.reset) {
                domain.filters.resetFilters();
                restoreContentFocus();
                return;
            }
            if (type === 'sort') {
                restoreContentFocus();
                domain.episodes.setSeason(a.season);
                return;
            }
            if (type !== 'filter' || !b) return;
            if (a.kind === 'season') {
                restoreContentFocus();
                domain.episodes.setSeason(b.season);
                return;
            }
            if (a.kind === 'voice') domain.filters.setVoiceFilter(b.value);
            else if (a.kind === 'quality') domain.filters.setResolutionFilter(b.value);
            else if (a.kind === 'bitrate') domain.filters.setBitrateFilter(b.value);
            restoreContentFocus();
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
            filter.set('sort', buildSeasonItems(movie, initialSeason));
            // The chip's own label text ("Сортировать") is baked into Filter's template and not
            // renameable via public API — Online Mod does the exact same direct-DOM-text override for
            // its own repurposed 'sort' chip (confirmed live: its rendered label reads "Балансер", not
            // "Сортировать"), so this is the established technique, not a workaround.
            toolbar.find('.filter--sort span').text('Сезон');
        }
        // Explicit initial paint — the store subscription set up below only reacts to *changes*
        // (a state/previous-state diff), so the very first paint (before anything has changed yet)
        // is done directly here once, same as the old callback-port version did.
        syncFilterChips(selectFilterChipData(domain.store.get(), movie, hasSeasons));

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
        function row(title, subtitle, targetScroll) {
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
            var rowScroll = targetScroll || scroll;
            el.on('hover:focus', function (e) { rowScroll.update($(e.target), true); });
            return el;
        }

        function renderEpisodes(episodes, season) {
            grid.empty();
            episodeRows = {};
            episodes.forEach(function (episode) {
                var number = parseInt(episode.episode_number, 10);
                var view = canonicalTimeline(movie, season, number);
                var node = row(
                    'Сезон ' + season + ' / Серия ' + number + (episode.name ? ' — ' + episode.name : ''),
                    [episode.air_date, progressText(view)].filter(Boolean).join(' · ')
                );
                node.addClass('torrent-mod-episode').attr('data-episode', number);
                if (view && Lampa.Timeline && Lampa.Timeline.render) node.append(Lampa.Timeline.render(view));
                node.on('hover:enter', function () { domain.selection.selectEpisode(number); });
                grid.append(node);
                episodeRows[number] = node;
            });
            refreshGrid();
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
                right: function () {
                    // Right-arrow on an EPISODE row opens the side picker instead of moving focus
                    // (scoped to our own grid — a global .focus query could hit a foreign overlay).
                    var focused = grid.find('.torrent-mod-episode.focus')[0];
                    if (focused) {
                        focusedEpisodeNode = $(focused);
                        var number = parseInt(focusedEpisodeNode.attr('data-episode'), 10);
                        domain.selection.openPicker(number);
                        return;
                    }
                    Navigator.move('right');
                },
                up: function () { if (Navigator.canmove('up')) Navigator.move('up'); else Lampa.Controller.toggle('explorer'); },
                down: function () { Navigator.move('down'); },
                back: function () { Lampa.Controller.toggle('explorer'); }
            });
        }

        function updateEpisodeBadges(badgeMap) {
            Object.keys(episodeRows).forEach(function (key) {
                episodeRows[key].find('.torrent-mod-row__badge').text(badgeMap[key] || '');
            });
        }

        function syncFilterChips(data) {
            if (hasSeasons) {
                filter.chosen('sort', [data.seasonLabel]);
                // Must re-set the season picker items, not just the chip label: Lampa.Filter renders
                // the active marker off the item objects it holds (Filter.prototype.selected mutates
                // them in place), so a stale array keeps showing the previously picked season as
                // active on every reopen of the season chip (confirmed by the user).
                filter.set('sort', data.seasonItems);
            }
            filter.chosen('filter', data.activeLabels);
            filter.set('filter', data.filterItems);
        }

        function refreshFilterOptions(filterItems) {
            filter.set('filter', filterItems);
        }

        function setSearchText(text) {
            toolbar.find('.filter--search > div').text(text);
            // Keep Lampa.Filter's own params.search live (see filterParams above): the widget uses
            // it to mark the active query in its suggestion list and as SearchInput's initial text.
            if (filterParams) filterParams.search = text;
        }

        function setStatus(text) {
            status.text(text);
        }

        // Renders torrent candidates as the screen's own primary content instead of a Select overlay —
        // same row markup/badge slot as episode rows, richer info because there's more of it to show.
        // For series this replaces the episode list temporarily (a "К списку серий" row returns to it,
        // via the already-loaded state.episodesCache — no refetch); for movies it *is* the primary
        // content, there being no episode list to return to.
        function renderCandidateList(candidates, target, canReturnToEpisodeList) {
            grid.empty();
            episodeRows = {};
            if (canReturnToEpisodeList) {
                var backNode = row('← К списку серий', '');
                backNode.on('hover:enter', function () { domain.episodes.showEpisodeList(); });
                grid.append(backNode);
            }
            candidates.forEach(function (item) {
                var node = row(item.title, candidateSubtitleText(item));
                node.find('.torrent-mod-row__badge').text(candidateBadgeText(item));
                node.on('hover:enter', function () { domain.selection.playCandidate(item, target); });
                grid.append(node);
            });
            refreshGrid();
        }

        // The one `store.subscribe` for this whole screen. Diffs the new state against the previous
        // one field-group at a time and calls whichever DOM-update function that group implies —
        // cheap reference-equality checks (Store.patch always returns a *new* top-level object but
        // keeps old references for anything it didn't touch, so `state.x !== previous.x` is a valid,
        // cheap "did this change" check, no deep-diffing needed). Grouped the same way the old
        // callback-port version's call sites were, so the actual DOM work is byte-for-byte identical
        // to before — only *what triggers it* changed.
        function render(state, previous) {
            if (state.stage !== previous.stage || state.episodesCache !== previous.episodesCache ||
                state.candidates !== previous.candidates || state.message !== previous.message) {
                if (state.stage === 'episodes') renderEpisodes(state.episodesCache, state.season);
                else if (state.stage === 'candidates') renderCandidateList(state.candidates.items, state.candidates.target, state.candidates.canReturnToEpisodeList);
                else if (state.stage === 'message') showMessage(state.message.text, state.message.retry ? domain.episodes.loadEpisodes : null);
            }
            if (state.pool !== previous.pool || state.episodesCache !== previous.episodesCache) {
                updateEpisodeBadges(selectEpisodeBadges(object, state));
            }
            // Same distinction the old code's own comment called out: touching filter.chosen() (the
            // collapsed-chip summary text) when only the pool's *available options* changed, not the
            // user's chosen values, would be unnecessary churn — full resync only when a value the
            // user actually picked changed.
            if (state.voiceType !== previous.voiceType || state.resolution !== previous.resolution ||
                state.bitrate !== previous.bitrate || state.season !== previous.season) {
                syncFilterChips(selectFilterChipData(state, movie, hasSeasons));
            } else if (state.pool !== previous.pool) {
                refreshFilterOptions(selectFilterItems(state, movie, hasSeasons));
            }
            if (state.searchText !== previous.searchText) setSearchText(state.searchText);
            if (state.statusText !== previous.statusText) setStatus(state.statusText);
            // Side picker panel: open/close on the flag, re-render its list when it fills or errors.
            // Closing is DOM-only here — domain.closePicker already patched open:false (this render
            // IS that patch's notification); calling closePicker again would re-enter render.
            if (state.picker.open !== previous.picker.open) {
                if (state.picker.open) openPickerPanel();
                else hidePickerDom();
            } else if (state.picker.open && state.picker.status !== previous.picker.status) {
                openPickerPanel();
            }
        }

        var unsubscribe = domain.store.subscribe(render);

        function renderComponent(js) {
            return explorer.render(js);
        }

        // Panel lives surface-fixed over the app (like the old preload overlay did), independent of
        // Explorer's own layout.
        try { $('body').append(picker); } catch (e) {}

        return {
            create: function () { return renderComponent(true); },
            render: renderComponent,
            start: function () { explorer.toggle(); registerContentController(); },
            destroy: function () {
                // Tear the panel down WITHOUT touching domain/store (no closePicker → no store.patch
                // → no render): the screen is going away, render must not fight the removal. Also
                // unsubscribe and destroy BOTH scrolls (the panel's own pickerScroll was being
                // leaked — found by the architect). The 'content' controller is NOT toggled here:
                // Lampa re-registers it on the next Activity start anyway, and leaving it alone
                // avoids a global controller pointing at a dead screen.
                viewDestroyed = true;
                try { if (unsubscribe) unsubscribe(); } catch (e) {}
                try { picker.remove(); } catch (e) {}
                try { pickerScroll.destroy(); } catch (e) {}
                try { scroll.destroy(); } catch (e) {}
                try { explorer.destroy(); } catch (e) {}
            }
        };
    }

    export function TorrentModComponent(object) {
        var movie = object.movie || {};
        var hasSeasons = isSeriesWithSeasons(movie);
        var domain = createResultsDomain({ object: object, movie: movie, hasSeasons: hasSeasons });
        var view = createResultsView({ object: object, movie: movie, hasSeasons: hasSeasons, domain: domain });

        this.create = function () { return view.create(); };
        this.render = function (js) { return view.render(js); };
        this.start = function () { view.start(); domain.start(); };
        this.pause = function () {};
        this.stop = function () {};
        this.destroy = function () {
            cancelSearch();
            domain.destroy();
            view.destroy();
        };
    }
