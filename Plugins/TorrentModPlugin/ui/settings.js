    // ---------- settings ----------

    export function addSettings() {
        if (!Lampa.SettingsApi || !Lampa.SettingsApi.addComponent) return;
        Lampa.SettingsApi.addComponent({
            component: 'torrent_mod',
            icon: '<svg viewBox="0 0 64 64" width="36" height="36"><path fill="currentColor" d="M32 4a28 28 0 100 56 28 28 0 000-56zm0 8a20 20 0 110 40 20 20 0 010-40zm0 8a12 12 0 100 24 12 12 0 000-24z"/></svg>',
            name: 'Torrent Mod'
        });

        Lampa.SettingsApi.addParam({
            component: 'torrent_mod',
            param: { name: 'torrent_mod_enabled', type: 'trigger', default: true },
            field: { name: 'Torrent Mod', description: 'Отдельный поиск и просмотр торрентов сразу по всем источникам Jackett' }
        });

        Lampa.SettingsApi.addParam({
            component: 'torrent_mod',
            param: { name: 'torrent_mod_query_russian', type: 'trigger', default: true },
            field: { name: 'Искать «N сезон»', description: 'Дополнительный локализованный вариант запроса' }
        });

        Lampa.SettingsApi.addParam({
            component: 'torrent_mod',
            param: { name: 'torrent_mod_debug', type: 'trigger', default: false },
            field: { name: 'Отладка поиска', description: 'Таблица разобранных раздач и их оценок в консоли браузера при каждом поиске' }
        });

        Lampa.SettingsApi.addParam({
            component: 'torrent_mod',
            param: { name: 'torrent_mod_perf_diagnostics', type: 'trigger', default: false },
            field: { name: 'Диагностика производительности', description: 'Замеры проекций, DOM-коммитов и долгих задач; включать только на время профилирования' }
        });

        Lampa.SettingsApi.addParam({
            component: 'torrent_mod',
            param: { name: 'torrent_mod_preload_next', type: 'trigger', default: true },
            field: { name: 'Предзагрузка следующей серии', description: 'Пока серия играет, заранее качать начало следующей из пака — без паузы на буферизацию при переключении' }
        });
    }
