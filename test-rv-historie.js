/* Tests für die datierte RV-Historie (rvHistorie):
 *  1. Kernfall: Mitarbeiterin war BEFREIT, ist ab 2026-07 wieder RV-PFLICHTIG.
 *     Die Juni-Schicht darf KEINEN RV-Abzug haben, die Juli-Schicht schon —
 *     der Statuswechsel wirkt also nicht rückwirkend.
 *  2. Migration: bestehender Mitarbeiter ohne rvHistorie behält seinen Status
 *     in ALLEN Monaten (Anker = ältester Schicht-Monat), inkl. befreit=true.
 *  3. Lookup-Grenze: der Stichtagsmonat selbst gehört bereits zum NEUEN Status
 *     (gueltigAb ist inklusive) — schützt gegen Off-by-one.
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

async function newPage() {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(500);
    return { browser, page };
}

/* Legt die Testdaten an, lädt neu und loggt sich als der übergebene Admin ein. */
async function setupAndLogin(page, setupFn, loginName) {
    await page.evaluate(setupFn);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await page.evaluate((name) => {
        const sel = document.getElementById('loginName');
        const opt = Array.from(sel.options).find(o => o.textContent === name);
        sel.value = opt.value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }, loginName);
    await page.waitForTimeout(800);
}

/* Öffnet den Schichten-Tab, setzt Zeitraum auf "Alle" und filtert auf einen
 * Mitarbeiter. Liefert den Text der Auswertungs-Box. */
async function summaryFor(page, empNamePrefix) {
    return page.evaluate((prefix) => {
        const btn = Array.from(document.querySelectorAll('#tabs button')).find(b => b.dataset.tab === 'shifts');
        btn.click();
        return new Promise(r => setTimeout(r, 300)).then(() => {
            const y = document.getElementById('adminYear');
            const mo = document.getElementById('adminMonth');
            if (y) { y.value = ''; y.dispatchEvent(new Event('change', { bubbles: true })); }
            if (mo) { mo.value = ''; mo.dispatchEvent(new Event('change', { bubbles: true })); }
            const sel = document.getElementById('adminEmpFilter');
            const opt = Array.from(sel.options).find(o => o.textContent.startsWith(prefix));
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return document.getElementById('adminSummary').textContent;
        });
    }, empNamePrefix);
}

