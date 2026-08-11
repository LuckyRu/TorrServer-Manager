export function resolveContentRightIntent(state) {
    if (state && state.episodeFocused) return 'picker';
    if (state && state.candidateFocused && state.filterAvailable) return 'filter';
    return 'move-right';
}

export function resolvePickerRightIntent(state) {
    return state && state.filterAvailable ? 'filter-after-close' : 'close';
}
