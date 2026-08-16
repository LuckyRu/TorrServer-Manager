// Авторы раздачи извлекаются по грамматике трекера, а не по словарю: на живом корпусе структурный
// разбор находит втрое больше имён, чем есть в списке (§1.7 архитектурного документа). Словарь
// (credits-registry.js) отвечает на другой вопрос — кем это имя является: студией перевода или
// релиз-группой, и что о ней известно (§1.7.1).

import { entryByKey, roleOf, canonicalName, canonicalKey, knownPatterns, CREDIT_KINDS } from './credits-registry.js';

// Слоты, в которых трекеры пишут авторов. Каждый — своя грамматика, общий парсер остаётся один;
// профиль трекера лишь выбирает, какие слоты вообще смотреть. Роль слота — предположение по
// умолчанию: имя из «от X» считается релиз-группой, пока реестр не скажет иначе.
var SLOTS = {
    // rutracker: «2x Dub + 5 x MVO (LostFilm, TVShows)»
    parens: { role: CREDIT_KINDS.STUDIO, pattern: /(?:^|[\s\]|+])(?:\d+\s*[xх×]\s*)?(?:Dub|MVO|DVO|AVO|VO)\s*\(([^)]{2,90})\)/gi },
    // tapochek: «[MVO|LostFilm]», «[Dub|Red Head Sound]»
    brackets: { role: CREDIT_KINDS.STUDIO, pattern: /\[(?:Dub|MVO|DVO|AVO|VO)\s*\|([^\]]{2,60})\]/gi },
    // rutor/megapeer/noname: «от Jaskier», «от R.G. Механики» — здесь стоит тот, кто собрал
    // раздачу; студия перевода у этих трекеров живёт в поле после кода перевода.
    from: { role: CREDIT_KINDS.GROUP, pattern: /(?:^|[\s|(])от\s+([^\s|,()]+(?:\s+[^\s|,()]+)?)/gi },
    // bigfangroup: «… WEB-DL 1080p | Продубляж» — автор последним полем, часто обрезанным.
    tail: { role: CREDIT_KINDS.STUDIO, pattern: /\|\s*([^|]{2,40})\s*$/g },
    // rutor/megapeer: «| D | Red Head Sound», «| P2-ViruseProject» — поле сразу за кодом перевода.
    // Порядок альтернатив — от длинной к короткой: «P» перед «P2» съедает букву и ломает разбор.
    codeTail: { role: CREDIT_KINDS.STUDIO, pattern: /\|\s*(?:MVO|DVO|AVO|VO|Dub|P1|P2|L1|L2|D1|D2|D|P|L|A|O)\s*[-–|]\s*([^|]{2,40})/gi },
    // rutor: «WEB-DL-LostFilm», «WEBRip-AniFilm» — имя приклеено к тегу источника.
    dashTail: { role: CREDIT_KINDS.STUDIO, pattern: /(?:WEB-?DL|WEBRip|BDRip|HDRip|BDRemux|HDTV|DVDRip|AVC|HEVC|\d{3,4}p)[-–]([A-Za-zА-Яа-яЁё0-9][A-Za-z0-9А-Яа-яЁё._]{1,20})(?=[\s|[]|$)/gi }
};

var SLOTS_BY_MODE = {
    any: ['parens', 'brackets', 'from'],
    parens: ['parens', 'from'],
    brackets: ['brackets', 'parens'],
    from: ['from'],
    tail: ['tail', 'from'],
    // rutor и megapeer: студия — в поле за кодом перевода, релиз-группа — в «от X».
    codes: ['codeTail', 'tail', 'from', 'dashTail'],
    none: []
};

// То, что стоит в слоте автора, но именем не является: языки, пометки, коды перевода,
// технические теги и названия версий.
var NOT_A_CREDIT = {};
['rus', 'eng', 'ukr', 'jap', 'kor', 'chi', 'sub', 'subs', 'original', 'orig', 'int',
 'mvo', 'dvo', 'avo', 'vo', 'dub', 'dubbing', 'лицензия', 'оригинал', 'субтитры',
 'многоголосый', 'одноголосый', 'дубляж', 'озвучка', 'перевод',
 'd', 'p', 'l', 'a', 'o', 'p1', 'p2', 'l1', 'l2', 'd1', 'd2', 'р',
 'hevc', 'avc', 'dl', 'web', 'ts', 'sdr', 'hdr', 'dolbyvision', 'complete', 'official',
 'кпк', 'фильм', 'movie', 'чистый звук', 'расширенная версия', 'режиссёрская версия',
 'режиссерская версия', 'локализованный видеоряд', '60 fps'].forEach(function (word) {
    NOT_A_CREDIT[word] = true;
});

function cleanName(raw) {
    return String(raw)
        .replace(/…+\s*$/, '')
        // «P-Продубляж» — код перевода приклеен к имени: слот tail забирает поле целиком,
        // и без среза одна студия попадает в меню дважды, с кодом и без.
        .replace(/^(?:MVO|DVO|AVO|VO|Dub|[DPLAO][12]?)\s*[-–]\s*/i, '')
        .replace(/^[\s.+·]+|[\s.+·]+$/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function acceptable(name) {
    if (name.length < 2 || name.length > 40) return false;
    if (/^\d+$/.test(name)) return false;
    if (NOT_A_CREDIT[name.toLowerCase()]) return false;
    // «RePack от R.G. Механики» — это поле целиком, а не имя: имя из него достаёт слот «от X».
    // JS \b не образует границу перед кириллицей, поэтому для «от» задаём левый контекст явно.
    if (/(?:^|[^a-zа-яё0-9])от\s/i.test(name) || /^(?:repack|rip|релиз)\b/i.test(name)) return false;
    // У обрезанного bigfangroup последним полем нередко остаётся качество. Слот tail не должен
    // превращать «SDTV MPEG-2 MPG 2.0» или «WEB-DL 1080p» в имя студии.
    if (/(?:\b(?:bdremux|remux|blu-?ray|bdrip|web-?dl|webrip|hdtv|sdtv|dvdrip|hdrip|camrip|av1|hevc|avc|xvid|divx|mpeg-?2|mkv|mp4|mpe?g|webm|avi|flv|m2ts)\b|\b(?:2160|1080|720|480)p\b)/i.test(name)) return false;
    // «8|MVO» и подобные хвосты — это уже следующее поле заголовка, а не имя.
    return !/[|\]\[]/.test(name);
}

// Имя из слота может быть списком: «MVO (LostFilm, HDrezka, TVShows)».
function splitList(value) {
    return String(value).split(/[,;]|\s\+\s/);
}

// Возвращает { translators, releaseGroups }: кто перевёл и кто собрал. Разделение делает реестр,
// слот задаёт лишь роль по умолчанию для незнакомого имени.
export function extractCredits(source, profile) {
    var text = String(source || '');
    var found = [];
    var seen = {};

    function push(name, index, slotRole) {
        var cleaned = cleanName(name);
        if (!acceptable(cleaned)) return;
        var canonical = canonicalName(cleaned);
        var key = canonicalKey(canonical);
        if (seen[key]) return;
        seen[key] = true;
        found.push({ name: canonical, index: index, role: roleOf(canonical, slotRole) });
    }

    var mode = (profile && profile.studioSlots) || 'any';
    (SLOTS_BY_MODE[mode] || SLOTS_BY_MODE.any).forEach(function (name) {
        var slot = SLOTS[name];
        if (!slot) return;
        slot.pattern.lastIndex = 0;
        var match;
        while ((match = slot.pattern.exec(text))) {
            splitList(match[1]).forEach(function (part) { push(part, match.index, slot.role); });
            if (slot.pattern.lastIndex === match.index) slot.pattern.lastIndex++;
        }
    });

    // Известные имена ловим и вне слотов: часть трекеров пишет их просто в хвосте заголовка.
    // Роль здесь берётся только из реестра — слота, задающего умолчание, тут нет.
    knownPatterns().forEach(function (known) {
        var record = entryByKey(known.key);
        if (!record) return;
        var match = known.pattern.exec(text);
        if (!match) return;
        push(record.name, match.index, record.kind === CREDIT_KINDS.GROUP ? CREDIT_KINDS.GROUP : CREDIT_KINDS.STUDIO);
    });

    found.sort(function (left, right) { return left.index - right.index; });

    // «Stranik» из словаря и «Stranik 2.0» из слота — одно имя в двух написаниях: словарь ловит
    // короткую форму внутри длинной, и без этого обе стоят в меню рядом.
    found = found.filter(function (item) {
        var short = item.name.toLowerCase();
        return !found.some(function (other) {
            var long = other.name.toLowerCase();
            return other !== item && long.length > short.length && long.indexOf(short) >= 0;
        });
    });

    var translators = [];
    var releaseGroups = [];
    found.forEach(function (item) {
        if (item.role === CREDIT_KINDS.GROUP) releaseGroups.push(item.name);
        else translators.push(item.name);
    });

    // У аниме-трекеров студия — сам трекер: в заголовке её нет и искать нечего.
    if (!translators.length && profile && profile.studioDefault) translators.push(profile.studioDefault);
    return { translators: translators, releaseGroups: releaseGroups };
}
