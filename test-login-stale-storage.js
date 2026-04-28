/* Realwelt-Edge-Case: User hat alte msal.*-Daten im localStorage
 * (z.B. von einer früheren Implementierung oder aus einem alten Login).
 * Provoziert das einen Loop?
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

async function run(label, primeStorage) {
    console.log('\n=== ' + label + ' ===');
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    let authorize = 0, token = 0;
    await context.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.includes('login.microsoftonline.com') && url.includes('/authorize')) {
            authorize++;
            const u = new URL(url);
            const target = `${u.searchParams.get('redirect_uri')}#error=interaction_required&state=${encodeURIComponent(u.searchParams.get('state'))}`;
            return route.fulfill({ status: 302, headers: { 'Location': target } });
        }
        if (url.includes('login.microsoftonline.com') && url.includes('/token')) {
            token++;
            return route.fulfill({ status: 400, body: '{"error":"invalid_grant"}' });
        }
        if (url.includes('login.microsoftonline.com') || url.includes('graph.microsoft.com')) {
            return route.abort();
        }
        return route.continue();
    });

    // Storage primen BEFORE navigation
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.evaluate((data) => {
        for (const [k, v] of Object.entries(data)) {
            localStorage.setItem(k, v);
        }
    }, primeStorage);

    // Echte App jetzt laden (reload damit init() mit dem geprimten Storage läuft)
    await page.reload({ waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(4000);

    check('Authorize-Anfragen ≤ 1 (kein Auto-Login-Loop bei stale storage)',
        authorize <= 1, 'count=' + authorize);
    check('Browser bleibt auf App-URL (Hash darf da sein)',
        page.url().startsWith(APP_URL.split('?')[0]),
        page.url().slice(0, 100));

    await browser.close();
}

(async () => {
    // 1. Alte v3-MSAL-Schemata
    await run('Stale: alte v3-Account/Token-Keys', {
        'msal.3.account.keys': '["fake-account-id"]',
        'msal.3.token.keys.6a526d81-91a0-4114-9219-776be6d5a560': '{"accessToken":["t1"],"idToken":["i1"],"refreshToken":["r1"]}',
        'msal.fake-account-id': '{"homeAccountId":"fake","environment":"login.microsoftonline.com","tenantId":"organizations","username":"old@example.com"}',
    });

    // 2. Defekter v5-state
    await run('Stale: kaputter v5-Encryption-Key (sollte clean fallback)', {
        'msal.version': '5.8.0',
        'msal.cache.encryption': '{broken-json',
    });

    // 3. URL mit alten code/state Hash beim Erstaufruf
    {
        console.log('\n=== Stale: App-URL mit altem #code=...&state=... beim Erstaufruf ===');
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await context.newPage();

        let authorize = 0;
        await context.route('**/*', async (route) => {
            const url = route.request().url();
            if (url.includes('login.microsoftonline.com') && url.includes('/authorize')) {
                authorize++;
                const u = new URL(url);
                const target = `${u.searchParams.get('redirect_uri')}#error=interaction_required&state=${encodeURIComponent(u.searchParams.get('state'))}`;
                return route.fulfill({ status: 302, headers: { 'Location': target } });
            }
            if (url.includes('login.microsoftonline.com') || url.includes('graph.microsoft.com')) {
                return route.abort();
            }
            return route.continue();
        });

        await page.goto(APP_URL + '#code=stale-code&state=stale-state', {
            waitUntil: 'networkidle', timeout: 15000,
        });
        await page.waitForTimeout(4000);
        check('Kein Auto-Redirect bei stale Hash-Code',
            authorize === 0, 'count=' + authorize);
        await browser.close();
    }

    console.log('\n' + (fails === 0
        ? '✓ ALLE STALE-STORAGE-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
