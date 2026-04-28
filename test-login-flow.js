/* End-to-End-Test des OneDrive-Login-Flows.
 *
 * Lädt die App im echten Chrome und simuliert den vollen Flow:
 *  1. Seite lädt ohne Fehler
 *  2. MSAL und ParaloxDrive sind verfügbar
 *  3. Klick auf den Banner → Navigation zu login.microsoftonline.com
 *  4. Auth-URL hat alle korrekten OAuth-Parameter
 *  5. Wir simulieren die Antwort von Microsoft (?code=fake&state=...)
 *     und prüfen, dass handleRedirectPromise() die Antwort verarbeitet OHNE
 *     erneut zu Microsoft zu redirecten (= keine Schleife)
 */
'use strict';
const { chromium } = require('playwright-core');

const APP_URL = process.env.PARALOX_URL || 'http://127.0.0.1:8080/paralox-stunden.html';
const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

let exitCode = 0;
function check(label, cond, detail) {
    const mark = cond ? '✓' : '✗';
    console.log(`  ${mark} ${label}${detail ? ': ' + detail : ''}`);
    if (!cond) exitCode = 1;
}

(async () => {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    const consoleErrors = [];
    const consoleAll = [];
    page.on('console', msg => {
        const text = `${msg.type()}: ${msg.text()}`;
        consoleAll.push(text);
        if (msg.type() === 'error') consoleErrors.push(text);
    });
    page.on('pageerror', err => consoleErrors.push('UNCAUGHT: ' + err.message));

    // Externe Navigation (zu login.microsoftonline.com) abfangen statt zuzulassen
    let interceptedAuthUrl = null;
    let externalRedirectCount = 0;
    await context.route('**/*', async (route) => {
        const url = route.request().url();
        // Microsoft Login-URL abfangen
        if (url.startsWith('https://login.microsoftonline.com/') ||
            url.startsWith('https://login.live.com/')) {
            externalRedirectCount++;
            if (!interceptedAuthUrl) interceptedAuthUrl = url;
            // Mit "abort" verhindern wir die echte Navigation
            await route.abort();
            return;
        }
        await route.continue();
    });

    // 1. Seite laden
    console.log('1) Lade ' + APP_URL);
    let loadErr = null;
    try {
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
    } catch (e) {
        loadErr = e.message;
    }
    check('Seite geladen', !loadErr, loadErr || '');

    // 2. JS-Fehler prüfen
    console.log('2) JS-Fehler');
    check('Keine JS-Fehler', consoleErrors.length === 0,
        consoleErrors.length ? '\n      ' + consoleErrors.join('\n      ') : '');

    // 3. Bibliotheken
    console.log('3) Bibliotheken');
    await page.waitForTimeout(2500);
    const libs = await page.evaluate(() => ({
        msal: typeof window.msal,
        msalCtor: typeof (window.msal && window.msal.PublicClientApplication),
        paralox: typeof window.ParaloxDrive,
        bcrypt: typeof (window.bcrypt || (window.dcodeIO && window.dcodeIO.bcrypt)),
    }));
    check('window.msal vorhanden', libs.msal === 'object');
    check('PublicClientApplication ist Funktion', libs.msalCtor === 'function');
    check('window.ParaloxDrive vorhanden', libs.paralox === 'object');
    check('bcrypt geladen', libs.bcrypt === 'object');

    // 4. UI-Elemente
    console.log('4) UI-Elemente');
    const ui = await page.evaluate(() => ({
        statusText: document.getElementById('driveStatus')?.textContent?.trim(),
        statusClass: document.getElementById('driveStatus')?.className,
        bannerText: document.getElementById('driveAlt')?.textContent?.trim(),
        loginFormVisible: !document.getElementById('view-login')?.classList.contains('hidden'),
    }));
    check('driveStatus zeigt Tipp-zum-Verbinden', /tippen|connect/i.test(ui.statusText) || /\bOneDrive\b/.test(ui.statusText), `text="${ui.statusText}"`);
    check('Banner sichtbar mit Verbindungstext', /verbinden|onedrive/i.test(ui.bannerText || ''), `text="${ui.bannerText}"`);
    check('Login-View ist sichtbar', ui.loginFormVisible);

    // 5. Klick auf den Banner — externe Navigation abgefangen
    console.log('5) Klick auf Banner-Link → Auth-URL abfangen');
    interceptedAuthUrl = null;
    externalRedirectCount = 0;

    // page.click navigiert intern und kann den Test killen, deshalb evaluate
    await page.evaluate(() => {
        document.getElementById('driveAltLink').click();
    });
    // Warten bis route abort gefeuert hat (oder Timeout)
    for (let i = 0; i < 50 && !interceptedAuthUrl; i++) {
        await new Promise(r => setTimeout(r, 100));
    }

    check('Klick löst Navigation zu Microsoft aus', !!interceptedAuthUrl,
        interceptedAuthUrl ? interceptedAuthUrl.slice(0, 120) + '...' : 'KEINE Navigation');
    check('Nur EINE Navigation (keine Loop-Indikation)', externalRedirectCount === 1,
        `count=${externalRedirectCount}`);

    if (interceptedAuthUrl) {
        // 6. Auth-URL inhaltlich prüfen
        console.log('6) Auth-URL-Parameter');
        const u = new URL(interceptedAuthUrl);
        const p = u.searchParams;
        check('Host = login.microsoftonline.com', u.host === 'login.microsoftonline.com', u.host);
        check('Pfad enthält /organizations/', u.pathname.includes('/organizations/'), u.pathname);
        check('client_id korrekt', p.get('client_id') === '6a526d81-91a0-4114-9219-776be6d5a560', p.get('client_id'));
        check('response_type=code (Auth-Code-Flow)', p.get('response_type') === 'code', p.get('response_type'));
        check('code_challenge vorhanden (PKCE)', !!p.get('code_challenge'), p.get('code_challenge')?.slice(0, 20));
        check('code_challenge_method=S256', p.get('code_challenge_method') === 'S256', p.get('code_challenge_method'));
        check('scope enthält Files.ReadWrite', (p.get('scope') || '').includes('Files.ReadWrite'), p.get('scope'));
        check('redirect_uri stimmt mit Aufruf-URL', p.get('redirect_uri') === APP_URL, p.get('redirect_uri'));
        check('state ist gesetzt', !!p.get('state'));
        check('NICHT login.live.com (consumer-Endpoint)', u.host !== 'login.live.com');
    }

    // 7. Simulierte Microsoft-Antwort: code-Parameter in URL → handleRedirectPromise sollte
    //    OHNE neue Navigation arbeiten (= keine Schleife). Wir verwenden einen ungültigen Code,
    //    der einen MSAL-Fehler auslöst — aber NICHT zu erneutem Microsoft-Redirect führen darf.
    console.log('7) Simulierte Rückkehr von Microsoft (ungültiger Code)');

    // Echten state aus sessionStorage lesen, damit MSAL den Versuch nicht direkt
    // wegen state-mismatch verwirft, sondern weiter geht (Code-Tausch fehlschlagen lassen)
    const stateFromAuth = interceptedAuthUrl
        ? new URL(interceptedAuthUrl).searchParams.get('state') || 'fake'
        : 'fake';
    const fakeReturn = APP_URL + '?code=fake-code-123&state=' + encodeURIComponent(stateFromAuth) + '&client_info=fake';

    // Counter erst NACH der state-Erfassung resetten
    interceptedAuthUrl = null;
    externalRedirectCount = 0;
    try {
        await page.goto(fakeReturn, { waitUntil: 'networkidle', timeout: 10000 });
    } catch (e) {
        console.log('  (goto-Fehler bei Simulationsantwort: ' + e.message + ')');
    }
    await page.waitForTimeout(3000);
    check('Keine erneute Navigation zu Microsoft (= keine Loop)', externalRedirectCount === 0,
        `count=${externalRedirectCount}`);

    // 8. Konsole für Diagnose
    if (process.env.DEBUG_CONSOLE) {
        console.log('\n--- Konsolen-Log ---');
        consoleAll.slice(-30).forEach(l => console.log('  ' + l));
    }

    await browser.close();
    console.log('\n' + (exitCode === 0 ? '✓ ALLE TESTS BESTANDEN' : '✗ TESTS FEHLGESCHLAGEN'));
    process.exit(exitCode);
})().catch(e => {
    console.error('Test-Skript-Fehler:', e);
    process.exit(2);
});
