    import { escapeHtml } from '../shared/utils.js';
    import { buildSeasonItems } from '../metadata/season-picker.js';
    import { canonicalTimeline, progressText } from '../metadata/tmdb.js';
    import { candidateBadgeText, candidateSubtitleText, candidateIdentity } from '../domain/results-core.js';
    import { selectFilterChipData, selectFilterItems, selectEpisodeBadges, selectStatusText, selectPickerData, selectSearchProgress, selectPoolIndexers } from '../domain/results-selectors.js';

    export function createResultsView(options) {
        var object = options.object;
        var movie = options.movie;
        var hasSeasons = options.hasSeasons;
        var domain = options.domain;

        var explorer = new Lampa.Explorer(object);
        var scroll = new Lampa.Scroll({ mask: true, over: true, step: 250 });
        var grid = $('<div class="torrent-mod__list"></div>');
        var status = $('<div class="torrent-mod__status"></div>');
        var trackers = $('<div class="torrent-mod__trackers"></div>');
        var trackerNodes = {};
        var episodeRows = {};
        var initialFocusDone = false;

        var picker = $('<div class="torrent-mod-picker" style="display:none"></div>');
        var pickerScroll = new Lampa.Scroll({ mask: true, over: true, step: 250 });
        var pickerBody = $('<div class="torrent-mod-picker__body"></div>');
        pickerScroll.append(pickerBody);
        picker.append(pickerScroll.render());
        var focusedEpisodeNumber = null;
        var viewDestroyed = false;
        var lastFocusedNode = null;
        var lastEpisodeGridSeason = null;

        function openPickerPanel() {
            if (viewDestroyed) return;
            var state = domain.store.get();
            var st = selectPickerData(object, state, domain.selection.getSeasonDefault(state.season));
            pickerBody.empty();
            picker.show();
            var selectedNode = null;
            if (st.status === 'loading') {
                pickerBody.append($('<div class="torrent-mod-picker__empty"><span class="torrent-mod__spinner"></span>Ищем раздачи…</div>'));
            } else if (st.status === 'error') {
                pickerBody.append($('<div class="torrent-mod-picker__empty">Не удалось получить раздачи</div>'));
                var retryRow = $('<div class="torrent-mod-picker-item selector"><div class="torrent-mod-picker-item__title">Повторить</div></div>');
                retryRow.on('hover:focus', function (e) { pickerScroll.update($(e.target), true); });
                retryRow.on('hover:enter', function () {
                    if (viewDestroyed) return;
                    domain.episodes.retrySeasonLoad(domain.store.get().season);
                });
                pickerBody.append(retryRow);
            } else if (!st.items || !st.items.length) {
                pickerBody.append($('<div class="torrent-mod-picker__empty">Раздач не найдено</div>'));
            } else {
                var target = st.target;
                var selectedId = st.selectedId;
                st.items.forEach(function (item) {
                    var selected = !!(selectedId && candidateIdentity(item) === selectedId);
                    var node = torrentRow(item, selected);
                    if (selected) selectedNode = node;
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
                        var focusTarget = selectedNode && selectedNode[0] && selectedNode[0].offsetParent ? selectedNode[0] : false;
                        Lampa.Controller.collectionFocus(focusTarget, pickerScroll.render(true));
                    },
                    left: requestClosePicker,
                    back: requestClosePicker,
                    right: function () {
                        if (viewDestroyed) return;
                        requestClosePicker();
                        var filterChip = toolbar.find('.filter--filter');
                        if (filterChip.length) filterChip.trigger('hover:enter');
                    },
                    up: function () { if (!viewDestroyed) Navigator.move('up'); },
                    down: function () { if (!viewDestroyed) Navigator.move('down'); }
                });
                Lampa.Controller.toggle('torrent_mod_picker');
            } catch (e) {}
        }

        function torrentRow(item, selected) {
            var el = $(
                '<div class="torrent-mod-picker-item selector' + (selected ? ' torrent-mod-picker-item--selected' : '') + '">' +
                '<div class="torrent-mod-picker-item__title">' + escapeHtml(item.title) + '</div>' +
                '<div class="torrent-mod-picker-item__badge">' + escapeHtml(candidateBadgeText(item)) + '</div>' +
                '<div class="torrent-mod-picker-item__details">' + escapeHtml(candidateSubtitleText(item)) + '</div>' +
                (selected ? '<div class="torrent-mod-picker-item__mark">Выбрано</div>' : '') +
                '</div>'
            );
            el.on('hover:focus', function (e) { pickerScroll.update($(e.target), true); });
            return el;
        }

        function hidePickerDom() {
            picker.removeClass('torrent-mod-picker--open');
            picker.hide();
            try { Lampa.Controller.toggle('content'); } catch (e) {}
            var activeEpisode = domain.store.get().activeEpisode;
            var node = activeEpisode ? episodeRows[activeEpisode] : null;
            if (node && node[0] && node[0].offsetParent) {
                try { Lampa.Controller.collectionFocus(node[0], scroll.render(true)); } catch (e2) {}
            }
        }

        function requestClosePicker() {
            if (viewDestroyed) return;
            try { domain.selection.closePicker(); } catch (e) {}
        }

        var initialSeason = object.season || 0;
        var filterParams = { movie: movie };
        var filter = new Lampa.Filter(filterParams);
        var toolbar = filter.render();

        function restoreContentFocus() {
            try { Lampa.Controller.toggle('content'); } catch (e) {}
        }

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
        filter.onBack = function () { Lampa.Controller.toggle('content'); };

        if (hasSeasons) {
            filter.set('sort', buildSeasonItems(movie, initialSeason));
            toolbar.find('.filter--sort span').text('Сезон');
        }
        syncFilterChips(selectFilterChipData(domain.store.get(), movie, hasSeasons));

        scroll.append(grid);
        explorer.appendHead(toolbar);
        explorer.appendHead(status);
        explorer.appendHead(trackers);
        explorer.appendFiles(scroll.render());

        scroll.minus(explorer.render(true).querySelector('.explorer__files-head'));

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
            if (rowScroll === scroll) el.on('hover:focus', function () { lastFocusedNode = el; });
            return el;
        }

        function restoreFocus() {
            var node = lastFocusedNode;
            if (node && node[0] && node[0].offsetParent && $.contains(grid[0], node[0])) {
                try { Lampa.Controller.collectionFocus(node[0], scroll.render(true)); return; } catch (e) {}
            }
            try { Lampa.Controller.collectionFocus(false, scroll.render(true)); } catch (e2) {}
        }

        function renderEpisodes(episodes, season) {
            grid.empty();
            episodeRows = {};
            var firstNumber = null;
            episodes.forEach(function (episode) {
                var number = parseInt(episode.episode_number, 10);
                if (firstNumber == null) firstNumber = number;
                var view = canonicalTimeline(movie, season, number);
                var node = row(
                    'Сезон ' + season + ' / Серия ' + number + (episode.name ? ' — ' + episode.name : ''),
                    [episode.air_date, progressText(view)].filter(Boolean).join(' · ')
                );
                node.addClass('torrent-mod-episode').attr('data-episode', number);
                if (view && Lampa.Timeline && Lampa.Timeline.render) node.append(Lampa.Timeline.render(view));
                node.on('hover:enter', function () { domain.selection.selectEpisode(number); });
                node.on('hover:focus', function () { domain.selection.setActiveEpisode(number); });
                grid.append(node);
                episodeRows[number] = node;
            });
            refreshGrid();
            if (!hasSeasons || firstNumber == null) return;

            var state = domain.store.get();
            var focusNumber = firstNumber;
            if (season === lastEpisodeGridSeason && state.activeEpisode && episodeRows[state.activeEpisode]) {
                focusNumber = state.activeEpisode;
            } else {
                var saved = null;
                try { saved = domain.selection.getSavedEpisode(movie); } catch (e2) {}
                if (saved && saved.season === season && episodeRows[saved.episode]) focusNumber = saved.episode;
            }
            lastEpisodeGridSeason = season;
            var node = episodeRows[focusNumber];
            var nodeReady = node && node[0] && node[0].offsetParent;

            if (!initialFocusDone) {
                initialFocusDone = true;
                if (nodeReady) lastFocusedNode = node;
                try { Lampa.Controller.toggle('content'); } catch (e) {}
            }
            if (nodeReady) {
                try { Lampa.Controller.collectionFocus(node[0], scroll.render(true)); } catch (e3) {}
            }
        }

        function showMessage(message, retry) {
            status.text(message);
            grid.empty();
            if (retry) {
                var retryNode = row('Повторить', '');
                retryNode.on('hover:enter', retry);
                grid.append(retryNode);
            } else {
                grid.append($('<div class="torrent-mod-picker__empty">' + escapeHtml(message) + '</div>'));
            }
            refreshGrid();
        }

        function refreshGrid() {
            try {
                var current = Lampa.Controller.enabled();
                if (current && current.name === 'content') {
                    Lampa.Controller.collectionSet(scroll.render(true), toolbar);
                    restoreFocus();
                }
            } catch (e) {}
            try { Lampa.Layer.update(); } catch (e) {}
        }

        function removePosterFromNavigation() {
            try {
                var card = explorer.render(true);
                var poster = card.querySelector('.explorer-card__head-img');
                if (poster) {
                    poster.classList.remove('selector', 'focus');
                    Navigator.remove(poster);
                }
            } catch (e) {}
        }

        function registerContentController() {
            Lampa.Controller.add('content', {
                link: this,
                toggle: function () {
                    Lampa.Controller.collectionSet(scroll.render(true), toolbar);
                    restoreFocus();
                    removePosterFromNavigation();
                },
                left: function () { if (Navigator.canmove('left')) Navigator.move('left'); else Lampa.Controller.toggle('menu'); },
                right: function () {
                    var focused = grid.find('.torrent-mod-episode.focus')[0];
                    if (focused) {
                        var number = parseInt($(focused).attr('data-episode'), 10);
                        domain.selection.setActiveEpisode(number);
                        domain.selection.openPicker();
                        return;
                    }
                    if (grid.find('.torrent-mod-candidate.focus')[0]) {
                        var filterChip = toolbar.find('.filter--filter');
                        if (filterChip.length) { filterChip.trigger('hover:enter'); return; }
                    }
                    Navigator.move('right');
                },
                up: function () { if (Navigator.canmove('up')) Navigator.move('up'); else Lampa.Controller.toggle('menu'); },
                down: function () { Navigator.move('down'); },
                back: function () { Lampa.Activity.backward(); }
            });
        }

        function updateEpisodeBadges(badgeMap) {
            Object.keys(episodeRows).forEach(function (key) {
                var entry = badgeMap[key];
                var el = episodeRows[key].find('.torrent-mod-row__badge');
                if (entry && entry.loading) el.html('<span class="torrent-mod-row__badge--shimmer"></span>');
                else el.text((entry && entry.text) || '');
            });
        }

        function syncFilterChips(data) {
            if (hasSeasons) {
                filter.chosen('sort', [data.seasonLabel]);
                filter.set('sort', data.seasonItems);
            }
            filter.chosen('filter', data.activeLabels);
            filter.set('filter', data.filterItems);
            hideSearchChip();
        }

        function refreshFilterOptions(filterItems) {
            filter.set('filter', filterItems);
            hideSearchChip();
        }

        function hideSearchChip() {
            toolbar.find('.filter--search').remove();
        }

        function setStatus(text, loading) {
            status.html((loading ? '<span class="torrent-mod__spinner"></span>' : '') + escapeHtml(text));
            try { Lampa.Layer.update(); } catch (e) {}
        }

        var TRACKER_SUCCESS_HIDE_MS = 4000;
        var TRACKER_LEAVE_ANIMATION_MS = 300;

        function trackerLabel(indexer) {
            return indexer.name + ' · ' + (indexer.status === 'ok' ? Math.round(indexer.elapsedMs) + 'мс' : 'ошибка');
        }

        function scheduleTrackerHide(id, delayMs) {
            var entry = trackerNodes[id];
            if (!entry || entry.hideTimer) return;
            entry.hideTimer = domain.scope.setTimeout(function () {
                var current = trackerNodes[id];
                if (!current) return;
                current.node.addClass('torrent-mod__tracker--leave');
                try { Lampa.Layer.update(); } catch (e) {}
                domain.scope.setTimeout(function () {
                    var stillThere = trackerNodes[id];
                    if (!stillThere) return;
                    stillThere.node.remove();
                    delete trackerNodes[id];
                    try { Lampa.Layer.update(); } catch (e) {}
                }, TRACKER_LEAVE_ANIMATION_MS);
            }, Math.max(0, delayMs));
        }

        function renderTrackers(progress) {
            progress.trackers.forEach(function (indexer) {
                var entry = trackerNodes[indexer.id];
                if (!entry) {
                    var node = $('<span class="torrent-mod__tracker torrent-mod__tracker--enter"></span>');
                    if (indexer.status === 'pending') {
                        node.addClass('torrent-mod__tracker--pending');
                        node.html('<span class="torrent-mod__spinner"></span>' + escapeHtml(indexer.name));
                    } else {
                        node.addClass(indexer.status === 'ok' ? 'torrent-mod__tracker--ok' : 'torrent-mod__tracker--error');
                        node.text(trackerLabel(indexer));
                    }
                    trackers.append(node);
                    entry = trackerNodes[indexer.id] = { node: node, hideTimer: null };
                    domain.scope.setTimeout(function () { node.removeClass('torrent-mod__tracker--enter'); }, 0);
                } else if (indexer.status !== 'pending') {
                    entry.node
                        .removeClass('torrent-mod__tracker--pending torrent-mod__tracker--ok torrent-mod__tracker--error')
                        .addClass(indexer.status === 'ok' ? 'torrent-mod__tracker--ok' : 'torrent-mod__tracker--error')
                        .text(trackerLabel(indexer));
                }
                if (indexer.status === 'ok') {
                    scheduleTrackerHide(indexer.id, TRACKER_SUCCESS_HIDE_MS - (Date.now() - indexer.reportedAt));
                }
            });
            // Same reasoning as setStatus above — this region's height feeds scroll.minus()'s math.
            try { Lampa.Layer.update(); } catch (e) {}
        }

        var statusTickTimer = null;
        var statusTickStage = null;
        function ensureStatusTicking(stage) {
            var active = stage === 'loading' || stage === 'retrying';
            if (!active) {
                if (statusTickTimer) { clearInterval(statusTickTimer); statusTickTimer = null; statusTickStage = null; }
                return;
            }
            if (statusTickTimer && statusTickStage === stage) return; // already ticking at the right cadence
            if (statusTickTimer) clearInterval(statusTickTimer);
            statusTickStage = stage;
            statusTickTimer = domain.scope.setInterval(function () {
                if (viewDestroyed) return;
                var state = domain.store.get();
                setStatus(selectStatusText(state), selectSearchProgress(state).stage === 'loading');
            }, stage === 'retrying' ? 1000 : 5000);
        }

        function renderCandidateList(candidates, target, canReturnToEpisodeList) {
            var focusedCandidateId = null;
            if (lastFocusedNode && lastFocusedNode[0] && $.contains(grid[0], lastFocusedNode[0])) {
                focusedCandidateId = lastFocusedNode.attr('data-candidate-id') || null;
            }
            grid.empty();
            episodeRows = {};
            var candidateRows = {};
            if (canReturnToEpisodeList) {
                var backNode = row('← К списку серий', '');
                backNode.on('hover:enter', function () { domain.episodes.showEpisodeList(); });
                grid.append(backNode);
            }
            candidates.forEach(function (item) {
                var node = row(item.title, candidateSubtitleText(item));
                node.addClass('torrent-mod-candidate');
                var id = candidateIdentity(item);
                node.attr('data-candidate-id', id);
                node.find('.torrent-mod-row__badge').text(candidateBadgeText(item));
                node.on('hover:enter', function () { domain.selection.playCandidate(item, target); });
                grid.append(node);
                candidateRows[id] = node;
            });
            lastFocusedNode = (focusedCandidateId && candidateRows[focusedCandidateId]) || null;
            refreshGrid();
            if (!initialFocusDone) {
                initialFocusDone = true;
                try { Lampa.Controller.toggle('content'); } catch (e) {}
                try { Lampa.Controller.collectionFocus(false, scroll.render(true)); } catch (e2) {}
            }
        }

        function render(state, previous) {
            if (state.stage !== previous.stage || state.episodesCache !== previous.episodesCache ||
                state.candidates !== previous.candidates || state.message !== previous.message) {
                if (state.stage === 'episodes') renderEpisodes(state.episodesCache, state.season);
                else if (state.stage === 'candidates') renderCandidateList(state.candidates.items, state.candidates.target, state.candidates.canReturnToEpisodeList);
                else if (state.stage === 'message') showMessage(state.message.text, state.message.retry);
            }
            if (state.pool !== previous.pool || state.episodesCache !== previous.episodesCache ||
                state.stage !== previous.stage || (previous.picker.open && !state.picker.open)) {
                updateEpisodeBadges(selectEpisodeBadges(object, state, domain.selection.getSeasonDefault(state.season)));
            }
            if (state.voiceType !== previous.voiceType || state.resolution !== previous.resolution ||
                state.bitrate !== previous.bitrate || state.season !== previous.season) {
                syncFilterChips(selectFilterChipData(state, movie, hasSeasons));
            } else if (state.pool !== previous.pool) {
                refreshFilterOptions(selectFilterItems(state, movie, hasSeasons));
            }
            var progressNow = selectSearchProgress(state);
            var progressPrev = selectSearchProgress(previous);
            var statusTextNow = selectStatusText(state);
            if (statusTextNow !== selectStatusText(previous) || progressNow.stage !== progressPrev.stage) {
                setStatus(statusTextNow, progressNow.stage === 'loading');
            }
            if (state.poolIndexers !== previous.poolIndexers || state.poolAllIndexers !== previous.poolAllIndexers) {
                renderTrackers(selectPoolIndexers(state));
            }
            ensureStatusTicking(progressNow.stage);
            if (state.picker.open !== previous.picker.open) {
                if (state.picker.open) openPickerPanel();
                else hidePickerDom();
            } else if (state.picker.open && (state.pool !== previous.pool ||
                state.seasonLoads !== previous.seasonLoads || state.picker.episode !== previous.picker.episode)) {
                openPickerPanel();
            }
        }

        domain.scope.subscribe(domain.store, render);

        function renderComponent(js) {
            return explorer.render(js);
        }

        try { $('body').append(picker); } catch (e) {}

        return {
            create: function () { return renderComponent(true); },
            render: renderComponent,
            start: function () {
                explorer.toggle();
                registerContentController();
                removePosterFromNavigation();
            },
            destroy: function () {
                viewDestroyed = true;
                try { picker.remove(); } catch (e) {}
                try { pickerScroll.destroy(); } catch (e) {}
                try { scroll.destroy(); } catch (e) {}
                try { explorer.destroy(); } catch (e) {}
            }
        };
    }
