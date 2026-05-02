/* Test: PWA-Setup ist intakt — Manifest valide, Service Worker registriert,
 *  Icons sind erreichbar. Wir nutzen index.html (nicht den Bundle), weil
 *  PWA-Features nur unter http(s) laufen.
 */
'use strict';
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const APP_URL = process.env.PARALOX_URL || 'http://127.0.0.1:8080/index.html';
const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

let fails = 0;
function check(label, cond, detail) {
    const m = cond ? '✓' : '✗';
    console.log(`  ${m} ${label}${detail ? ': ' + detail : ''}`);
    if (!cond) fails++;
}

(async () => {
    // -------- 1. manifest.json strukturell valide --------
    console.log('\n=== manifest.json ===');
    const manifestPath = path.join(__dirname, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    check('Hat name', !!manifest.name, manifest.name);
    check('Hat short_name (für Home-Screen)', !!manifest.short_name);
    check('display=standalone', manifest.display === 'standalone');
    check('Hat start_url', !!manifest.start_url, manifest.start_url);
    check('Hat ≥ 1 Icon', Array.isArray(manifest.icons) && manifest.icons.length >= 1);
    const has192 = manifest.icons.some(i => i.sizes === '192x192');
    const has512 = manifest.icons.some(i => i.sizes === '512x512');
    check('Icon 192x192 ist gelistet', has192);
    check('Icon 512x512 ist gelistet', has512);
    check('icons/icon-192.png liegt auf der Disk',
        fs.existsSync(path.join(__dirname, 'icons', 'icon-192.png')));
    check('icons/icon-512.png liegt auf der Disk',
        fs.existsSync(path.join(__dirname, 'icons', 'icon-512.png')));

    // -------- 2. index.html bindet manifest + apple-touch-icon ein --------
    console.log('\n=== index.html PWA-Header ===');
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    check('<link rel="manifest"> vorhanden', /<link[^>]+rel=["\']manifest["\']/.test(html));
    check('<meta name="theme-color"> vorhanden', /<meta[^>]+name=["\']theme-color["\']/.test(html));
    check('<link rel="apple-touch-icon"> vorhanden',
        /<link[^>]+rel=["\']apple-touch-icon["\']/.test(html));
    check('Service-Worker-Registrierung im HTML',
        /navigator\.serviceWorker\.register\(/.test(html));

    // -------- 3. Im Browser: SW registriert sich + Manifest + Icons erreichbar --------
    console.log('\n=== Im Browser: Service Worker + Manifest + Icons ===');
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(1500);

    const swReady = await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return { supported: false };
        try {
            const reg = await navigator.serviceWorker.getRegistration();
            return { supported: true, hasReg: !!reg, scope: reg?.scope, active: !!reg?.active };
        } catch (e) { return { supported: true, error: e.message }; }
    });
    check('Service Worker wird vom Browser unterstützt', swReady.supported);
    check('Service-Worker-Registrierung erfolgreich',
        swReady.hasReg === true, swReady.scope || swReady.error || 'keine Registrierung');

    // Manifest und Icons via Browser-Fetch verifizieren — bestätigt dass alle
    // Pfade aus manifest.json korrekt aufgelöst werden.
    const manifestFetch = await page.evaluate(async () => {
        const r = await fetch('manifest.json');
        if (!r.ok) return { ok: false, status: r.status };
        const obj = await r.json();
        return { ok: true, name: obj.name, iconCount: obj.icons?.length };
    });
    check('manifest.json wird vom Browser korrekt geladen + geparst',
        manifestFetch.ok && manifestFetch.name === 'Paralox Stundenverwaltung',
        JSON.stringify(manifestFetch));

    const icon192 = await page.evaluate(async () => {
        const r = await fetch('icons/icon-192.png');
        return { ok: r.ok, status: r.status, type: r.headers.get('content-type') };
    });
    check('icons/icon-192.png ist via HTTP erreichbar (image/png)',
        icon192.ok && /image\/png/.test(icon192.type || ''), JSON.stringify(icon192));

    const icon512 = await page.evaluate(async () => {
        const r = await fetch('icons/icon-512.png');
        return { ok: r.ok, status: r.status, type: r.headers.get('content-type') };
    });
    check('icons/icon-512.png ist via HTTP erreichbar (image/png)',
        icon512.ok && /image\/png/.test(icon512.type || ''), JSON.stringify(icon512));

    // SW-Cache: nach kurzer Wartezeit sollten die App-Shell-Dateien gecached sein.
    const cacheKeys = await page.evaluate(async () => {
        if (!('caches' in window)) return null;
        const names = await caches.keys();
        if (!names.length) return [];
        const c = await caches.open(names[0]);
        const reqs = await c.keys();
        return reqs.map(r => new URL(r.url).pathname);
    });
    check('Service Worker hat einen Cache angelegt', Array.isArray(cacheKeys));
    check('Cache enthält index.html oder Stamm-Pfad',
        cacheKeys && cacheKeys.some(p => p.endsWith('/') || p.endsWith('/index.html')),
        (cacheKeys || []).join(', '));
    check('Cache enthält app.js',
        cacheKeys && cacheKeys.some(p => p.endsWith('/app.js')));
    check('Cache enthält icons/icon-192.png',
        cacheKeys && cacheKeys.some(p => p.endsWith('/icons/icon-192.png')));

    await browser.close();

    console.log('\n' + (fails === 0
        ? '✓ ALLE PWA-SETUP-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
