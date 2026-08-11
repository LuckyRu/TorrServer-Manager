export function reconcileKeyedChildren(container, desiredNodes) {
    if (!container) return 0;
    var desired = Array.isArray(desiredNodes) ? desiredNodes : [];
    var mutations = 0;

    desired.forEach(function (node, index) {
        var current = container.children[index] || null;
        if (current === node) return;
        container.insertBefore(node, current);
        mutations++;
    });

    while (container.children.length > desired.length) {
        container.removeChild(container.children[container.children.length - 1]);
        mutations++;
    }
    return mutations;
}
