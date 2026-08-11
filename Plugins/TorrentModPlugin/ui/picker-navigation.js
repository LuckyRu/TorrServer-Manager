export function pickerNavigationWindow(order, focusId, radius) {
    var ids = Array.isArray(order) ? order : [];
    var distance = Math.max(1, Number(radius) || 1);
    if (ids.length <= distance * 2) return ids.slice();
    var index = ids.indexOf(focusId);
    if (index < 0) index = 0;
    var start = Math.max(0, index - distance);
    var end = Math.min(ids.length, index + distance + 1);
    return ids.slice(start, end);
}

export function adjacentPickerId(order, focusId, direction) {
    var ids = Array.isArray(order) ? order : [];
    if (!ids.length) return null;
    var index = ids.indexOf(focusId);
    if (index < 0) index = 0;
    var next = direction === 'up' ? index - 1 : index + 1;
    return next >= 0 && next < ids.length ? ids[next] : null;
}
