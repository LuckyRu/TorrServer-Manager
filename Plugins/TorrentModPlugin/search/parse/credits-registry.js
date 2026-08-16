// Реестр авторов раздачи. Роли две и смешивать их нельзя: студия перевода озвучивает, релиз-группа
// собирает и заливает раздачу. На живой выдаче rutor слот «от X» — это релиз-группа в 25 именах из
// 28, и до разделения все они попадали в меню «Студия» вперемешку с LostFilm и Red Head Sound.
// Роль решает реестр, а не слот: слот даёт лишь роль по умолчанию (docs/reference/
// torrent-mod-tracker-formats.md §1.5).
//
// Метаданные (тип перевода, мат, рейтинг, голоса) — необязательные. Встроенными приходят только
// те, что являются определяющим свойством студии; рейтинг и голоса задаются пользователем в
// search-rules.json, встроенных значений у них нет намеренно: выдумывать оценку нельзя.

var KIND_STUDIO = 'studio';
var KIND_GROUP = 'group';
var KIND_BOTH = 'both';

// [имя, тип перевода, метаданные]. Тип перевода пуст, если студия работает в разных форматах.
var STUDIOS = [
    ['LostFilm', 'Многоголосый'],
    ['NewStudio', 'Многоголосый'],
    ['AlexFilm', 'Многоголосый'],
    ['ColdFilm', 'Многоголосый'],
    ['TVShows', 'Многоголосый'],
    ['ViruseProject', 'Многоголосый'],
    ['FocusStudio', 'Многоголосый'],
    ['Jetvis Studio', 'Многоголосый'],
    ['HDrezka', 'Многоголосый'],
    ['SunnySiders', 'Многоголосый'],
    ['StudioBand', 'Многоголосый'],
    ['Студийная Банда', 'Многоголосый'],
    ['Кубик в Кубе', 'Многоголосый', { profanity: true }],
    ['Кураж-Бамбей', 'Одноголосый'],
    ['Red Head Sound', 'Дубляж'],
    ['Пифагор', 'Дубляж'],
    ['Novamedia', 'Дубляж'],
    ['Amedia', 'Дубляж'],
    ['Movie Dubbing', 'Дубляж'],
    ['Невафильм', 'Дубляж'],
    ['Мосфильм-Мастер', 'Дубляж'],
    ['Продубляж', 'Дубляж'],
    ['SkySound', ''],
    ['FreedomDub', ''],
    ['Wednesday Films', ''],
    ['RuDub', ''],
    ['ПКино', ''],
    ['ProFilms', ''],
    ['Vodnerilo', ''],
    ['Videofilm Int.', ''],
    ['WinMedia', ''],
    ['WStudio', ''],
    ['LE-Production', ''],
    ['Leff Sound', ''],
    ['Force Media', ''],
    ['Paragraph Media', ''],
    ['Condor Films Studio', ''],
    ['Lucky Production', ''],
    ['MovieDalen', ''],
    ['Syncmer', ''],
    ['Марафон', ''],
    ['Смотри кино', ''],
    ['ЗаКАДРЫ', ''],
    ['Так Треба Продакшн', ''],
    ['Тайм Медиа Групп', ''],
    ['1Win Studio', ''],
    ['FoxCrime', ''],
    ['Кравец', ''],
    ['Tycoon', ''],
    ['PashaUp', ''],
    ['SunshineStudio', ''],
    ['DEEP Ent', ''],
    // Авторский перевод — одна студия из одного человека; тип перевода тут определяющий.
    ['Гоблин', 'Одноголосый', { profanity: true }],
    ['GoblinRUS', 'Одноголосый', { profanity: true }],
    ['Ю. Сербин', 'Одноголосый'],
    ['Л. Володарский', 'Одноголосый'],
    ['А. Михалёв', 'Одноголосый'],
    ['В. Белов', 'Одноголосый'],
    ['Яроцкий', 'Одноголосый'],
    // Аниме: у своих раздач студия совпадает с трекером, но их озвучки встречаются и на общих.
    ['AniLibria', 'Многоголосый'],
    ['AniDUB', 'Многоголосый'],
    ['AniFilm', 'Многоголосый'],
    ['AniPlague', 'Многоголосый'],
    ['Persona99', 'Многоголосый'],
    ['AkariGroup', 'Многоголосый'],
    ['SoftBox', 'Многоголосый'],
    ['KANSAI', 'Многоголосый'],
    // Площадка, а не студия, но в заголовке стоит на месте студии и означает официальный перевод.
    ['iTunes', '', { official: true }],
    ['Netflix', '', { official: true }],
    ['Wakanim', '', { official: true }],
    ['Crunchyroll', '', { official: true }],
    ['Кинопоиск HD', '', { official: true }],
    ['ОККО', '', { official: true }]
];

// Релиз-группы: собирают и заливают, перевод берут чужой. Сняты со слота «от X» живой выдачи
// rutor и megapeer.
var GROUPS = [
    'Scarabey', 'ELEKTRI4KA', 'DoMiNo', 'Deadmauvlad', 'Generalfilm', 'MegaPeer', 'FortunaTV',
    'ExKinoRay', 'селезень', 'Stranik', 'NNNB', 'EniaHD', 'Kerob', 'Buka63', 'KORSARS',
    'Mr. Fox', 'HEVC-CLUB', 'OlLanDGroup', 'RIPS CLUB', 'DZgas', 'HQCLUB', 'MediaClub', 'FassaD',
    'SOFCJ', 'R.G. Механики', 'R.G. HD-Films', 'R.G. Catalyst', 'Fenixx'
];

