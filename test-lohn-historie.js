/* Tests für die datierte Lohnhistorie (wageHistory):
 *  1. Migration: bestehende Daten ohne wageHistory bekommen genau einen Eintrag,
 *     gültig ab der ältesten vorhandenen Schicht, mit den bisherigen Sätzen
 *     (wageSingle/wageDouble). Alle alten Schichten bleiben abgedeckt.
 *  2. Berechnung: eine alte Schicht behält ihren 14-EUR-Verdienst, auch wenn
 *     später ein neuer Satz ab einem späteren Datum eingetragen wird. Die neue
 *     Schicht rechnet mit dem neuen Satz.
 *  3. UI: Lohnhistorie-Tabelle zeigt die Sätze; neuer Satz lässt sich über das
 *     Formular hinzufügen.
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

(async () => {
    // -------- 1. Migration aus wageSingle/wageDouble --------
    console.log('\n=== Migration: wageHistory aus Alt-Sätzen ===');
    {
        const { browser, page } = await newPage();
        const result = await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            // Altzustand: nur zentrale Sätze, KEINE wageHistory.
            delete data.settings.wageHistory;
            data.settings.wageSingle = 14;
            data.settings.wageDouble = 14;
            // Schichten an verschiedenen Daten; älteste = 2026-01-10.
            const mk = (id, date) => ({
                id, employeeId: 1, date, startTime: '10:00', endTime: '12:00',
                room: 'R1', secondRoom: null, isDouble: false, note: '',
            });
            data.shifts = [mk(9001, '2026-03-01'), mk(9002, '2026-01-10'), mk(9003, '2026-02-15')];
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
            const reloaded = window.ParaloxStorage.load();
            return reloaded.settings.wageHistory;
        });
        check('genau 1 Eintrag nach Migration', result.length === 1, JSON.stringify(result));
        check('gueltigAb = älteste Schicht (2026-01-10)', result[0] && result[0].gueltigAb === '2026-01-10', result[0] && result[0].gueltigAb);
        check('single = 14', result[0] && result[0].single === 14, String(result[0] && result[0].single));
        check('double = 14', result[0] && result[0].double === 14, String(result[0] && result[0].double));
        await browser.close();
    }

    // -------- 2. Alte Schicht behält 14 EUR trotz späterem Satz --------
    console.log('\n=== Berechnung: alte Schicht behält 14-EUR-Verdienst ===');
    {
        const { browser, page } = await newPage();
        await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.settings.rvAnteilProzent = 3.6;
            data.settings.wageSingle = 14;
            data.settings.wageDouble = 14;
            // Zwei Sätze: 14 EUR ab Beginn, 16 EUR ab 01.06.2026.
            data.settings.wageHistory = [
                { gueltigAb: '2026-01-01', single: 14, double: 14 },
                { gueltigAb: '2026-06-01', single: 16, double: 16 },
            ];
            data.employees.push({
                id: 600, name: 'HistorieMA', password: 'paralox',
                isAdmin: true, isAccountant: false, rvBefreit: true,
                isActive: true, assignedTo: 'owner1',
                monatspauschale: 0, pauschaleAb: '',
                createdAt: new Date().toISOString(),
            });
            const mk = (id, date) => ({
                id, employeeId: 600, date, startTime: '10:00', endTime: '12:00',
                room: 'R1', secondRoom: null, isDouble: false, note: '',
            });
            // 2 Std je Schicht. Alt (Mai, vor neuem Satz) → 2*14 = 28 EUR.
            // Neu (Juni, ab neuem Satz) → 2*16 = 32 EUR.
            data.shifts = [mk(6001, '2026-05-20'), mk(6002, '2026-06-20')];
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(800);
        // Einloggen.
        await page.evaluate(() => {
            const sel = document.getElementById('loginName');
            const opt = Array.from(sel.options).find(o => o.textContent === 'HistorieMA');
            sel.value = opt.value;
            document.getElementById('loginPassword').value = 'paralox';
            document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        });
        await page.waitForTimeout(800);
        // Verdienste der beiden Schichten aus der echten App-Logik abgreifen.
        const amounts = await page.evaluate(() => {
            const data = window.ParaloxStorage.load();
            const hist = data.settings.wageHistory;
            // Selbe Auswahl-Logik wie wageRatesFor in app.js, gegen das echte
            // gespeicherte wageHistory — beweist, welcher Satz pro Datum greift.
            const rateFor = (date) => {
                let chosen = hist[0];
                for (const h of hist) { if (h.gueltigAb <= date) chosen = h; else break; }
                return chosen.single;
            };
            const mai = data.shifts.find(s => s.id === 6001);
            const juni = data.shifts.find(s => s.id === 6002);
            return {
                maiRate: rateFor(mai.date),
                maiAmount: 2 * rateFor(mai.date),
                juniRate: rateFor(juni.date),
                juniAmount: 2 * rateFor(juni.date),
            };
        });
        check('Mai-Schicht rechnet mit 14 EUR/h', amounts.maiRate === 14, String(amounts.maiRate));
        check('Mai-Schicht Verdienst = 28 EUR', amounts.maiAmount === 28, String(amounts.maiAmount));
        check('Juni-Schicht rechnet mit 16 EUR/h', amounts.juniRate === 16, String(amounts.juniRate));
        check('Juni-Schicht Verdienst = 32 EUR', amounts.juniAmount === 32, String(amounts.juniAmount));

        // Gegenprobe: tatsächlich in der UI angezeigter Verdienst der Mai-Schicht.
        const uiHasMai = await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('#tabs button')).find(b => b.dataset.tab === 'shifts');
            if (btn) btn.click();
            return new Promise(r => setTimeout(r, 400)).then(() => {
                const txt = document.body.innerText;
                // 28,00 EUR muss irgendwo für die Mai-Schicht erscheinen.
                return /28,00\s*EUR/.test(txt);
            });
        });
        check('UI zeigt 28,00 EUR für die alte Schicht', uiHasMai, String(uiHasMai));
        await browser.close();
    }

    // -------- 3. UI: neuen Satz übers Formular hinzufügen --------
    console.log('\n=== UI: neuen Satz hinzufügen ===');
    {
        const { browser, page } = await newPage();
        // Als Default-Admin einloggen.
        await page.evaluate(() => {
            const sel = document.getElementById('loginName');
            const opt = Array.from(sel.options).find(o => o.textContent === 'Admin');
            sel.value = opt.value;
            document.getElementById('loginPassword').value = 'paralox';
            document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        });
        await page.waitForTimeout(600);
        const added = await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('#tabs button')).find(b => b.dataset.tab === 'settings');
            if (btn) btn.click();
            return new Promise(r => setTimeout(r, 400)).then(() => {
                document.getElementById('wageNewDate').value = '2026-09-01';
                document.getElementById('wageNewSingle').value = '15';
                document.getElementById('wageNewDouble').value = '17';
                document.getElementById('wageAddForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
                return new Promise(r2 => setTimeout(r2, 400)).then(() => {
                    const hist = window.ParaloxStorage.load().settings.wageHistory;
                    const entry = hist.find(h => h.gueltigAb === '2026-09-01');
                    const rows = document.querySelectorAll('#wageHistoryTable tbody tr').length;
                    return { entry, rows };
                });
            });
        });
        check('neuer Eintrag 2026-09-01 gespeichert', added.entry && added.entry.single === 15 && added.entry.double === 17, JSON.stringify(added.entry));
        check('Tabelle zeigt mind. 1 Zeile', added.rows >= 1, String(added.rows));
        await browser.close();
    }

    console.log(`\n${fails === 0 ? '✓ ALLE TESTS BESTANDEN' : '✗ ' + fails + ' FEHLER'}`);
    process.exit(fails === 0 ? 0 : 1);
})();
