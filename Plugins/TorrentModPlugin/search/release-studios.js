// Студии перевода извлекаются по грамматике трекера, а не по словарю: на живом корпусе
// структурный разбор нашёл 82 студии против 25 в списке ниже (§1.7 архитектурного документа).
// Словарь остаётся, но его роль другая — канонизировать написание, а не быть источником имён.

var KNOWN_STUDIOS = [
    'LostFilm', 'NewStudio', 'Jaskier', 'AlexFilm', 'Jetvis Studio', 'HDrezka', 'ColdFilm',
    'FocusStudio', 'Red Head Sound', 'RHS', 'Кубик в Кубе', 'Кураж-Бамбей', 'NewComers',
    'FreedomDub', 'SkySound', 'Wednesday Films', 'Гоблин', 'GoblinRUS', 'Пифагор',
    'ViruseProject', 'START', 'ПКино', 'ProFilms', 'RuDub', 'Vodnerilo'
];

// Слоты, в которых трекеры пишут студию. Каждый — своя грамматика, общий парсер остаётся один;
// профиль трекера лишь выбирает, какие слоты вообще смотреть.
var SLOTS = {
    // rutracker: «2x Dub + 5 x MVO (LostFilm, TVShows)»
    parens: /(?:^|[\s\]|+])(?:\d+\s*[xх×]\s*)?(?:Dub|MVO|DVO|AVO|VO)\s*\(([^)]{2,90})\)/gi,
    // tapochek: «[MVO|LostFilm]», «[Dub|Red Head Sound]»
    brackets: /\[(?:Dub|MVO|DVO|AVO|VO)\s*\|([^\]]{2,60})\]/gi,
    // rutor/megapeer/noname: «от Jaskier», «от R.G. Механики»
    from: /(?:^|[\s|(])от\s+([^\s|,()]+(?:\s+[^\s|,()]+)?)/gi,
    // bigfangroup: «… WEB-DL 1080p | Продубляж» — студия последним полем, часто обрезанным.
    tail: /\|\s*([^|]{2,40})\s*$/g
};

var SLOTS_BY_MODE = {
    any: ['parens', 'brackets', 'from'],
    parens: ['parens', 'from'],
    brackets: ['brackets', 'parens'],
    from: ['from'],
    tail: ['tail', 'from'],
    none: []
};

// То, что стоит в слоте студии, но студией не является: языки, пометки и сами типы перевода.
var NOT_A_STUDIO = {};
['rus', 'eng', 'ukr', 'jap', 'kor', 'chi', 'sub', 'subs', 'original', 'orig', 'int',
 'mvo', 'dvo', 'avo', 'vo', 'dub', 'dubbing', 'лицензия', 'оригинал', 'субтитры',
 'многоголосый', 'одноголосый', 'дубляж', 'озвучка', 'перевод'].forEach(function (word) {
    NOT_A_STUDIO[word] = true;
});

function wordPattern(word) {
    var pattern = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s_-]+/g, '[\\s._-]+');
    return new RegExp('(?:^|[^a-zа-яё0-9])' + pattern + '(?:[^a-zа-яё0-9]|$)', 'i');
}

var KNOWN_PATTERNS = [];
var canonicalIndex = {};
var canonicalByKey = {};

// «HDRezka Studio» и «HDrezka» — одна студия. Сравниваем по буквам и цифрам без регистра,
// отбрасывая родовое слово в хвосте: студии пишут его через раз.
function canonicalKey(name) {
    return String(name)
        .toLowerCase()
        .replace(/[^a-zа-яё0-9]+/g, '')
        .replace(/(?:studios?|студи[яи]|team|records)$/, '');
}

function canonical(name) {
    return canonicalIndex[name.toLowerCase()] || canonicalByKey[canonicalKey(name)] || name;
}

// Реестр студий: встроенные значения плюс то, что пользователь дописал в search-rules.json.
// Пользовательская запись может добавить написания (aliases) или отключить встроенную (disabled).
export function registerStudioRules(rules) {
    (rules || []).forEach(function (rule) {
        var name = String((rule && rule.name) || '').trim();
        if (!name) return;
        if (rule.disabled) {
            KNOWN_PATTERNS = KNOWN_PATTERNS.filter(function (known) { return known.name !== name; });
            delete canonicalIndex[name.toLowerCase()];
            delete canonicalByKey[canonicalKey(name)];
            return;
        }
        addStudio(name);
        (rule.aliases || []).forEach(function (alias) {
            var text = String(alias || '').trim();
            if (!text) return;
            canonicalIndex[text.toLowerCase()] = name;
            canonicalByKey[canonicalKey(text)] = name;
            KNOWN_PATTERNS.push({ name: name, pattern: wordPattern(text) });
        });
    });
}

function addStudio(name) {
    if (canonicalIndex[name.toLowerCase()]) return;
    canonicalIndex[name.toLowerCase()] = name;
    canonicalByKey[canonicalKey(name)] = name;
    KNOWN_PATTERNS.push({ name: name, pattern: wordPattern(name) });
}

KNOWN_STUDIOS.forEach(addStudio);

function cleanName(raw) {
    return String(raw)
        .replace(/…+\s*$/, '')
        .replace(/^[\s.+·]+|[\s.+·]+$/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function acceptable(name) {
    if (name.length < 2 || name.length > 40) return false;
    if (/^\d+$/.test(name)) return false;
    if (NOT_A_STUDIO[name.toLowerCase()]) return false;
    // «8|MVO» и подобные хвосты — это уже следующее поле заголовка, а не имя студии.
    return !/[|\]\[]/.test(name);
}

// Имя из слота может быть списком: «MVO (LostFilm, HDrezka, TVShows)».
function splitList(value) {
    return String(value).split(/[,;]|\s\+\s/);
}

export function extractStudios(source, profile) {
    var text = String(source || '');
    var found = [];
    var seen = {};

    function push(name, index) {
        var cleaned = cleanName(name);
        if (!acceptable(cleaned)) return;
        var studio = canonical(cleaned);
        var key = canonicalKey(studio);
        if (seen[key]) return;
        seen[key] = true;
        found.push({ name: studio, index: index });
    }

    var mode = (profile && profile.studioSlots) || 'any';
    (SLOTS_BY_MODE[mode] || SLOTS_BY_MODE.any).forEach(function (name) {
        var slot = SLOTS[name];
        if (!slot) return;
        slot.lastIndex = 0;
        var match;
        while ((match = slot.exec(text))) {
            splitList(match[1]).forEach(function (part) { push(part, match.index); });
            if (slot.lastIndex === match.index) slot.lastIndex++;
        }
    });

    // Известные студии ловим и вне слотов: часть трекеров пишет их просто в хвосте заголовка.
    KNOWN_PATTERNS.forEach(function (known) {
        var match = known.pattern.exec(text);
        if (!match) return;
        push(known.name, match.index);
    });

    found.sort(function (left, right) { return left.index - right.index; });
    var names = found.map(function (item) { return item.name; });
    // У аниме-трекеров студия — сам трекер: в заголовке её нет и искать нечего.
    if (!names.length && profile && profile.studioDefault) names.push(profile.studioDefault);
    return names;
}
