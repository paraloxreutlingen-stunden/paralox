/* Test: Auto-Logout nach Inaktivität.
 *  - Nach dem Login läuft die Frist; kurz davor ist die Sitzung noch aktiv
 *  - Nach Ablauf wird abgemeldet UND die Session verworfen
 *  - Aktivität (Tastendruck) setzt die Frist zurück
 *  - Der Hinweistext nennt dieselbe Frist, die tatsächlich gilt
 *
 * Die Systemzeit der Seite wird über page.clock gefälscht, damit der Test
 * nicht real 90 Sekunden warten muss. Läuft gegen Test-Daten (Default-Seed),
 * nicht gegen die produktiven Daten.
 */
'use strict';
const { chromium } = require('playwright-core');
const APP_URL = process.env.PARALOX_URL || 'http://127.0.0.1:8080/index.html';

let fails = 0;
function check(label, cond, detail) {
    console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? ': ' + detail : ''}`);
    if (!cond) fails++;
}

async function newPage(browser) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // Beide Pflicht-Modals vorab als gesehen markieren — sie lägen sonst über
    // der App und der Test käme nicht an die Views.
    await page.addInitScript(() => {
        const iso = new Date().toISOString();
        const seen = JSON.stringify({ '1': iso, '2': iso, '99': iso });
        localStorage.setItem('paraloxStunden.dsgvoAccepted', seen);
        localStorage.setItem('paraloxStunden.vacationReminder', seen);
    });
    return page;
}

async function login(page) {
    await page.evaluate(() => {
        const sel = document.getElementById('loginName');
        const opt = Array.from(sel.options).find(o => o.textContent === 'Admin');
        sel.value = opt.value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(
            new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(800);
}

const eingeloggt = page => page.evaluate(() =>
    !!document.getElementById('view-login')?.classList.contains('hidden'));
const hatSession = page => page.evaluate(() =>
    !!sessionStorage.getItem('paraloxStunden.session'));

(async () => {
    const browser = await chromium.launch({ channel: 'chrome' });
    // Die im Code hinterlegte Frist aus dem Bundle lesen, statt sie im Test
    // zu duplizieren — so prüft der Test das Verhalten, nicht eine Zahl.
    let timeoutMs = null;

    console.log('Auto-Logout');
    {
        const page = await newPage(browser);
        await page.clock.install();
        await page.goto(APP_URL);
        await page.waitForTimeout(1000);

        const src = await page.evaluate(async () => {
            const res = await fetch('app.js');
            return res.ok ? await res.text() : '';
        });
        const m = src.match(/IDLE_TIMEOUT_MS\s*=\s*([\d\s*]+);/);
        timeoutMs = m ? Function(`return ${m[1]}`)() : null;
        check('IDLE_TIMEOUT_MS aus app.js gelesen', !!timeoutMs, timeoutMs + ' ms');

        await login(page);
        check('nach Login angemeldet', await eingeloggt(page));

        // Kurz vor Ablauf: Sitzung muss noch stehen.
        await page.clock.fastForward(Math.round(timeoutMs * 0.8));
        await page.waitForTimeout(300);
        check('bei 80 % der Frist noch angemeldet', await eingeloggt(page));

        // Über die Frist hinaus: Abmeldung + Session verworfen.
        await page.clock.fastForward(Math.round(timeoutMs * 0.4) + 1000);
        await page.waitForTimeout(800);
        check('nach Ablauf abgemeldet', !(await eingeloggt(page)));
        check('Session verworfen', !(await hatSession(page)));
        await page.context().close();
    }

    console.log('Aktivität setzt die Frist zurück');
    {
        const page = await newPage(browser);
        await page.clock.install();
        await page.goto(APP_URL);
        await page.waitForTimeout(1000);
        await login(page);

        // Zweimal 80 % der Frist, dazwischen ein Tastendruck: ohne Reset wäre
        // die Frist längst überschritten.
        await page.clock.fastForward(Math.round(timeoutMs * 0.8));
        await page.waitForTimeout(200);
        await page.evaluate(() => window.dispatchEvent(new Event('keydown')));
        await page.clock.fastForward(Math.round(timeoutMs * 0.8));
        await page.waitForTimeout(300);
        check('nach Aktivität weiterhin angemeldet', await eingeloggt(page));
        await page.context().close();
    }

    console.log('Hinweistext passt zur Frist');
    {
        const page = await newPage(browser);
        await page.clock.install();
        await page.goto(APP_URL);
        await page.waitForTimeout(1000);
        await login(page);

        // Toast erscheint 400 ms vor dem Reload — vor dem Zeitsprung abgreifen.
        await page.clock.fastForward(timeoutMs + 100);
        await page.waitForTimeout(150);
        const txt = await page.evaluate(() =>
            document.getElementById('toasts')?.innerText || '');
        const sec = Math.round(timeoutMs / 1000);
        const erwartet = sec % 60 !== 0
            ? `${sec} Sekunden`
            : (sec / 60 === 1 ? 'einer Minute' : `${sec / 60} Minuten`);
        check('Toast nennt die tatsächliche Frist', txt.includes(erwartet),
            JSON.stringify(txt.trim()) + ' enthält ' + JSON.stringify(erwartet));
        await page.context().close();
    }

    await browser.close();
    console.log(fails === 0 ? '\nAlle Prüfungen bestanden.' : `\n${fails} Prüfung(en) fehlgeschlagen.`);
    process.exit(fails === 0 ? 0 : 1);
})();
