// Год почти всегда есть в заголовке (84–100% на общих трекерах), но записан тремя разными
// синтаксисами: «[2025, Южная Корея, …]», «(2024)» и «| 2024 |». Замеры и разбор грамматик —
// docs/system-design/torrent-mod-search-architecture.md §1.2.

// Год, занимающий поле целиком: «2024», «2024 г.», «2011-2019».
var YEAR_FIELD = /^\s*((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)\d{2}))?\s*(?:г\.?|год[аов]*)?\s*$/;

// Запасной вариант: год отдельным словом. Отрицательный просмотр вперёд отсекает «1920x1080»
// и любое продолжение буквой или цифрой.
var YEAR_LOOSE = /(?:^|[\s,([])((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)\d{2}))?(?![\dxх×a-zA-Zа-яёА-ЯЁ])/;

function delimitedFields(source) {
    var fields = [];
    // Содержимое скобок трекеры пишут списком через запятую: «[2019, Китай, уся, HDTV]».
    source.replace(/\[([^\]]*)\]|\(([^)]*)\)/g, function (all, square, round) {
        var body = square === undefined ? round : square;
        String(body).split(',').forEach(function (part) { fields.push(part); });
        return all;
    });
    // ExKinoRay и rutor разделяют поля вертикальной чертой: «Ru | En | 2024 | WEB-DL».
    source.split('|').forEach(function (part) { fields.push(part); });
    return fields;
}

function result(from, confidence, first, second) {
    var value = parseInt(first, 10);
    var to = second ? parseInt(second, 10) : value;
    return { value: value, to: to, isRange: to > value, from: from, confidence: confidence };
}

export function parseYear(title) {
    var source = String(title || '');
    var fields = delimitedFields(source);

    for (var i = 0; i < fields.length; i++) {
        var delimited = YEAR_FIELD.exec(fields[i]);
        if (delimited) return result('delimited', 'high', delimited[1], delimited[2]);
    }

    var loose = YEAR_LOOSE.exec(source);
    if (loose) return result('loose', 'low', loose[1], loose[2]);

    return { value: null, to: null, isRange: false, from: 'absent', confidence: 'none' };
}

// Год у релиза и год у произведения совпадают, если пересекаются с допуском. Диапазон
// многолетнего пака покрывает год цели целиком — «Во все тяжкие (2008-2013)» подходит любому
// своему сезону.
export function yearMatches(releaseYear, targetYear, tolerance) {
    if (!releaseYear || releaseYear.value === null || !targetYear) return null;
    var slack = tolerance === undefined ? 1 : tolerance;
    return targetYear >= releaseYear.value - slack && targetYear <= releaseYear.to + slack;
}