(async () => {
    // -------- 1. Kernfall: befreit bis Juni, pflichtig ab Juli 2026 --------
    console.log('\n=== Kernfall: befreit bis 2026-06, RV-pflichtig ab 2026-07 ===');
    {
        const { browser, page } = await newPage();
        await setupAndLogin(page, () => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.settings.rvAnteilProzent = 3.6;
            data.settings.wageSingle = 20;
            data.settings.wageDouble = 25;
            // Lohnhistorie explizit setzen, damit der Stundensatz eindeutig ist
            // und nicht von der Migration abhängt.
            data.settings.wageHistory = [{ gueltigAb: '2026-01-01', single: 20, double: 25 }];
            data.employees.push({
                id: 700, name: 'WechslerMA', password: 'paralox',
                isAdmin: true, isAccountant: false,
                isActive: true, assignedTo: 'owner1',
                monatspauschale: 0, pauschaleAb: '',
                // War befreit; ab Juli 2026 wieder RV-pflichtig.
                rvBefreit: false,
                rvHistorie: [
                    { gueltigAb: '2026-01', befreit: true },
                    { gueltigAb: '2026-07', befreit: false },
                ],
                createdAt: '2026-01-01T00:00:00Z',
            });
            // Je 10 Stunden à 20 EUR = 200 EUR Brutto pro Monat. Bewusst über der
            // 175-EUR-Schwelle, damit der reguläre Satz (3,6 %) greift und nicht
            // die Mindestbeitragslogik das Ergebnis überlagert.
            const mk = (id, date) => ({
                id, employeeId: 700, date,
                startTime: '08:00', endTime: '18:00',
                room: 'FP', secondRoom: null, isDouble: false, note: '',
            });
            data.shifts.push(mk(7001, '2026-06-15')); // befreit  → RV 0,00
            data.shifts.push(mk(7002, '2026-07-15')); // pflichtig → RV 7,20
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        }, 'WechslerMA');

        const sum = await summaryFor(page, 'WechslerMA');
        console.log('  Summary:', sum.replace(/\s+/g, ' ').slice(0, 320));
        // Brutto gesamt 400,00. RV nur auf den Juli: 200 * 0,036 = 7,20.
        // Auszahlung 400,00 - 7,20 = 392,80.
        check('Brutto gesamt 400,00 EUR', /400,00 EUR/.test(sum));
        check('RV-Anteil 7,20 EUR (nur Juli, nicht 14,40 für beide Monate)',
            /7,20 EUR/.test(sum) && !/14,40 EUR/.test(sum));
        check('Auszahlung 392,80 EUR', /392,80 EUR/.test(sum));
        check('Label weist den Statuswechsel aus ("teilw. befreit")', /teilw\. befreit/.test(sum));
        check('Hinweis nennt den befreiten Monat 2026-06', /2026-06/.test(sum));

        // Gegenprobe pro Monat: Juni-PDF-Logik vs. Juli — über den Monatsfilter.
        const juni = await page.evaluate(() => {
            const y = document.getElementById('adminYear');
            const mo = document.getElementById('adminMonth');
            y.value = '2026'; y.dispatchEvent(new Event('change', { bubbles: true }));
            mo.value = '06';  mo.dispatchEvent(new Event('change', { bubbles: true }));
            return new Promise(r => setTimeout(r, 300))
                .then(() => document.getElementById('adminSummary').textContent);
        });
        check('Juni allein: kein RV-Abzug (Label "befreit", Auszahlung = Brutto)',
            /RV-Anteil \(befreit\)/.test(juni) && (juni.match(/200,00 EUR/g) || []).length >= 2,
            juni.replace(/\s+/g, ' ').match(/RV-Anteil[^A-Z]*/)?.[0]?.trim());

        const juli = await page.evaluate(() => {
            const mo = document.getElementById('adminMonth');
            mo.value = '07'; mo.dispatchEvent(new Event('change', { bubbles: true }));
            return new Promise(r => setTimeout(r, 300))
                .then(() => document.getElementById('adminSummary').textContent);
        });
        check('Juli allein: RV-Abzug 7,20 EUR und Auszahlung 192,80 EUR',
            /7,20 EUR/.test(juli) && /192,80 EUR/.test(juli),
            juli.replace(/\s+/g, ' ').match(/RV-Anteil[^A-Z]*/)?.[0]?.trim());
        check('Juli allein: Label nennt 3,6% (nicht "befreit")',
            /3,6%/.test(juli) && !/RV-Anteil \(befreit\)/.test(juli));

        await browser.close();
    }

    // -------- 2. Migration: Status bleibt in allen Monaten erhalten --------
    console.log('\n=== Migration: bestehender befreiter MA behält Status rückwirkend ===');
    {
        const { browser, page } = await newPage();
        const result = await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            // Alter, BEFREITER Mitarbeiter ohne rvHistorie-Feld, mit alten Schichten.
            data.employees.push({
                id: 800, name: 'AltBefreit', password: 'paralox',
                isAdmin: false, isAccountant: false, rvBefreit: true,
                isActive: true, assignedTo: 'owner1',
                createdAt: '2025-01-01T00:00:00Z',
                // KEINE rvHistorie
            });
            data.shifts.push({
                id: 8001, employeeId: 800, date: '2025-03-10',
                startTime: '08:00', endTime: '18:00',
                room: 'FP', secondRoom: null, isDouble: false, note: '',
            });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
            const reloaded = window.ParaloxStorage.load();
            return reloaded.employees.find(e => e.id === 800);
        });
        check('rvHistorie wurde angelegt (genau 1 Eintrag)',
            Array.isArray(result.rvHistorie) && result.rvHistorie.length === 1,
            JSON.stringify(result.rvHistorie));
        check('Eintrag übernimmt den bisherigen Status befreit=true',
            result.rvHistorie[0].befreit === true);
        check('Anker ist der älteste Schicht-Monat (2025-03), deckt alle Schichten ab',
            result.rvHistorie[0].gueltigAb === '2025-03', result.rvHistorie[0].gueltigAb);
        check('rvBefreit bleibt true (Spiegel des jüngsten Eintrags)', result.rvBefreit === true);
        await browser.close();
    }

    // -------- 3. Grenze: Stichtagsmonat gehört zum NEUEN Status --------
    console.log('\n=== Grenze: gueltigAb ist inklusive (Off-by-one-Schutz) ===');
    {
        const { browser, page } = await newPage();
        await setupAndLogin(page, () => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.settings.rvAnteilProzent = 3.6;
            data.settings.wageHistory = [{ gueltigAb: '2026-01-01', single: 20, double: 25 }];
            data.employees.push({
                id: 900, name: 'GrenzMA', password: 'paralox',
                isAdmin: true, isAccountant: false,
                isActive: true, assignedTo: 'owner1',
                monatspauschale: 0, pauschaleAb: '',
                rvBefreit: false,
                rvHistorie: [
                    { gueltigAb: '2026-01', befreit: true },
                    { gueltigAb: '2026-07', befreit: false },
                ],
                createdAt: '2026-01-01T00:00:00Z',
            });
            // NUR eine Schicht, und zwar exakt im Stichtagsmonat 2026-07.
            // Der Stichtagsmonat selbst muss bereits PFLICHTIG sein.
            data.shifts.push({
                id: 9001, employeeId: 900, date: '2026-07-01',
                startTime: '08:00', endTime: '18:00',
                room: 'FP', secondRoom: null, isDouble: false, note: '',
            });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        }, 'GrenzMA');

        const sum = await summaryFor(page, 'GrenzMA');
        console.log('  Summary:', sum.replace(/\s+/g, ' ').slice(0, 260));
        check('Stichtagsmonat 2026-07 ist bereits RV-pflichtig (7,20 EUR Abzug)', /7,20 EUR/.test(sum));
        check('Stichtagsmonat ist NICHT mehr befreit', !/RV-Anteil \(befreit\)/.test(sum));
        check('Auszahlung 192,80 EUR', /192,80 EUR/.test(sum));
        await browser.close();
    }

    console.log('\n' + (fails === 0
        ? '✓ ALLE RV-HISTORIE-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
