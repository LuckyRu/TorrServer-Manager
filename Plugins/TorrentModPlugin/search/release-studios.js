// Студии перевода извлекаются по грамматике трекера, а не по словарю: на живом корпусе
// структурный разбор нашёл 82 студии против 25 в списке ниже (§1.7 архитектурного документа).
// Словарь остаётся, но его роль другая — канонизировать написание, а не быть источником имён.

var KNOWN_STUDIOS = [
    'LostFilm', 'NewStudio', 'Jaskier', 'AlexFilm', 'Jetvis Studio', 'HDrezka', 'ColdFilm',
    'FocusStudio', 'Red Head Sound', 'RHS', 'Кубик в Кубе', 'Кураж-Бамбей', 'NewComers',
    'FreedomDub', 'SkySound', 'Wednesday Films', 'Гоблин', 'GoblinRUS', 'Пифагор',
    'ViruseProject', 'START', 'ПКино', 'ProFilms', 'RuDub', 'Vodnerilo'
];

// Слоты, в которых трекеры пишут студию. Каждый — своя грамматика, общий парсер остаётся один.
var STUDIO_SLOTS = [
    // rutracker/tapochek: «2x Dub + 5 x MVO (LostFilm, TVShows)»
    /(?:^|[\s\]|+])(?:\d+\s*[xх×]\s*)?(?:Dub|MVO|DVO|AVO|VO)\s*\(([^)]{2,90})\)/gi,
    // tapochek: «[MVO|LostFilm]», «[Dub|Red Head Sound]»
    /\[(?:Dub|MVO|DVO|AVO|VO)\s*\|([^\]]{2,60})\]/gi,
    // rutor/megapeer/noname: «от Jaskier», «от R.G. Механики»
    /(?:^|[\s|(])от\s+([^\s|,()]+(?:\s+[^\s|,()]+)?)/gi
];

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

var KNOWN_PATTERNS = KNOWN_STUDIOS.map(function (studio) {
    return { name: studio, pattern: wordPattern(studio) };
});

var canonicalIndex = {};
KNOWN_STUDIOS.forEach(function (studio) { canonicalIndex[studio.toLowerCase()] = studio; });

// «HDRezka Studio» и «HDrezka» — одна студия. Сравниваем по буквам и цифрам без регистра,
// отбрасывая родовое слово в хвосте: студии пишут его через раз.
function canonicalKey(name) {
    return String(name)
        .toLowerCase()
        .replace(/[^a-zа-яё0-9]+/g, '')
        .replace(/(?:studios?|студи[яи]|team|records)$/, '');
}

var canonicalByKey = {};
KNOWN_STUDIOS.forEach(function (studio) { canonicalByKey[canonicalKey(studio)] = studio; });

function canonical(name) {
    return canonicalIndex[name.toLowerCase()] || canonicalByKey[canonicalKey(name)] || name;
}

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

export function extractStudios(source) {
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

    STUDIO_SLOTS.forEach(function (slot) {
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
    return found.map(function (item) { return item.name; });
}
