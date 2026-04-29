/* Smoke-Test für den Lokal-Modus (OneDrive-Sync deaktiviert):
 *  1. App lädt ohne JS-Fehler
 *  2. KEIN MSAL geladen, KEIN ParaloxDrive vorhanden
 *  3. OneDrive-UI (driveStatus, driveAlt) ist nicht sichtbar
 *  4. Login mit Owner1/PIN funktioniert
 *  5. Daten landen in localStorage
 *  6. Reload behält die Sitzung/Daten (lokale Persistenz)
 */
'use strict';
const { chromium } = require('playwright-core');

const APP_URL = process.env.PARALOX_URL || 'http://127.0.0.1:8080/paralox-stunden.html';
const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

let fails = 0;
function check(label, cond, detail) {
    const m = cond ? '✓' : '✗';
    console.log(`  ${m} ${label}${detail ? ': ' + detail : ''}`);
    if (!cond) fails++;
}

(async () => {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', m => {
        if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', e => consoleErrors.push('UNCAUGHT: ' + e.message));

    // Microsoft-Endpunkte dürfen NIE angefragt werden
    let msRequests = 0;
    await context.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.includes('login.microsoftonline.com') ||
            url.includes('login.live.com') ||
            url.includes('graph.microsoft.com')) {
            msRequests++;
            return route.abort();
        }
        return route.continue();
    });

    console.log('1) Seite laden');
    let loadErr = null;
    try {
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
    } catch (e) { loadErr = e.message; }
    check('Seite geladen', !loadErr, loadErr || '');
    await page.waitForTimeout(1500);

    console.log('2) Keine JS-Fehler');
    check('Konsole sauber', consoleErrors.length === 0,
        consoleErrors.slice(0, 3).join(' | '));

    console.log('3) Kein OneDrive-Code geladen');
    const env = await page.evaluate(() => ({
        msal: typeof window.msal,
        paraloxDrive: typeof window.ParaloxDrive,
        paraloxStorage: typeof window.ParaloxStorage,
    }));
    check('window.msal NICHT vorhanden', env.msal === 'undefined', `typeof=${env.msal}`);
    check('window.ParaloxDrive NICHT vorhanden', env.paraloxDrive === 'undefined',
        `typeof=${env.paraloxDrive}`);
    check('window.ParaloxStorage vorhanden', env.paraloxStorage === 'object',
        `typeof=${env.paraloxStorage}`);

    console.log('4) Keine Microsoft-Requests');
    check('Null Anfragen an MS-Domains', msRequests === 0, 'count=' + msRequests);

    console.log('5) OneDrive-UI nicht sichtbar');
    const ui = await page.evaluate(() => {
        const status = document.getElementById('driveStatus');
        const banner = document.getElementById('driveAlt');
        const wrap = document.getElementById('driveStatusWrap');
        const visible = el => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return r.width > 0 && r.height > 0 &&
                cs.display !== 'none' && cs.visibility !== 'hidden';
        };
        return {
            statusVisible: visible(status),
            wrapVisible: visible(wrap),
            bannerVisible: visible(banner),
            statusInDom: !!status,
            bannerInDom: !!banner,
        };
    });
    check('driveStatus existiert im DOM (für spätere Reaktivierung)', ui.statusInDom);
    check('driveAlt existiert im DOM (für spätere Reaktivierung)', ui.bannerInDom);
    check('driveStatusWrap NICHT sichtbar', !ui.wrapVisible);
    check('driveAlt NICHT sichtbar', !ui.bannerVisible);

    console.log('6) Login mit Owner1 (Initial-Passwort "paralox")');
    // Login-Form muss sichtbar sein
    const loginVisible = await page.evaluate(() =>
        !document.getElementById('view-login').classList.contains('hidden'));
    check('Login-Formular sichtbar', loginVisible);

    // Wir kennen die User aus test-server.js: Owner1/Owner2 mit PIN 1234
    const loginResult = await page.evaluate(async () => {
        const sel = document.getElementById('loginName');
        const pin = document.getElementById('loginPassword');
        if (!sel || !pin) return { ok: false, reason: 'Form-Elemente fehlen' };
        // Owner1 wählen
        const owner1Opt = Array.from(sel.options).find(o => o.textContent === 'Owner1');
        if (!owner1Opt) return { ok: false, reason: 'Owner1 nicht im Select', options: Array.from(sel.options).map(o => o.textContent) };
        sel.value = owner1Opt.value;
        pin.value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        await new Promise(r => setTimeout(r, 500));
        const loginHidden = document.getElementById('view-login').classList.contains('hidden');
        const userName = document.getElementById('userName')?.textContent || '';
        const errVisible = !document.getElementById('loginError')?.classList.contains('hidden');
        const errText = document.getElementById('loginError')?.textContent || '';
        return { ok: loginHidden, userName, errVisible, errText };
    });
    check('Login erfolgreich (Login-View ausgeblendet)',
        loginResult.ok, JSON.stringify(loginResult));
    check('Eingeloggt als Owner1', /Owner1/.test(loginResult.userName || ''),
        loginResult.userName);

    console.log('7) Daten in localStorage');
    const lsKeys = await page.evaluate(() => Object.keys(localStorage));
    check('paraloxStunden.v1 in localStorage', lsKeys.includes('paraloxStunden.v1'),
        JSON.stringify(lsKeys));
    check('Keine msal.*-Keys in localStorage',
        !lsKeys.some(k => k.startsWith('msal')),
        JSON.stringify(lsKeys.filter(k => k.startsWith('msal'))));

    console.log('8) Reload — Lokale Persistenz');
    await page.reload({ waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(1500);
    const afterReload = await page.evaluate(() => ({
        keys: Object.keys(localStorage),
        loginViewHidden: document.getElementById('view-login').classList.contains('hidden'),
    }));
    check('localStorage hat paraloxStunden.v1 nach Reload',
        afterReload.keys.includes('paraloxStunden.v1'));

    await browser.close();
    console.log('\n' + (fails === 0
        ? '✓ ALLE LOKAL-MODUS-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('Test-Skript-Fehler:', e); process.exit(2); });
