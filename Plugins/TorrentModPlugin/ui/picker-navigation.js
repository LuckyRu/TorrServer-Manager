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

export function replacementPickerId(previousOrder, nextOrder, focusId, preferredId) {
    var before = Array.isArray(previousOrder) ? previousOrder : [];
    var after = Array.isArray(nextOrder) ? nextOrder : [];
    if (!after.length) return null;
    if (focusId && after.indexOf(focusId) >= 0) return focusId;
    if (preferredId && after.indexOf(preferredId) >= 0) return preferredId;
    var oldIndex = before.indexOf(focusId);
    if (oldIndex < 0) oldIndex = 0;
    return after[Math.min(oldIndex, after.length - 1)];
}
