import { chromium } from 'playwright';

const BASE = process.env.TORRENT_MOD_E2E_URL || 'http://192.168.10.108:8095';
const CARD_URL = BASE + '/app/?card=615&media=tv&source=tmdb&select=open';

const MOCK_SEARCH_RESULTS = [
    {
        Title: 'Футурама / Futurama S02E07 1080p WEB-DL',
        Tracker: 'RuTracker', Size: 2500000000, Seeders: 12, Peers: 6,
        MagnetUri: 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        PublishDate: '2026-08-01T00:00:00Z'
    },
    {
        Title: 'Футурама / Futurama (2008-2013) BDRip (S1-5E1-62 of 62)',
        Tracker: 'NoNaMe', Size: 120000000000, Seeders: 30, Peers: 10,
        MagnetUri: 'magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        PublishDate: '2026-08-01T00:00:00Z'
    }
];

const RELEVANT_ERROR = /(ReferenceError|TypeError|Component create error|torrent.?mod)/i;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push('PAGEERROR: ' + err.message));

try {
    await page.addInitScript((base) => {
        localStorage.setItem('language', 'ru');
        localStorage.setItem('plugins', JSON.stringify([{ url: base + '/lampa.js', status: true }]));
    }, BASE);

    await page.route('**/api/torrent-search/start*', (route) => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ jobId: 'e2e-job', totalIndexers: 1, indexers: [{ id: 'mock', name: 'mock' }] })
    }));
    await page.route('**/api/torrent-search/poll*', (route) => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ done: true, indexers: [{ id: 'mock', name: 'mock', ok: true, error: null, elapsedMs: 5, results: MOCK_SEARCH_RESULTS }] })
    }));
    await page.route('**/api/torrent-search/cancel*', (route) => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true })
    }));

    console.log('E2E: открываю ' + CARD_URL);
    await page.goto(CARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log('E2E: жду кнопку Torrent Mod на карточке…');
    await page.waitForSelector('.view--torrent-mod', { state: 'attached', timeout: 60000 });
    await page.locator('.view--torrent-mod').dispatchEvent('hover:enter');

    console.log('E2E: жду экран серий…');
    await page.waitForSelector('.torrent-mod__list .torrent-mod-row', { timeout: 30000 });
    await page.waitForTimeout(4000); // дать пулу прийти (бейджи)

    const rows = await page.locator('.torrent-mod__list .torrent-mod-row').count();
    const hasStatus = await page.locator('.torrent-mod__status').count();
    console.log('E2E: серий в списке: ' + rows + ', статус-строка: ' + (hasStatus ? 'есть' : 'нет'));

    if (rows === 0) throw new Error('экран серий пуст — вероятно nocomponent');
    if (hasStatus === 0) throw new Error('нет статус-строки');

    await page.locator('.torrent-mod__list .torrent-mod-row').first().dispatchEvent('hover:enter');
    await page.waitForTimeout(2000);

    const relevant = consoleErrors.filter((e) => RELEVANT_ERROR.test(e));
    if (relevant.length) {
        console.error('E2E: ошибки Torrent Mod в консоли:');
        relevant.forEach((e) => console.error('  - ' + e.slice(0, 300)));
        throw new Error('найдены runtime-ошибки плагина');
    }

    console.log('E2E OK: экран серий отрендерился, runtime-ошибок плагина нет.');
    await page.screenshot({ path: 'e2e-screenshot.png', fullPage: false });
} finally {
    await browser.close();
}
