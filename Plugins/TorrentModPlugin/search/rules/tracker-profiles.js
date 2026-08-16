// Правила оформления раздач у каждого трекера свои. Здесь они описаны декларативно и по одному
// ключу — id индексатора Jackett; общий парсер остаётся один. Грамматики сняты с живой выдачи,
// таблица форм — docs/system-design/torrent-mod-search-architecture.md §1.2.
//
// Профиль трогает разбор ровно в трёх точках: preNormalize (что срезать и как делить на
// сегменты), слоты (где искать год, перевод и студию) и defaults (чем заполнить то, о чём
// заголовок молчит). Регэкспы качества, кодека и разрешения остаются общими: внутри одного
// трекера сотни аплоадеров, и разброс внутри больше, чем между трекерами.

var DEFAULT_PROFILE = {
    id: '',
    group: 'general',
    // Вертикальная черта у одних трекеров разделяет названия, у других — поля метаданных.
    titleSeparators: 'slash-pipe',
    strip: [],
    year: 'delimited',
    voices: 'any',
    studioSlots: 'any',
    studioDefault: '',
    voiceDefault: '',
    query: { supportsSeasonMarker: true, supportsYear: true, preferBareTitle: false }
};

var PROFILES = [
    {
        id: 'rutracker',
        group: 'general',
        // «Королева слёз | Queen of Tears | Noonmului Yeowang» — черта разделяет названия.
        titleSeparators: 'slash-pipe',
        strip: [/^\s*\[SERIAL\]\s*/i],
        year: 'delimited',
        voices: 'text',
        studioSlots: 'parens'
    },
    {
        id: 'tapochek',
        group: 'general',
        titleSeparators: 'slash-pipe',
        year: 'delimited',
        voices: 'text',
        studioSlots: 'brackets'
    },
    {
        id: 'exkinoray',
        group: 'general',
        // «Ru | En | 2024 | WEB-DL (1080p) | DUB» — черта разделяет и названия, и поля.
        titleSeparators: 'slash-pipe',
        strip: [/\s*-\s*ExKinoRay\s*$/i],
        year: 'delimited',
        voices: 'text',
        studioSlots: 'any',
        studioDefault: ''
    },
    {
        id: 'rutor',
        group: 'general',
        // «Ru / En (2024) WEB-DL 1080p | D | Red Head Sound» — здесь черта это поля, не названия.
        titleSeparators: 'slash',
        year: 'delimited',
        voices: 'letter-codes',
        studioSlots: 'from'
    },
    {
        id: 'megapeer',
        group: 'general',
        titleSeparators: 'slash',
        year: 'delimited',
        voices: 'letter-codes',
        studioSlots: 'from'
    },
    {
        id: 'noname-club',
        group: 'general',
        // Пишет названия и через «/», и через «|» — разделитель выбирать по трекеру нельзя,
        // поля отсеиваются по собственному виду.
        titleSeparators: 'slash-pipe',
        year: 'delimited',
        voices: 'any',
        studioSlots: 'from'
    },
    {
        id: 'bigfangroup',
        group: 'general',
        // Заголовки приходят обрезанными многоточием — хвост слота студии может быть потерян.
        titleSeparators: 'slash-pipe',
        strip: [/…+\s*$/],
        year: 'delimited',
        voices: 'any',
        studioSlots: 'tail'
    },
    {
        id: 'anidub',
        group: 'anime',
        titleSeparators: 'slash',
        strip: [/\s*\[RUS\]\s*/i],
        year: 'never',
        voices: 'any',
        studioSlots: 'none',
        studioDefault: 'AniDUB',
        // Свои релизы оба трекера выпускают многоголосой озвучкой, но в заголовке этого не
        // пишут: на 211 живых заголовках тип перевода не разобрался ни разу.
        voiceDefault: 'Многоголосый',
        query: { supportsSeasonMarker: false, supportsYear: false, preferBareTitle: true }
    },
    {
        id: 'anilibria',
        group: 'anime',
        titleSeparators: 'slash',
        // «Название / E01-E12 Romaji - AniLiberty.TOP» — техническая приставка перед оригиналом.
        strip: [/(^|\/)\s*E\d{1,3}(?:\s*-\s*E?\d{1,3})?\s*/i, /\s*-\s*AniLiberty\.TOP\s*/i],
        year: 'never',
        voices: 'any',
        studioSlots: 'none',
        studioDefault: 'AniLibria',
        voiceDefault: 'Многоголосый',
        query: { supportsSeasonMarker: false, supportsYear: false, preferBareTitle: true }
    }
];

var byId = {};
function indexProfiles() {
    byId = {};
    PROFILES.forEach(function (profile) { byId[String(profile.id).toLowerCase()] = profile; });
}
indexProfiles();

function merge(profile) {
    var merged = {};
    Object.keys(DEFAULT_PROFILE).forEach(function (key) { merged[key] = DEFAULT_PROFILE[key]; });
    Object.keys(profile || {}).forEach(function (key) {
        if (profile[key] !== undefined && profile[key] !== null) merged[key] = profile[key];
    });
    merged.query = Object.assign({}, DEFAULT_PROFILE.query, profile && profile.query);
    return merged;
}

// Неизвестный индексатор получает общий профиль: добавление трекера в Jackett не должно
// требовать правки кода и не должно менять поведение остальных.
export function profileFor(indexerId, displayName) {
    var key = String(indexerId || '').toLowerCase();
    if (byId[key]) return merge(byId[key]);
    var name = String(displayName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    for (var id in byId) {
        if (byId.hasOwnProperty(id) && name && name.indexOf(id.replace(/[^a-z0-9]+/g, '')) >= 0) return merge(byId[id]);
    }
    return merge({ id: key });
}

export function indexersInGroup(group) {
    return PROFILES.filter(function (profile) { return profile.group === group; })
        .map(function (profile) { return profile.id; });
}

export function defaultProfile() {
    return merge({});
}

// Оверлей из search-rules.json: пользователь может поменять группу или правила трекера, не
// пересобирая плагин. Неизвестные поля игнорируются, известные заменяют встроенные.
export function registerTrackerRules(rules) {
    (rules || []).forEach(function (rule) {
        var id = String((rule && rule.id) || '').toLowerCase();
        if (!id) return;
        var existing = byId[id];
        var next = { id: id };
        Object.keys(DEFAULT_PROFILE).forEach(function (key) {
            if (key === 'strip') return;
            // null в JSON означает «поле не указано»: сериализатор пишет его для всех
            // незаполненных полей, и без этой проверки правка одного поля сбрасывала бы
            // остальные — например, группу аниме-трекера обратно в general.
            if (rule[key] !== undefined && rule[key] !== null) next[key] = rule[key];
            else if (existing && existing[key] !== undefined) next[key] = existing[key];
        });
        // strip приходит строками — регэкспы из файла не принимаем, чтобы правка данных не
        // могла уронить разбор всех раздач.
        var strip = (existing && existing.strip) || [];
        if (Array.isArray(rule.strip)) {
            strip = strip.concat(rule.strip.filter(function (value) { return typeof value === 'string' && value.length < 80; })
                .map(function (value) {
                    try { return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } catch (e) { return null; }
                }).filter(Boolean));
        }
        next.strip = strip;

        if (existing) PROFILES[PROFILES.indexOf(existing)] = next;
        else PROFILES.push(next);
        indexProfiles();
    });
}