// Одно имя в двух ролях: команда и озвучивает, и собирает раздачи. Роль решает слот, в котором
// имя встретилось: «от New-Team» — релиз, «MVO (New-Team)» — перевод.
var BOTH = ['Jaskier', 'New-Team', 'NewComers'];

var ALIASES = {
    'RHS': 'Red Head Sound',
    'HDRezka Studio': 'HDrezka',
    'Новамедиа': 'Novamedia',
    'Амедиа': 'Amedia',
    'Сербин': 'Ю. Сербин',
    'Володарский': 'Л. Володарский',
    'Михалёв': 'А. Михалёв',
    'Пучков': 'Гоблин',
    'КинопоискHD': 'Кинопоиск HD',
    'AniLiberty': 'AniLibria',
    'Kubik': 'Кубик в Кубе'
};

function wordPattern(word) {
    var pattern = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s_-]+/g, '[\\s._-]+');
    return new RegExp('(?:^|[^a-zа-яё0-9])' + pattern + '(?:[^a-zа-яё0-9]|$)', 'i');
}

// «HDRezka Studio» и «HDrezka» — одно имя. Сравниваем по буквам и цифрам без регистра,
// отбрасывая родовое слово в хвосте: его пишут через раз.
export function canonicalKey(name) {
    return String(name)
        .toLowerCase()
        .replace(/[^a-zа-яё0-9]+/g, '')
        .replace(/(?:studios?|студи[яи]|team|records|group)$/, '');
}

var entries = {};          // canonicalKey → запись реестра
var byName = {};           // написание в нижнем регистре → canonicalKey
var patterns = [];         // словарный проход по всему заголовку

function keyOf(name) {
    return byName[String(name).toLowerCase()] || canonicalKey(name);
}

function put(name, kind, meta) {
    var key = canonicalKey(name);
    var existing = entries[key];
    var record = existing || { name: name, kind: kind, voice: '', official: false, profanity: null, rating: null, votes: null };
    record.name = name;
    record.kind = kind || record.kind;
    if (meta) {
        if (meta.voice !== undefined && meta.voice !== null && meta.voice !== '') record.voice = meta.voice;
        if (meta.official !== undefined && meta.official !== null) record.official = !!meta.official;
        if (meta.profanity !== undefined && meta.profanity !== null) record.profanity = !!meta.profanity;
        if (typeof meta.rating === 'number') record.rating = meta.rating;
        if (typeof meta.votes === 'number') record.votes = meta.votes;
    }
    entries[key] = record;
    byName[name.toLowerCase()] = key;
    if (!existing) patterns.push({ key: key, pattern: wordPattern(name) });
    return record;
}

function alias(text, target) {
    var key = keyOf(target);
    if (!entries[key]) return;
    byName[String(text).toLowerCase()] = key;
    if (canonicalKey(text) !== key) byName[canonicalKey(text)] = key;
    patterns.push({ key: key, pattern: wordPattern(text) });
}

function seed() {
    STUDIOS.forEach(function (row) {
        var meta = row[2] || {};
        put(row[0], KIND_STUDIO, { voice: row[1], official: meta.official, profanity: meta.profanity });
    });
    GROUPS.forEach(function (name) { put(name, KIND_GROUP, null); });
    BOTH.forEach(function (name) { put(name, KIND_BOTH, null); });
    Object.keys(ALIASES).forEach(function (text) { alias(text, ALIASES[text]); });
}
seed();

// Запись реестра по любому написанию имени, либо null для неизвестного.
export function creditInfo(name) {
    if (!name) return null;
    var key = keyOf(name);
    return entries[key] || entries[canonicalKey(name)] || null;
}

export function canonicalName(name) {
    var record = creditInfo(name);
    return record ? record.name : name;
}

// Роль имени с учётом роли слота, в котором оно встретилось. Неизвестное имя остаётся при роли
// слота — это и делает файл правил необязательным, а не обязательным.
export function roleOf(name, slotRole) {
    var record = creditInfo(name);
    if (!record) return slotRole;
    if (record.kind === KIND_BOTH) return slotRole;
    return record.kind;
}

export function knownPatterns() {
    return patterns;
}

export function entryByKey(key) {
    return entries[key] || null;
}

// Оверлей из search-rules.json. Секция задаёт роль: studios → студии перевода, releaseGroups →
// релиз-группы. Пользовательская запись может добавить написания, метаданные или отключить
// встроенное имя целиком.
export function registerCredits(rules, kind) {
    (rules || []).forEach(function (rule) {
        var name = String((rule && rule.name) || '').trim();
        if (!name) return;
        var key = canonicalKey(name);
        if (rule.disabled) {
            delete entries[key];
            patterns = patterns.filter(function (known) { return known.key !== key; });
            Object.keys(byName).forEach(function (text) { if (byName[text] === key) delete byName[text]; });
            return;
        }
        put(name, rule.kind || kind || KIND_STUDIO, rule);
        (rule.aliases || []).forEach(function (text) {
            if (String(text || '').trim()) alias(String(text).trim(), name);
        });
    });
}

// Только для тестов: возвращает реестр к встроенному состоянию.
export function resetCredits() {
    entries = {};
    byName = {};
    patterns = [];
    seed();
}

export var CREDIT_KINDS = { STUDIO: KIND_STUDIO, GROUP: KIND_GROUP, BOTH: KIND_BOTH };
