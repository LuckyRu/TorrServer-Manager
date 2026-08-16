// Пользовательские правила поиска приезжают из менеджера (%LocalAppData%\TorrServer\data\
// search-rules.json), а встроенные значения компилируются в бандл. Плагин обязан работать при
// старом менеджере, при 404 и при выключенном хабе — тогда он один раз предупреждает и живёт на
// встроенных. Договор — docs/system-design/torrent-mod-search-architecture.md §4.

import { hubBase } from '../shared/state.js';
import { request } from '../shared/utils.js';
import { registerStudioRules } from './release-studios.js';
import { registerTrackerRules } from './tracker-profiles.js';
import { log, warn } from '../shared/core/log.js';

var KNOWN_SCHEMA = 1;
var pending = null;
var loaded = false;

function apply(data) {
    if (!data || data.schema > KNOWN_SCHEMA) {
        // Формат новее известного игнорируется целиком: частичное применение незнакомых правил
        // хуже, чем работа на встроенных.
        if (data && data.schema > KNOWN_SCHEMA) warn('search', 'search-rules: формат ' + data.schema + ' новее известного, правила пропущены');
        return false;
    }
    (data.warnings || []).forEach(function (message) { warn('search', 'search-rules: ' + message); });
    var studios = Array.isArray(data.studios) ? data.studios : [];
    if (studios.length) {
        registerStudioRules(studios);
        log('search', 'search-rules: применено студий — ' + studios.length);
    }
    var trackers = Array.isArray(data.trackers) ? data.trackers : [];
    if (trackers.length) {
        registerTrackerRules(trackers);
        log('search', 'search-rules: применено правил трекеров — ' + trackers.length);
    }
    return true;
}

export function ensureSearchRules() {
    if (loaded) return Promise.resolve(false);
    if (pending) return pending;
    pending = request(hubBase + '/api/search-rules', 8000).then(function (data) {
        pending = null;
        loaded = true;
        if (!data) {
            log('search', 'search-rules: правила недоступны, работаем на встроенных');
            return false;
        }
        return apply(data);
    }, function () {
        pending = null;
        loaded = true;
        return false;
    });
    return pending;
}

// Только для тестов: сбрасывает однократную загрузку.
export function resetSearchRules() {
    pending = null;
    loaded = false;
}
