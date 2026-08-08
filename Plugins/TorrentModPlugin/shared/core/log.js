    // ---------- core: единый лог жизненного цикла плагина ----------
    //
    // До этого файла console.log/console.warn вызывались напрямую, каждый раз с собственным
    // вручную набранным префиксом "Torrent Mod: ..." — единообразия не было, и отследить по консоли
    // именно ПОСЛЕДОВАТЕЛЬНОСТЬ переходов жизненного цикла (создание компонента → старт домена →
    // загрузка серий/пула → выбор эпизода → регистрация торрента → плейбек) было нельзя, только
    // разрозненные разовые сообщения об ошибках.
    //
    // scope — короткая метка модуля ('component', 'domain', 'episodes', 'selection', 'playback', ...),
    // видна в каждой строке лога, чтобы при включённом фильтре консоли по тексту можно было следить
    // только за одним слоем. Формат заголовка не настраивается — единообразие важнее гибкости здесь.
    var PREFIX = 'Torrent Mod';

    export function log(scope, message, data) {
        var line = PREFIX + ' [' + scope + ']: ' + message;
        if (data !== undefined) console.log(line, data);
        else console.log(line);
    }

    export function warn(scope, message, data) {
        var line = PREFIX + ' [' + scope + ']: ' + message;
        if (data !== undefined) console.warn(line, data);
        else console.warn(line);
    }
