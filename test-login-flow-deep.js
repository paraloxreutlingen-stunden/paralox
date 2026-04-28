/* Vertiefte E2E-Tests des MSAL-Login-Flows.
 *
 * Anders als test-login-flow.js: hier wird Microsoft realistisch gemockt
 * (Authorize-Endpoint redirected zurück mit Antwort, Token-Endpoint gibt
 * Fake-Antworten), so dass handleRedirectPromise den vollen Pfad durchläuft.
 *
 * Damit lässt sich eine echte Schleife (App ruft loginRedirect erneut auf,
 * obwohl Microsoft schon geantwortet hat) zuverlässig erkennen.
 *
 * Szenarien:
 *  A) Authorize → 302 mit ?error=access_denied  (User cancelt bei Microsoft)
 *  B) Authorize → 302 mit ?code=...&state=...   (Token-Endpoint failt)
 *  C) Authorize → 302 mit ?code=...&state=...   (Token-Endpoint liefert
 *     glaubwürdige Antwort mit gültigem id_token-Header → MSAL akzeptiert
 *     mindestens Account-Erstellung; danach prüfen, dass KEIN erneuter
 *     Redirect zu Microsoft passiert)
 *  D) Reload der App nach erfolgreichem Login: kein Auto-Redirect
 *  E) Reload der App mit altem ?code=... in URL: kein Auto-Redirect
 */
'use strict';
const { chromium } = require('playwright-core');
const crypto = require('crypto');

const APP_URL = process.env.PARALOX_URL || 'http://127.0.0.1:8080/paralox-stunden.html';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

let totalFails = 0;
function group(name) { console.log('\n=== ' + name + ' ==='); }
function check(label, cond, detail) {
    const mark = cond ? '✓' : '✗';
    console.log(`  ${mark} ${label}${detail ? ': ' + detail : ''}`);
    if (!cond) totalFails++;
    return cond;
}

function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Glaubwürdiges JWT-id_token (HS256, aber MSAL prüft idR nur Struktur, nicht Signatur,
// weil PublicClientApplication die Signatur Microsofts via JWKS validieren würde —
// bei localhost wird die Validierung im Browser aber lockerer behandelt; wir bauen
// trotzdem ein strukturell vollständiges Token).
function fakeIdToken(clientId, tenantId) {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: 'fake' }));
    const payload = b64url(JSON.stringify({
        iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        aud: clientId,
        sub: 'fake-sub-' + crypto.randomBytes(8).toString('hex'),
        oid: 'fake-oid-' + crypto.randomBytes(8).toString('hex'),
        tid: tenantId,
        preferred_username: 'owner1.test@example.com',
        name: 'Owner1 Test',
        iat: now,
        nbf: now,
        exp: now + 3600,
        ver: '2.0',
    }));
    const sig = b64url(crypto.randomBytes(64));
    return `${header}.${payload}.${sig}`;
}

const TENANT = 'organizations';
const CLIENT_ID = '6a526d81-91a0-4114-9219-776be6d5a560';

async function runScenario(label, configure) {
    group(label);
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    const consoleErrors = [];
    const consoleAll = [];
    page.on('console', msg => {
        const t = `${msg.type()}: ${msg.text()}`;
        consoleAll.push(t);
        if (msg.type() === 'error') consoleErrors.push(t);
    });
    page.on('pageerror', err => consoleErrors.push('UNCAUGHT: ' + err.message));

    const stats = {
        authorizeRequests: 0,
        tokenRequests: 0,
        graphRequests: 0,
        lastAuthorizeUrl: null,
    };

    await context.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();

        if (url.startsWith('https://login.microsoftonline.com/') &&
            url.includes('/oauth2/v2.0/authorize')) {
            stats.authorizeRequests++;
            stats.lastAuthorizeUrl = url;
            const u = new URL(url);
            const redirectUri = u.searchParams.get('redirect_uri');
            const state = u.searchParams.get('state');
            return configure.handleAuthorize({ route, redirectUri, state });
        }

        if (url.startsWith('https://login.microsoftonline.com/') &&
            url.includes('/oauth2/v2.0/token')) {
            stats.tokenRequests++;
            return configure.handleToken({ route });
        }

        if (url.startsWith('https://graph.microsoft.com/')) {
            stats.graphRequests++;
            return configure.handleGraph({ route });
        }

        // Andere login.live-URLs etc. — unerwartet
        if (url.startsWith('https://login.microsoftonline.com/') ||
            url.startsWith('https://login.live.com/')) {
            console.log('   (unhandled MS-URL: ' + url.slice(0, 120) + ')');
            return route.abort();
        }

        await route.continue();
    });

    let loadErr = null;
    try {
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
    } catch (e) { loadErr = e.message; }
    check('Seite geladen', !loadErr, loadErr || '');

    await page.waitForTimeout(1500);

    // Banner anklicken (Navigation passiert clientseitig durch loginRedirect)
    await page.evaluate(() => {
        const a = document.getElementById('driveAltLink');
        if (a) a.click();
    });

    // Auf neue Seite warten, dann Zeit für handleRedirectPromise
    try {
        await page.waitForURL(u => !u.includes('login.microsoftonline.com'), { timeout: 8000 });
    } catch { /* ok */ }
    await page.waitForTimeout(5000);

    if (configure.checks) {
        await configure.checks({ page, stats, consoleErrors });
    }

    if (process.env.DEBUG_CONSOLE) {
        console.log('   --- console ---');
        consoleAll.slice(-20).forEach(l => console.log('   ' + l));
    }

    await browser.close();
}

