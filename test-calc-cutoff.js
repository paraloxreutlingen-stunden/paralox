/* Tests für die verfeinerte Berechnung ab Stichtag (CALC_V2_FROM_MONTH = 2026-08):
 *  - Vor dem Stichtag (Juli 2026): Schicht-Beträge werden wie zuvor einzeln
 *    gerundet; die angezeigten Zeilen summieren sich NICHT zwangsläufig zum
 *    (wahren) Gesamtbetrag — frühere Monate bleiben unverändert.
 *  - Ab dem Stichtag (August 2026): die Zeilen werden per Largest-Remainder auf
 *    Cent verteilt und summieren sich EXAKT zum angezeigten Verdienst.
 *  - In BEIDEN Fällen bleibt der Verdienst/Brutto der wahre Rundungswert (70,00),
 *    damit er mit dem Brutto der Lohnberechnung übereinstimmt.
 *
 * Aufbau: 3 Schichten à 100 Min (08:00–09:40) zu 14 EUR/h = je 23,3333 EUR.
 *   Roh gerundet:  23,33 · 3 = 69,99   (Zeilensumme alt)
 *   Wahre Summe:   70,00               (Verdienst)
 */
'use strict';
const { chromium } = require('playwright-core');

const APP_URL = process.env.PARALOX_URL || 'http://127.0.0.1:8080/paralox-stunden.html';
const CHROME = process.env.PARALOX_CHROME || [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(p => require('fs').existsSync(p));

let fails = 0;
function check(label, cond, detail) {
    console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? ': ' + detail : ''}`);
    if (!cond) fails++;
}

// "23,34 EUR" → 2334 (Cent). Robust gegen Tausenderpunkte gibt es hier nicht.
function eurToCents(txt) {
    const m = String(txt).match(/(\d+),(\d{2})/);
    return m ? Number(m[1]) * 100 + Number(m[2]) : NaN;
}

(async () => {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(400);

    // Zwei Mitarbeiter: einer mit Juli-Schichten (vor Stichtag), einer mit
    // August-Schichten (ab Stichtag). Filter nach Mitarbeiter isoliert je einen.
    await page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
        data.settings.wageHistory = [{ gueltigAb: '2026-01-01', single: 14, double: 14 }];
        data.settings.rvAnteilProzent = 3.6;
        const mkEmp = (id, name) => ({
            id, name, password: 'paralox', isAdmin: true, isAccountant: false,
            rvBefreit: false, isActive: true, assignedTo: 'owner1',
            monatspauschale: 0, pauschaleAb: '', createdAt: '2026-01-01T00:00:00Z',
        });
        data.employees.push(mkEmp(710, 'VorStichtag'));
        data.employees.push(mkEmp(711, 'AbStichtag'));
        let id = 71000;
        const mkShift = (empId, date) => ({
            id: id++, employeeId: empId, date,
            startTime: '08:00', endTime: '09:40', // 100 Min → 23,3333 EUR
            room: 'FP', secondRoom: null, isDouble: false, note: '',
        });
        // 3 Schichten je Mitarbeiter im jeweiligen Monat.
        ['2026-07-06', '2026-07-13', '2026-07-20'].forEach(d => data.shifts.push(mkShift(710, d)));
        ['2026-08-06', '2026-08-13', '2026-08-20'].forEach(d => data.shifts.push(mkShift(711, d)));
        localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    // Login als Admin (VorStichtag ist Admin).
    await page.evaluate(() => {
        const sel = document.getElementById('loginName');
        const opt = Array.from(sel.options).find(o => o.textContent === 'VorStichtag');
        sel.value = opt.value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(600);
    await page.evaluate(() => {
        Array.from(document.querySelectorAll('#tabs button')).find(b => b.dataset.tab === 'shifts').click();
    });
    await page.waitForTimeout(400);

    async function inspect(empName) {
        return await page.evaluate((name) => {
            const sel = document.getElementById('adminEmpFilter');
            const opt = Array.from(sel.options).find(o => o.textContent.startsWith(name));
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            // Betrag-Spalte = 8. Zelle (Index 7) jeder Datenzeile.
            const betrag = Array.from(document.querySelectorAll('#adminTable tbody tr'))
                .map(tr => tr.children[7]?.textContent || '')
                .filter(t => /\d/.test(t));
            return { betrag, summary: document.getElementById('adminSummary').textContent };
        }, empName);
    }

    // -------- Vor Stichtag (Juli 2026) --------
    console.log('\n=== Vor Stichtag: Juli 2026 (alte Rundung, frühere Monate unverändert) ===');
    {
        const { betrag, summary } = await inspect('VorStichtag');
        const cents = betrag.map(eurToCents);
        const sum = cents.reduce((a, b) => a + b, 0);
        const verdienst = eurToCents((summary.match(/Verdienst\s*([\d.,]+)\s*EUR/) || [])[1] || '');
        const brutto = eurToCents((summary.match(/Brutto VorStichtag\s*([\d.,]+)\s*EUR/) || [])[1] || '');
        console.log('  Betrag-Zeilen:', betrag.join(' | '), '· Summe', (sum / 100).toFixed(2), '· Verdienst', (verdienst / 100).toFixed(2));
        check('3 Schicht-Zeilen sichtbar', cents.length === 3, String(cents.length));
        check('Jede Zeile zeigt 23,33 EUR (roh gerundet)', cents.every(c => c === 2333));
        check('Verdienst ist der WAHRE Wert 70,00 EUR', verdienst === 7000, (verdienst / 100).toFixed(2));
        check('Brutto (Lohnberechnung) = 70,00 EUR', brutto === 7000, (brutto / 100).toFixed(2));
        check('Zeilensumme bleibt alt (69,99 ≠ Verdienst) — nicht rückwirkend', sum === 6999, (sum / 100).toFixed(2));
    }

    // -------- Ab Stichtag (August 2026) --------
    console.log('\n=== Ab Stichtag: August 2026 (Zeilen summieren exakt auf den Verdienst) ===');
    {
        const { betrag, summary } = await inspect('AbStichtag');
        const cents = betrag.map(eurToCents);
        const sum = cents.reduce((a, b) => a + b, 0);
        const verdienst = eurToCents((summary.match(/Verdienst\s*([\d.,]+)\s*EUR/) || [])[1] || '');
        const brutto = eurToCents((summary.match(/Brutto AbStichtag\s*([\d.,]+)\s*EUR/) || [])[1] || '');
        console.log('  Betrag-Zeilen:', betrag.join(' | '), '· Summe', (sum / 100).toFixed(2), '· Verdienst', (verdienst / 100).toFixed(2));
        check('3 Schicht-Zeilen sichtbar', cents.length === 3, String(cents.length));
        check('Verdienst ist der WAHRE Wert 70,00 EUR', verdienst === 7000, (verdienst / 100).toFixed(2));
        check('Brutto (Lohnberechnung) = 70,00 EUR', brutto === 7000, (brutto / 100).toFixed(2));
        check('Zeilensumme = Verdienst (70,00) — reconciliert', sum === verdienst && sum === 7000, (sum / 100).toFixed(2));
        check('Genau eine Zeile trägt den Rest-Cent (23,34)', cents.filter(c => c === 2334).length === 1, betrag.join(' | '));
    }

    await browser.close();
    console.log('\n' + (fails === 0
        ? '✓ ALLE STICHTAG-/RECONCILIATION-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
