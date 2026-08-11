import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { pickerNavigationWindow, adjacentPickerId } from '../ui/picker-navigation.js';

const appData = process.env.LOCALAPPDATA || '';
const navigatorPath = process.env.LAMPA_NAVIGATOR_PATH || join(appData, 'TorrServer', 'lampa-app', 'vender', 'navigator', 'navigator.js');

if (!existsSync(navigatorPath)) {
    console.log('Lampa navigation: skipped, navigator.js not found');
    process.exit(0);
}

const context = vm.createContext({ console });
const source = readFileSync(navigatorPath, 'utf8');
vm.runInContext(source + '\nthis.__navigator = Navigator;', context, { filename: navigatorPath });
const navigator = context.__navigator;

const ids = Array.from({ length: 100 }, (_, index) => 'item-' + index);
const elements = new Map(ids.map((id, index) => [id, {
    id,
    getBoundingClientRect() {
        return { left: 0, top: index * 90, width: 800, height: 84 };
    }
}]));

let focusedId = null;
navigator.follow('focus', (event) => { focusedId = event.elem.id; });

function focusWindow(id) {
    const collection = pickerNavigationWindow(ids, id, 36).map((itemId) => elements.get(itemId));
    if (collection.length > 73) throw new Error('bounded collection выросла до ' + collection.length + ' элементов');
    navigator.setCollection(collection);
    if (!navigator.focus(elements.get(id))) throw new Error('Lampa Navigator не сфокусировал ' + id);
}

focusWindow(ids[0]);
for (let expected = 1; expected < ids.length; expected++) {
    if (navigator.canmove('down')) navigator.move('down');
    else focusWindow(adjacentPickerId(ids, focusedId, 'down'));
    if (focusedId !== ids[expected]) throw new Error('down: ожидался ' + ids[expected] + ', получен ' + focusedId);
}

for (let expected = ids.length - 2; expected >= 0; expected--) {
    if (navigator.canmove('up')) navigator.move('up');
    else focusWindow(adjacentPickerId(ids, focusedId, 'up'));
    if (focusedId !== ids[expected]) throw new Error('up: ожидался ' + ids[expected] + ', получен ' + focusedId);
}

console.log('Lampa navigation: 198 переходов через bounded collection passed');