(async () => {
    // -------- Szenario A: User cancel (error=access_denied) --------
    await runScenario('A) Microsoft antwortet mit error=access_denied', {
        handleAuthorize: async ({ route, redirectUri, state }) => {
            const target = `${redirectUri}#error=access_denied&error_description=User+cancelled&state=${encodeURIComponent(state)}`;
            await route.fulfill({
                status: 302,
                headers: { 'Location': target, 'Content-Type': 'text/html' },
                body: '',
            });
        },
        handleToken: async ({ route }) => {
            // sollte nicht aufgerufen werden
            await route.fulfill({ status: 400, body: '{"error":"unexpected"}' });
        },
        handleGraph: async ({ route }) => {
            await route.fulfill({ status: 401, body: '{}' });
        },
        checks: async ({ page, stats, consoleErrors }) => {
            check('Genau 1 Authorize-Aufruf (kein Loop)', stats.authorizeRequests === 1,
                'count=' + stats.authorizeRequests);
            check('Token-Endpoint wurde NICHT aufgerufen', stats.tokenRequests === 0,
                'count=' + stats.tokenRequests);
            const url = page.url();
            check('Browser ist zurück auf App-URL (kein Re-Redirect)',
                url.startsWith(APP_URL.split('?')[0]),
                url.slice(0, 100));
            check('Keine fatalen JS-Fehler', consoleErrors.length === 0,
                consoleErrors.slice(0, 3).join(' | '));
        },
    });

    // -------- Szenario B: Token-Endpoint failt (invalid_grant) --------
    await runScenario('B) Authorize ok, Token-Endpoint failt mit invalid_grant', {
        handleAuthorize: async ({ route, redirectUri, state }) => {
            const target = `${redirectUri}#code=fake-code-${Date.now()}&state=${encodeURIComponent(state)}&client_info=` +
                b64url(JSON.stringify({ uid: 'fake-uid', utid: 'fake-utid' }));
            await route.fulfill({
                status: 302,
                headers: { 'Location': target, 'Content-Type': 'text/html' },
                body: '',
            });
        },
        handleToken: async ({ route }) => {
            await route.fulfill({
                status: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: 'invalid_grant',
                    error_description: 'AADSTS9002313: Invalid request. Request is malformed or invalid.',
                    error_codes: [9002313],
                }),
            });
        },
        handleGraph: async ({ route }) => {
            await route.fulfill({ status: 401, body: '{}' });
        },
        checks: async ({ page, stats, consoleErrors }) => {
            check('Genau 1 Authorize-Aufruf (kein Loop)', stats.authorizeRequests === 1,
                'count=' + stats.authorizeRequests);
            check('Genau 1 Token-Aufruf', stats.tokenRequests === 1,
                'count=' + stats.tokenRequests);
            check('Browser ist zurück auf App-URL', page.url().startsWith(APP_URL.split('?')[0]),
                page.url().slice(0, 100));
        },
    });

    // -------- Szenario D: erfolgreicher Token (mocken), dann Reload --------
    await runScenario('D) Erfolgreicher Token, dann Reload — kein erneuter MS-Redirect', {
        handleAuthorize: async ({ route, redirectUri, state }) => {
            const target = `${redirectUri}#code=fake-code-${Date.now()}&state=${encodeURIComponent(state)}&client_info=` +
                b64url(JSON.stringify({ uid: 'fake-uid', utid: 'fake-utid' }));
            await route.fulfill({
                status: 302,
                headers: { 'Location': target, 'Content-Type': 'text/html' },
                body: '',
            });
        },
        handleToken: async ({ route }) => {
            const idToken = fakeIdToken(CLIENT_ID, '00000000-0000-0000-0000-000000000000');
            await route.fulfill({
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token_type: 'Bearer',
                    scope: 'Files.ReadWrite offline_access openid profile',
                    expires_in: 3600,
                    ext_expires_in: 3600,
                    access_token: 'fake-access-token-' + crypto.randomBytes(8).toString('hex'),
                    refresh_token: 'fake-refresh-token',
                    id_token: idToken,
                    client_info: b64url(JSON.stringify({ uid: 'fake-uid', utid: 'fake-utid' })),
                }),
            });
        },
        handleGraph: async ({ route }) => {
            const u = route.request().url();
            if (u.includes('/drive/root:/')) {
                await route.fulfill({
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                    body: '{"error":{"code":"itemNotFound"}}',
                });
                return;
            }
            await route.fulfill({
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: '{"id":"fakeid"}',
            });
        },
        checks: async ({ page, stats, consoleErrors }) => {
            check('Genau 1 Authorize-Aufruf nach Banner-Click',
                stats.authorizeRequests === 1, 'count=' + stats.authorizeRequests);
            check('App ist zurück auf App-URL',
                page.url().startsWith(APP_URL.split('?')[0]),
                page.url().slice(0, 100));

            // Reload-Test: kein erneuter Redirect zu Microsoft
            const before = stats.authorizeRequests;
            await page.reload({ waitUntil: 'networkidle', timeout: 10000 });
            await page.waitForTimeout(2500);
            check('Reload löst KEINEN erneuten Microsoft-Redirect aus (Loop-Probe)',
                stats.authorizeRequests === before,
                `before=${before}, after=${stats.authorizeRequests}`);
            check('Browser nach Reload immer noch auf App-URL',
                page.url().startsWith(APP_URL.split('?')[0]),
                page.url().slice(0, 100));
        },
    });

    // -------- Szenario E: alter ?code=... in URL beim Erstaufruf --------
    await runScenario('E) Direktaufruf mit altem ?code= in URL — kein Loop', {
        handleAuthorize: async ({ route, redirectUri, state }) => {
            // Falls die App das aufrufen WÜRDE: das wäre der Bug. Wir antworten mit error.
            const target = `${redirectUri}#error=should_not_happen&state=${encodeURIComponent(state)}`;
            await route.fulfill({
                status: 302,
                headers: { 'Location': target, 'Content-Type': 'text/html' },
                body: '',
            });
        },
        handleToken: async ({ route }) => {
            await route.fulfill({ status: 400, body: '{"error":"invalid_grant"}' });
        },
        handleGraph: async ({ route }) => {
            await route.fulfill({ status: 401, body: '{}' });
        },
        checks: async ({ page, stats }) => {
            // Klick wird NICHT gebraucht — wir prüfen nur den Initial-Load.
            // Aber unser runScenario clickt sowieso. Wir prüfen die Counts.
            check('Authorize ≤ 1 (kein doppelter Loop trotz "alter Code"-URL)',
                stats.authorizeRequests <= 1,
                'count=' + stats.authorizeRequests);
        },
    });
    // E ist eigentlich identisch zu A bis hier. Wir machen E richtig:
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await context.newPage();
        let authorizeCount = 0;
        const consoleErrors = [];
        page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
        await context.route('**/*', async (route) => {
            const url = route.request().url();
            if (url.startsWith('https://login.microsoftonline.com/') && url.includes('/authorize')) {
                authorizeCount++;
                // 302 zurück mit error
                const u = new URL(url);
                const target = `${u.searchParams.get('redirect_uri')}#error=interaction_required&state=${encodeURIComponent(u.searchParams.get('state'))}`;
                return route.fulfill({ status: 302, headers: { 'Location': target } });
            }
            if (url.startsWith('https://login.microsoftonline.com/') ||
                url.startsWith('https://login.live.com/') ||
                url.startsWith('https://graph.microsoft.com/')) {
                return route.abort();
            }
            return route.continue();
        });

        group('E2) Direktaufruf der App-URL mit ungültigem ?code= Parameter');
        try {
            await page.goto(APP_URL + '?code=stale-code-from-old-session&state=stale-state', {
                waitUntil: 'networkidle', timeout: 10000,
            });
        } catch (e) { /* might error due to navigation, ok */ }
        await page.waitForTimeout(3000);
        check('App löst KEINEN automatischen Microsoft-Redirect aus',
            authorizeCount === 0, 'count=' + authorizeCount);
        check('App zeigt sich wenigstens nicht crasht', !consoleErrors.some(e => /UNCAUGHT/.test(e)),
            consoleErrors.slice(0, 2).join(' | '));
        await browser.close();
    }

    console.log('\n' + (totalFails === 0
        ? '✓ ALLE TIEFEN-TESTS BESTANDEN'
        : `✗ ${totalFails} TIEFEN-TEST(S) FEHLGESCHLAGEN`));
    process.exit(totalFails === 0 ? 0 : 1);
})().catch(e => {
    console.error('Test-Skript-Fehler:', e);
    process.exit(2);
});
