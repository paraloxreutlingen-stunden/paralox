/* Test: Login-View passt OHNE Scrollen auf einen typischen Tablet-Viewport,
 * auch wenn eine Pinnwand-Mitteilung sichtbar ist.
 */
'use strict';
const { chromium } = require('playwright-core');

const APP_URL = process.env.PARALOX_URL || 'http://127.0.0.1:8080/paralox-stunden.html';
// Chrome-Pfad je nach Installation (64-bit oder x86); mit PARALOX_CHROME überschreibbar.
const CHROME = process.env.PARALOX_CHROME || [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => require('fs').existsSync(p));

let fails = 0;
function check(label, cond, detail) {
    const m = cond ? '✓' : '✗';
    console.log(`  ${m} ${label}${detail ? ': ' + detail : ''}`);
    if (!cond) fails++;
}

async function measure(viewport, withPinboard, label) {
    console.log(`\n=== ${label} (${viewport.width}x${viewport.height}, pinboard=${withPinboard}) ===`);
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
    const page = await context.newPage();

    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(1000);

    // DSGVO-Consent vorab für alle Test-User-IDs als bestätigt markieren —
    // verhindert, dass das Popup nach Login erscheint und die Messung stört.
    await page.evaluate(() => {
        const iso = new Date().toISOString();
        localStorage.setItem('paraloxStunden.dsgvoAccepted',
            JSON.stringify({ '1': iso, '2': iso, '99': iso }));
    });

    if (withPinboard) {
        // Pinnwand-Mitteilung direkt im localStorage setzen
        await page.evaluate(() => {
            const raw = localStorage.getItem('paraloxStunden.v1');
            if (!raw) return;
            const data = JSON.parse(raw);
            data.pinboard = {
                text: 'Bitte die Schichten am Sonntag bis 12 Uhr nachtragen — ich brauche die Liste für die Lohnabrechnung. Danke!\n\n— Eigentümer 1',
                updatedAt: new Date().toISOString(),
                updatedBy: 1,
            };
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        });
    }
    // Reload, damit Marker + Pinnwand-Daten beim Login-Render greifen
    await page.reload({ waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(800);

    const m = await page.evaluate(() => {
        const view = document.getElementById('view-login');
        const form = document.getElementById('loginForm');
        const pin  = document.getElementById('loginPinboard');
        const submitBtn = form?.querySelector('button[type="submit"]');
        const viewRect = view.getBoundingClientRect();
        const formRect = form.getBoundingClientRect();
        const pinRect  = pin && !pin.classList.contains('hidden') ? pin.getBoundingClientRect() : null;
        const btnRect  = submitBtn?.getBoundingClientRect();
        return {
            viewport: { w: window.innerWidth, h: window.innerHeight },
            scrollHeight: document.documentElement.scrollHeight,
            clientHeight: document.documentElement.clientHeight,
            view: { x: viewRect.x, y: viewRect.y, w: viewRect.width, h: viewRect.height,
                    bottom: viewRect.bottom },
            form: { x: formRect.x, y: formRect.y, w: formRect.width },
            pin:  pinRect ? { x: pinRect.x, y: pinRect.y, w: pinRect.width } : null,
            btnBottom: btnRect ? btnRect.bottom : null,
            pinHidden: pin?.classList.contains('hidden'),
        };
    });

    console.log('  viewport=', m.viewport, 'scrollH=', m.scrollHeight, 'clientH=', m.clientHeight);
    console.log('  view: width=', m.view.w.toFixed(0), 'bottom=', m.view.bottom.toFixed(0));
    if (m.form) console.log('  form: x=', m.form.x.toFixed(0), 'width=', m.form.w.toFixed(0));
    if (m.pin)  console.log('  pin:  x=', m.pin.x.toFixed(0),  'width=', m.pin.w.toFixed(0));

    check('Login-Submit-Button im Viewport (kein Scrollen nötig zum Login)',
        m.btnBottom !== null && m.btnBottom <= m.viewport.h,
        `btnBottom=${m.btnBottom?.toFixed(0)}, viewportH=${m.viewport.h}`);
    // Auf Tablets soll der gesamte Login-View (inkl. Pinnwand) ohne Scrollen
    // sichtbar sein. Da der DSGVO-Hinweis seit dem Consent-Popup nicht mehr
    // unter dem Form klebt, sollte das Layout sehr knapp passen.
    if (withPinboard && viewport.width >= 720) {
        const overflow = m.scrollHeight - m.clientHeight;
        check('Tablet: Login-View passt ohne Scrollen (≤ 50px Toleranz)',
            overflow <= 50, `overflow=${overflow}px`);
    }

    if (withPinboard && viewport.width >= 720) {
        check('Pinnwand steht NEBEN dem Form (zweispaltig)',
            m.pin && m.form && m.pin.x > m.form.x + m.form.w / 2,
            m.pin && m.form ? `formX=${m.form.x.toFixed(0)}, pinX=${m.pin.x.toFixed(0)}` : 'pin/form fehlt');
    }
    if (withPinboard && viewport.width < 720) {
        check('Pinnwand steht UNTER dem Form (einspaltig auf Phone)',
            m.pin && m.form && m.pin.y > m.form.y + 50,
            m.pin && m.form ? `formY=${m.form.y.toFixed(0)}, pinY=${m.pin.y.toFixed(0)}` : 'pin/form fehlt');
    }

    await browser.close();
}

(async () => {
    // iPad in Hochformat
    await measure({ width: 768, height: 1024 }, false, 'iPad Hochformat ohne Mitteilung');
    await measure({ width: 768, height: 1024 }, true,  'iPad Hochformat MIT Mitteilung');
    // iPad in Querformat
    await measure({ width: 1024, height: 768 }, true, 'iPad Querformat MIT Mitteilung');
    // Phone (kleines iPhone)
    await measure({ width: 390, height: 844 }, true, 'iPhone Hochformat MIT Mitteilung');

    console.log('\n' + (fails === 0
        ? '✓ ALLE LAYOUT-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
