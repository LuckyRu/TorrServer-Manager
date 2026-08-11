    import { escapeHtml } from '../shared/utils.js';
    import { buildSeasonItems } from '../metadata/season-picker.js';
    import { canonicalTimeline, progressText } from '../metadata/tmdb.js';
    import { candidateBadgeText, candidateSubtitleText, candidateIdentity } from '../domain/results-core.js';
    import { selectStatusText, selectSearchProgress } from '../domain/results-selectors.js';
    import { createResultsProjectionCache } from '../domain/results-projections.js';
    import { createRenderScheduler } from './render-scheduler.js';
    import { pickerNavigationWindow, adjacentPickerId, replacementPickerId } from './picker-navigation.js';
    import { reconcileKeyedChildren } from './keyed-dom.js';
    import { createPerfMetrics } from '../shared/core/perf-metrics.js';

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
        var candidateRows = {};
        var candidateRowItems = {};
        var candidateBackNode = null;
        var initialFocusDone = false;
        var projections = createResultsProjectionCache(object, movie, hasSeasons, function (season) {
            return domain.selection.getSeasonDefault(season);
        });
        var viewScope = domain.scope.child();
        var pickerScope = null;
        var pickerRowsScope = null;
        var scheduler;
        var lastFilterSignature = '';
        var lastStatusSignature = '';
        var pickerControllerRegistered = false;
        var pickerRows = {};
        var pickerItems = {};
        var pickerOrder = [];
        var pickerTarget = null;
        var pickerFocusId = null;

        var picker = $('<div class="torrent-mod-picker" style="display:none"></div>');
        var pickerScroll = new Lampa.Scroll({ mask: true, over: true, step: 250 });
        var pickerBody = $('<div class="torrent-mod-picker__body"></div>');
        pickerScroll.append(pickerBody);
        picker.append(pickerScroll.render());
        var viewDestroyed = false;
        var perf = createPerfMetrics(viewScope, {
            title: movie && (movie.title || movie.name) || '',
            media: hasSeasons ? 'series' : 'movie'
        });
        perf.observe(grid[0]);
        perf.observe(pickerBody[0]);
        perf.searchState(domain.store.get().poolStatus);
        var lastFocusedNode = null;
        var lastEpisodeGridSeason = null;

        var PICKER_NAVIGATION_RADIUS = 36;

        function createPickerScopes() {
            if (pickerScope && pickerScope.isAlive()) return;
            pickerScope = viewScope.child();
            pickerRowsScope = pickerScope.child();
        }

        function resetPickerRowsScope() {
            if (pickerRowsScope) pickerRowsScope.dispose();
            pickerRowsScope = pickerScope && pickerScope.isAlive() ? pickerScope.child() : null;
        }

        function bindScoped(scope, node, event, handler) {
            node.on(event, handler);
            if (scope) scope.track(function () { node.off(event, handler); });
        }

        function updatePickerNode(node, view) {
            var signature = [view.title, view.badge, view.details, view.selected ? '1' : '0'].join('|');
            if (node.attr('data-view-signature') === signature) return false;
            node.attr('data-view-signature', signature);
            node.find('.torrent-mod-picker-item__title').text(view.title);
            node.find('.torrent-mod-picker-item__badge').text(view.badge);
            node.find('.torrent-mod-picker-item__details').text(view.details);
            node.toggleClass('torrent-mod-picker-item--selected', view.selected);
            var mark = node.find('.torrent-mod-picker-item__mark');
            if (view.selected && !mark.length) node.append('<div class="torrent-mod-picker-item__mark">Выбрано</div>');
            else if (!view.selected && mark.length) mark.remove();
            return true;
        }

        function pickerNavigationNodes(focusId) {
            return pickerNavigationWindow(pickerOrder, focusId, PICKER_NAVIGATION_RADIUS)
                .map(function (id) { return pickerRows[id] && pickerRows[id][0]; })
                .filter(Boolean);
        }

        function focusPicker(id) {
            var node = pickerRows[id];
            if (!node || !node[0] || !node[0].offsetParent) return;
            pickerFocusId = id;
            try {
                var navigation = pickerNavigationNodes(id);
                if (Navigator && Navigator.setCollection) Navigator.setCollection(navigation);
                else Lampa.Controller.collectionSet(pickerScroll.render(true), pickerBody);
                Lampa.Controller.collectionFocus(node[0], pickerScroll.render(true));
            } catch (e) {}
        }

        function refreshPickerNavigation(positionBefore) {
            var node = pickerRows[pickerFocusId];
            if (!node || !node[0] || !node[0].offsetParent) {
                if (pickerOrder.length) focusPicker(pickerOrder[0]);
                return;
            }
            try {
                if (Navigator && Navigator.setCollection && Navigator.focused) {
                    Navigator.setCollection(pickerNavigationNodes(pickerFocusId));
                    Navigator.focused(node[0]);
                    node.addClass('focus');
                    if (positionBefore !== null && isFinite(positionBefore)) {
                        var shift = node[0].getBoundingClientRect().top - positionBefore;
                        if (Math.abs(shift) > 0.5) pickerScroll.shift(shift);
                    }
                } else {
                    focusPicker(pickerFocusId);
                }
            } catch (e) { focusPicker(pickerFocusId); }
        }

        function movePicker(direction) {
            if (viewDestroyed || !pickerOrder.length) return;
            try {
                if (Navigator.canmove(direction)) {
                    Navigator.move(direction);
                    return;
                }
            } catch (e) {}
            var next = adjacentPickerId(pickerOrder, pickerFocusId, direction);
            if (next) focusPicker(next);
        }

        function resetPickerRows() {
            resetPickerRowsScope();
            pickerBody.empty();
            pickerRows = {};
            pickerItems = {};
            pickerOrder = [];
            pickerTarget = null;
            pickerFocusId = null;
        }

        function renderPickerState(st) {
            if (st.status !== 'ready' || !Array.isArray(st.items) || !st.items.length) {
                resetPickerRows();
                if (st.status === 'loading') {
                    pickerBody.append($('<div class="torrent-mod-picker__empty"><span class="torrent-mod__spinner"></span>Ищем раздачи…</div>'));
                } else if (st.status === 'error') {
                    pickerBody.append($('<div class="torrent-mod-picker__empty">Не удалось получить раздачи</div>'));
                    var retryRow = $('<div class="torrent-mod-picker-item selector"><div class="torrent-mod-picker-item__title">Повторить</div></div>');
                    bindScoped(pickerRowsScope, retryRow, 'hover:focus', function (e) { pickerScroll.update($(e.target), true); });
                    bindScoped(pickerRowsScope, retryRow, 'hover:enter', function () {
                        if (!viewDestroyed) domain.episodes.retrySeasonLoad(domain.store.get().season);
                    });
                    pickerBody.append(retryRow);
                } else {
                    pickerBody.append($('<div class="torrent-mod-picker__empty">Раздач не найдено</div>'));
                }
                return { structureChanged: true, focusPosition: null };
            }

            var previousFocus = pickerFocusId;
            var previousFocusNode = previousFocus && pickerRows[previousFocus];
            var focusPosition = previousFocusNode && previousFocusNode[0] && previousFocusNode[0].offsetParent
                ? previousFocusNode[0].getBoundingClientRect().top
                : null;
            var active = {};
            var nextOrder = [];
            var desiredNodes = [];
            var structureChanged = false;
            var createdCount = 0;
            var updatedCount = 0;
            var removedCount = 0;
            pickerTarget = st.target;

            var rows = Array.isArray(st.rows) ? st.rows : [];
            rows.forEach(function (view) {
                var id = view.id;
                var item = view.item;
                var node = pickerRows[id];
                active[id] = true;
                nextOrder.push(id);
                pickerItems[id] = item;
                if (!node) {
                    structureChanged = true;
                    createdCount++;
                    node = torrentRow(pickerRowsScope).attr('data-picker-id', id);
                    bindScoped(pickerRowsScope, node, 'hover:focus', function () { pickerFocusId = id; });
                    bindScoped(pickerRowsScope, node, 'hover:enter', function () {
                        var current = pickerItems[id];
                        if (current) domain.selection.playPickerCandidate(current, pickerTarget);
                    });
                    pickerRows[id] = node;
                }
                if (updatePickerNode(node, view)) updatedCount++;
                desiredNodes.push(node[0]);
            });

            Object.keys(pickerRows).forEach(function (id) {
                if (active[id]) return;
                structureChanged = true;
                removedCount++;
                pickerRows[id].remove();
                delete pickerRows[id];
                delete pickerItems[id];
            });
            if (pickerOrder.length !== nextOrder.length || pickerOrder.some(function (id, index) { return id !== nextOrder[index]; })) {
                structureChanged = true;
            }
            var previousOrder = pickerOrder;
            pickerOrder = nextOrder;
            if (structureChanged) {
                perf.count('pickerStructuralMutations', reconcileKeyedChildren(pickerBody[0], desiredNodes));
            }
            perf.count('pickerRowsCreated', createdCount);
            perf.count('pickerRowsUpdated', updatedCount);
            perf.count('pickerRowsRemoved', removedCount);
            pickerFocusId = replacementPickerId(previousOrder, pickerOrder, previousFocus, st.selectedId);
            return { structureChanged: structureChanged, focusPosition: focusPosition };
        }

        function openPickerPanel() {
            if (viewDestroyed) return;
            createPickerScopes();
            var state = domain.store.get();
            var st = arguments.length ? arguments[0] : projections.pickerData(state);
            var wasOpen = picker.hasClass('torrent-mod-picker--open');
            picker.show().addClass('torrent-mod-picker--open');
            var renderResult = renderPickerState(st);
            try {
                if (!pickerControllerRegistered) {
                    pickerControllerRegistered = true;
                    Lampa.Controller.add('torrent_mod_picker', {
                        toggle: function () {
                            if (viewDestroyed) return;
                            if (pickerFocusId) focusPicker(pickerFocusId);
                            else {
                                Lampa.Controller.collectionSet(pickerScroll.render(true), pickerBody);
                                Lampa.Controller.collectionFocus(false, pickerScroll.render(true));
                            }
                        },
                        left: requestClosePicker,
                        back: requestClosePicker,
                        right: function () {
                            if (viewDestroyed) return;
                            requestClosePicker();
                            var filterChip = toolbar.find('.filter--filter');
                            if (filterChip.length) filterChip.trigger('hover:enter');
                        },
                        up: function () { movePicker('up'); },
                        down: function () { movePicker('down'); }
                    });
                }
                if (!wasOpen) Lampa.Controller.toggle('torrent_mod_picker');
                else if (renderResult.structureChanged && pickerFocusId) refreshPickerNavigation(renderResult.focusPosition);
                else if (renderResult.structureChanged) {
                    Lampa.Controller.collectionSet(pickerScroll.render(true), pickerBody);
                    Lampa.Controller.collectionFocus(false, pickerScroll.render(true));
                }
            } catch (e) {}
        }

        function torrentRow(scope) {
            var el = $(
                '<div class="torrent-mod-picker-item selector">' +
                '<div class="torrent-mod-picker-item__title"></div>' +
                '<div class="torrent-mod-picker-item__badge"></div>' +
                '<div class="torrent-mod-picker-item__details"></div>' +
                '</div>'
            );
            bindScoped(scope, el, 'hover:focus', function (e) { pickerScroll.update($(e.target), true); });
            return el;
        }

        function hidePickerDom() {
            picker.removeClass('torrent-mod-picker--open');
            picker.hide();
            if (pickerScope) pickerScope.dispose();
            pickerScope = null;
            pickerRowsScope = null;
            resetPickerRows();
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
            else if (a.kind === 'translator') domain.filters.setTranslatorFilter(b.value);
            else if (a.kind === 'quality') domain.filters.setResolutionFilter(b.value);
            else if (a.kind === 'bitrate') domain.filters.setBitrateFilter(b.value);
            restoreContentFocus();
        };
        filter.onBack = function () { Lampa.Controller.toggle('content'); };

        if (hasSeasons) {
            filter.set('sort', buildSeasonItems(movie, initialSeason));
            toolbar.find('.filter--sort span').text('Сезон');
        }
        syncFilterChips(projections.filterChipData(domain.store.get()));

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
                '<div class="torrent-mod-row__action" aria-hidden="true">›</div>' +
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
            candidateRows = {};
            candidateRowItems = {};
            candidateBackNode = null;
            var firstNumber = null;
            var createdCount = 0;
            (Array.isArray(episodes) ? episodes : []).forEach(function (episode) {
                if (!episode) return;
                var number = parseInt(episode.episode_number, 10);
                if (!isFinite(number) || number < 1) return;
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
                createdCount++;
            });
            perf.count('episodeRowsCreated', createdCount);
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
            var updatedCount = 0;
            Object.keys(episodeRows).forEach(function (key) {
                var entry = badgeMap[key];
                var el = episodeRows[key].find('.torrent-mod-row__badge');
                var action = episodeRows[key].find('.torrent-mod-row__action');
                var signature = [(entry && entry.text) || '', !!(entry && entry.loading), !!(entry && entry.canPick)].join('|');
                if (episodeRows[key].attr('data-badge-signature') === signature) return;
                episodeRows[key].attr('data-badge-signature', signature);
                updatedCount++;
                if (entry && entry.loading) el.html('<span class="torrent-mod-row__badge--shimmer"></span>');
                else el.text((entry && entry.text) || '');
                action.toggleClass('torrent-mod-row__action--visible', !!(entry && entry.canPick));
            });
            perf.count('episodeRowsUpdated', updatedCount);
        }

        function syncFilterChips(data) {
            var signature = JSON.stringify(data);
            if (signature === lastFilterSignature) return;
            lastFilterSignature = signature;
            if (hasSeasons) {
                filter.chosen('sort', [data.seasonLabel]);
                filter.set('sort', data.seasonItems);
            }
            filter.chosen('filter', data.activeLabels);
            filter.set('filter', data.filterItems);
            hideSearchChip();
        }

        function hideSearchChip() {
            toolbar.find('.filter--search').remove();
        }

        function setStatus(text, loading) {
            var signature = (loading ? '1' : '0') + '|' + text;
            if (signature === lastStatusSignature) return;
            lastStatusSignature = signature;
            status.html((loading ? '<span class="torrent-mod__spinner"></span>' : '') + escapeHtml(text));
        }

        var TRACKER_SUCCESS_HIDE_MS = 4000;
        var TRACKER_LEAVE_ANIMATION_MS = 300;

        function trackerLabel(indexer) {
            return indexer.name + ' · ' + (indexer.status === 'ok' ? Math.round(indexer.elapsedMs) + 'мс' : 'ошибка');
        }

        function scheduleTrackerHide(id, delayMs) {
            var entry = trackerNodes[id];
            if (!entry || entry.hideTimer) return;
            entry.hideTimer = viewScope.setTimeout(function () {
                var current = trackerNodes[id];
                if (!current) return;
                current.node.addClass('torrent-mod__tracker--leave');
                scheduler.invalidate('layer');
                viewScope.setTimeout(function () {
                    var stillThere = trackerNodes[id];
                    if (!stillThere) return;
                    stillThere.node.remove();
                    delete trackerNodes[id];
                    scheduler.invalidate('layer');
                }, TRACKER_LEAVE_ANIMATION_MS);
            }, Math.max(0, delayMs));
        }

        function renderTrackers(progress) {
            (progress && Array.isArray(progress.trackers) ? progress.trackers : []).forEach(function (indexer) {
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
                    viewScope.setTimeout(function () { node.removeClass('torrent-mod__tracker--enter'); }, 0);
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
            statusTickTimer = viewScope.setInterval(function () {
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
            episodeRows = {};
            var items = Array.isArray(candidates) ? candidates : [];
            var desired = [];
            var createdCount = 0;
            var updatedCount = 0;
            var removedCount = 0;
            if (canReturnToEpisodeList) {
                if (!candidateBackNode) {
                    candidateBackNode = row('← К списку серий', '');
                    candidateBackNode.on('hover:enter', function () { domain.episodes.showEpisodeList(); });
                }
                desired.push(candidateBackNode[0]);
            } else {
                if (candidateBackNode) candidateBackNode.remove();
                candidateBackNode = null;
            }
            var activeIds = {};
            items.forEach(function (item) {
                var id = candidateIdentity(item);
                activeIds[id] = true;
                var node = candidateRows[id];
                if (!node) {
                    createdCount++;
                    node = row(item.title, candidateSubtitleText(item));
                    node.addClass('torrent-mod-candidate');
                    node.on('hover:enter', function () {
                        var current = candidateRowItems[id];
                        if (current) domain.selection.playCandidate(current.item, current.target);
                    });
                    candidateRows[id] = node;
                }
                candidateRowItems[id] = { item: item, target: target };
                node.attr('data-candidate-id', id);
                var title = item.title || '';
                var subtitle = candidateSubtitleText(item);
                var badge = candidateBadgeText(item);
                var signature = [title, subtitle, badge].join('|');
                if (node.attr('data-view-signature') !== signature) {
                    updatedCount++;
                    node.attr('data-view-signature', signature);
                    node.find('.torrent-mod-row__title').text(title);
                    node.find('.torrent-mod-row__subtitle').text(subtitle);
                    node.find('.torrent-mod-row__badge').text(badge);
                }
                desired.push(node[0]);
            });
            Object.keys(candidateRows).forEach(function (id) {
                if (activeIds[id]) return;
                removedCount++;
                candidateRows[id].remove();
                delete candidateRows[id];
                delete candidateRowItems[id];
            });
            perf.count('candidateStructuralMutations', reconcileKeyedChildren(grid[0], desired));
            perf.count('candidateRowsCreated', createdCount);
            perf.count('candidateRowsUpdated', updatedCount);
            perf.count('candidateRowsRemoved', removedCount);
            lastFocusedNode = (focusedCandidateId && candidateRows[focusedCandidateId]) || null;
            refreshGrid();
            if (!initialFocusDone) {
                initialFocusDone = true;
                try { Lampa.Controller.toggle('content'); } catch (e) {}
                try { Lampa.Controller.collectionFocus(false, scroll.render(true)); } catch (e2) {}
            }
        }

        function sameTuple(left, right) {
            if (left === right) return true;
            if (!left || !right || left.length !== right.length) return false;
            for (var i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
            return true;
        }

        function renderContent(content) {
            var state = domain.store.get();
            if (content[0] === 'episodes') renderEpisodes(content[1], state.season);
            else if (content[0] === 'candidates') renderCandidateList(content[2].items, content[2].target, content[2].canReturnToEpisodeList);
            else if (content[0] === 'message') showMessage(content[3].text, content[3].retry);
        }

        function flushScheduledRender(reasons) {
            if (viewDestroyed) return;
            var state = domain.store.get();
            if (reasons.content) perf.measure('dom-commit:content', function () {
                renderContent([state.stage, state.episodesCache, state.candidates, state.message]);
            });
            if (reasons.badges) {
                var badges = perf.measure('episode-projection', function () { return projections.episodeBadges(state); });
                perf.measure('dom-commit:episodeBadges', function () { updateEpisodeBadges(badges); });
            }
            if (reasons.filters) {
                var filterData = perf.measure('filter-projection', function () { return projections.filterChipData(state); });
                perf.measure('dom-commit:filters', function () { syncFilterChips(filterData); });
            }
            if (reasons.status) {
                var progress = selectSearchProgress(state);
                perf.measure('dom-commit:status', function () {
                    setStatus(selectStatusText(state), progress.stage === 'loading');
                });
                ensureStatusTicking(progress.stage);
            }
            if (reasons.trackers) {
                var indexers = perf.measure('tracker-projection', function () { return projections.poolIndexers(state); });
                perf.measure('dom-commit:trackers', function () { renderTrackers(indexers); });
            }
            if (reasons.picker) {
                var pickerData = state.picker && state.picker.open
                    ? perf.measure('picker-projection', function () { return projections.pickerData(state); })
                    : null;
                perf.measure('dom-commit:picker', function () {
                    if (pickerData) openPickerPanel(pickerData);
                    else if (picker.hasClass('torrent-mod-picker--open')) hidePickerDom();
                });
            }
            perf.measure('layer-update', function () {
                try { Lampa.Layer.update(); } catch (e) {}
            });
            perf.count('layerUpdates');
            perf.poolRendered();
            if (perf.enabled) {
                perf.gauge('mountedEpisodeRows', grid.find('.torrent-mod-episode').length);
                perf.gauge('mountedPickerRows', pickerBody.find('.torrent-mod-picker-item').length);
                perf.gauge('torrentModElements', explorer.render(true).querySelectorAll('*').length + picker[0].querySelectorAll('*').length);
            }
            perf.searchState(state.poolStatus);
        }

        scheduler = createRenderScheduler(viewScope, flushScheduledRender);

        viewScope.subscribeSelector(domain.store,
            function (state) { return [state.stage, state.episodesRevision, state.candidates, state.message]; },
            function () { scheduler.invalidate('content'); },
            sameTuple
        );
        viewScope.subscribeSelector(domain.store,
            function (state) { return state.poolRevision; },
            function (revision) { perf.poolPatched(revision); }
        );
        viewScope.subscribeSelector(domain.store,
            function (state) {
                return [state.poolRevision, state.episodesRevision, state.poolStatus, state.seasonLoads,
                    state.season, state.filtersRevision, state.seasonEpisodeCount, state.avgRuntimeMinutes,
                    state.defaultsRevision];
            },
            function () { scheduler.invalidate('badges'); },
            sameTuple
        );
        viewScope.subscribeSelector(domain.store,
            function (state) { return [state.season, state.poolRevision, state.filtersRevision, state.seasonEpisodeCount, state.avgRuntimeMinutes]; },
            function () { scheduler.invalidate('filters'); },
            sameTuple
        );
        viewScope.subscribeSelector(domain.store,
            function (state) {
                return [state.statusText, state.poolStatus, state.poolStartedAt, state.poolAutoRetryAt, state.poolAttempt, state.season, state.seasonLoads];
            },
            function () { scheduler.invalidate('status'); },
            sameTuple
        );
        viewScope.subscribeSelector(domain.store,
            function (state) { return [state.poolIndexers, state.poolAllIndexers]; },
            function () { scheduler.invalidate('trackers'); },
            sameTuple
        );
        viewScope.subscribeSelector(domain.store,
            function (state) { return [state.picker, state.poolRevision, state.poolStatus, state.seasonLoads,
                state.season, state.filtersRevision, state.seasonEpisodeCount, state.avgRuntimeMinutes,
                state.defaultsRevision]; },
            function () { scheduler.invalidate('picker'); },
            sameTuple
        );

        scheduler.invalidate('content');
        scheduler.invalidate('badges');
        scheduler.invalidate('filters');
        scheduler.invalidate('status');
        scheduler.invalidate('trackers');
        scheduler.invalidate('picker');

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
                viewScope.dispose();
                try { picker.remove(); } catch (e) {}
                try { pickerScroll.destroy(); } catch (e) {}
                try { scroll.destroy(); } catch (e) {}
                try { explorer.destroy(); } catch (e) {}
            }
        };
    }
