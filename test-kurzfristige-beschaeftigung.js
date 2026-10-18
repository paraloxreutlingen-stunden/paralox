/* Tests für kurzfristige Beschäftigung (§8 Abs. 1 Nr. 2 SGB IV):
 *  1. Kernfall: identischer Lohn (10 Std à 14 EUR = 140 EUR) für einen
 *     kurzfristig Beschäftigten und einen Minijobber — nur die
 *     Beschäftigungsart unterscheidet sich. Bei kurzfristig müssen Abgaben
 *     UND RV-Anteil 0,00 sein, beim Minijobber beide > 0.
 *  2. Beschäftigungsart-Badge in der Mitarbeiterliste.
 *  3. "Meine Stunden" zeigt für kurzfristig Beschäftigte die Arbeitstage-Info
 *     statt der Minijob-Grenze (keine 7.236-/603-EUR-Beträge).
 *  4. Migration: ein Mitarbeiter, der im Oktober 2025 noch Minijob war und ab
 *     Oktober 2026 kurzfristig wechselt, behält für den alten Monat die
 *     Minijob-Abgaben — ein späterer Wechsel wirkt nicht rückwirkend.
 *
 * Läuft gegen Test-Daten, nicht gegen die produktiven Daten.
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

async function setupAndLogin(page, setupFn, loginName) {
    await page.evaluate(setupFn);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await page.evaluate((name) => {
        const sel = document.getElementById('loginName');
        const opt = Array.from(sel.options).find(o => o.textContent.startsWith(name));
        sel.value = opt.value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }, loginName);
    await page.waitForTimeout(800);
}

async function logout(page) {
    await page.evaluate(() => document.getElementById('btnLogout').click());
    await page.waitForTimeout(500);
}

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
            return document.getElementById('adminSummary').textContent.replace(/\s+/g, ' ').trim();
        });
    }, empNamePrefix);
}

(async () => {
    // -------- 1+2. Kernfall: identischer Lohn, unterschiedliche Beschäftigungsart --------
    console.log('\n=== Kurzfristig vs. Minijob: identischer Lohn (140 EUR) ===');
    {
        const { browser, page } = await newPage();
        await setupAndLogin(page, () => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.settings.wageHistory = [{ gueltigAb: '2026-01-01', single: 14, double: 19 }];
            data.settings.rvAnteilProzent = 3.6;
            data.settings.rooms = { R1: { name: 'Raum 1', owner1: 50, owner2: 50 } };
            data.employees.push({
                id: 900, name: 'KurzfristigTest', password: 'paralox',
                isAdmin: false, isAccountant: false, isActive: true, assignedTo: 'owner1',
                monatspauschale: 0, pauschaleAb: '',
                rvBefreit: false, rvHistorie: [{ gueltigAb: '2026-10', befreit: false }],
                beschaeftigungsart: 'kurzfristig',
                beschaeftigungsartHistorie: [{ gueltigAb: '2026-10', typ: 'kurzfristig' }],
                createdAt: '2026-10-01T00:00:00Z',
            });
            data.employees.push({
                id: 901, name: 'MinijobTest', password: 'paralox',
                isAdmin: false, isAccountant: false, isActive: true, assignedTo: 'owner1',
                monatspauschale: 0, pauschaleAb: '',
                rvBefreit: false, rvHistorie: [{ gueltigAb: '2026-10', befreit: false }],
                beschaeftigungsart: 'minijob',
                beschaeftigungsartHistorie: [{ gueltigAb: '2026-10', typ: 'minijob' }],
                createdAt: '2026-10-01T00:00:00Z',
            });
            data.shifts.push({ id: 9001, employeeId: 900, date: '2026-10-20', startTime: '08:00', endTime: '18:00', room: 'R1', secondRoom: null, isDouble: false, note: '' });
            data.shifts.push({ id: 9002, employeeId: 901, date: '2026-10-20', startTime: '08:00', endTime: '18:00', room: 'R1', secondRoom: null, isDouble: false, note: '' });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        }, 'Admin');

        const kurz = await summaryFor(page, 'KurzfristigTest');
        console.log('  KurzfristigTest:', kurz);
        // Zwischen Label und Betrag steht im DOM kein Trennzeichen, deshalb \s*.
        // Ein fest erwartetes Leerzeichen ließe die Prüfung unabhängig vom Betrag
        // scheitern — und in der negierten Form unabhängig vom Betrag bestehen.
        check('Kurzfristig: Abgaben Eigentümer 1 = 0,00', /Abgaben Eigentümer 1 \(31,17%\)\s*0,00 EUR/.test(kurz));
        check('Kurzfristig: RV-Anteil (befreit)', kurz.includes('RV-Anteil (befreit)'));
        check('Kurzfristig: Auszahlung = Brutto (140,00 EUR)', /Auszahlung an KurzfristigTest\s*140,00 EUR/.test(kurz));

        const mini = await summaryFor(page, 'MinijobTest');
        console.log('  MinijobTest:', mini);
        check('Minijob: Abgaben Eigentümer 1 > 0', !/Abgaben Eigentümer 1 \(31,17%\)\s*0,00 EUR/.test(mini));
        // Bei 140 EUR Monatsbrutto liegt der Lohn unter 175 EUR, also greift die
        // Mindestbeitragsbemessungsgrundlage und das Label lautet "Mindestbeitrag"
        // statt "3,6%". Maßgeblich für diesen Test ist, DASS ein RV-Anteil
        // abgezogen wird — der Prozentsatz ist Sache von test-rv-payout.js.
        check('Minijob: RV-Anteil wird abgezogen', /RV-Anteil \([^)]*\)\s*−\s*\d+,\d\d EUR/.test(mini));

        console.log('--- Mitarbeiterliste: Beschäftigungsart-Badge ---');
        const rows = await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('#tabs button')).find(b => b.dataset.tab === 'employees');
            btn.click();
            return new Promise(r => setTimeout(r, 300)).then(() =>
                Array.from(document.querySelectorAll('#empTable tbody tr')).map(tr => tr.textContent.replace(/\s+/g, ' ').trim()));
        });
        const kurzRow = rows.find(r => r.includes('KurzfristigTest'));
        const miniRow = rows.find(r => r.includes('MinijobTest'));
        check('KurzfristigTest-Zeile zeigt "Kurzfristig"', !!kurzRow && kurzRow.includes('Kurzfristig'));
        check('MinijobTest-Zeile zeigt "Minijob"', !!miniRow && miniRow.includes('Minijob'));

        console.log('--- "Meine Stunden" als kurzfristig Beschäftigter ---');
        await logout(page);
        await page.evaluate(() => {
            const sel = document.getElementById('loginName');
            const opt = Array.from(sel.options).find(o => o.textContent.startsWith('KurzfristigTest'));
            sel.value = opt.value;
            document.getElementById('loginPassword').value = 'paralox';
            document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        });
        await page.waitForTimeout(800);
        const mineText = await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('#tabs button')).find(b => b.dataset.tab === 'mine');
            btn.click();
            return new Promise(r => setTimeout(r, 300)).then(() => document.getElementById('mineLimits').textContent.replace(/\s+/g, ' ').trim());
        });
        console.log('  mineLimits:', mineText);
        check('Zeigt "Kurzfristige Beschäftigung" statt Minijob-Grenze', mineText.includes('Kurzfristige Beschäftigung'));
        check('Keine Minijob-Grenzbeträge (7.236/603)', !mineText.includes('7.236') && !mineText.includes('603,00'));

        await browser.close();
    }

    // -------- 3. Wechsel Minijob → kurzfristig wirkt nicht rückwirkend --------
    console.log('\n=== Wechsel Minijob (2025-10) → kurzfristig (2026-10) ===');
    {
        const { browser, page } = await newPage();
        await setupAndLogin(page, () => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.settings.wageHistory = [{ gueltigAb: '2025-01-01', single: 14, double: 19 }];
            data.settings.rvAnteilProzent = 3.6;
            data.settings.rooms = { R1: { name: 'Raum 1', owner1: 50, owner2: 50 } };
            data.employees.push({
                id: 902, name: 'WechselTest', password: 'paralox',
                isAdmin: false, isAccountant: false, isActive: true, assignedTo: 'owner1',
                monatspauschale: 0, pauschaleAb: '',
                rvBefreit: false, rvHistorie: [{ gueltigAb: '2025-10', befreit: false }],
                beschaeftigungsart: 'kurzfristig',
                beschaeftigungsartHistorie: [
                    { gueltigAb: '2025-10', typ: 'minijob' },
                    { gueltigAb: '2026-10', typ: 'kurzfristig' },
                ],
                createdAt: '2025-10-01T00:00:00Z',
            });
            data.shifts.push({ id: 9101, employeeId: 902, date: '2025-10-15', startTime: '08:00', endTime: '18:00', room: 'R1', secondRoom: null, isDouble: false, note: '' });
            data.shifts.push({ id: 9102, employeeId: 902, date: '2026-10-15', startTime: '08:00', endTime: '18:00', room: 'R1', secondRoom: null, isDouble: false, note: '' });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        }, 'Admin');

        const full = await summaryFor(page, 'WechselTest');
        console.log('  WechselTest (alle Zeiträume):', full);
        // Zeitraum = "Alle" mischt einen Minijob-Monat (2025-10, Abgaben > 0) und
        // einen kurzfristig-Monat (2026-10, Abgaben = 0) — die Abgaben insgesamt
        // müssen daher > 0, aber kleiner als bei zwei vollen Minijob-Monaten sein.
        check('Gemischter Zeitraum: Abgaben Eigentümer 1 > 0 (Minijob-Monat trägt bei)', !/Abgaben Eigentümer 1 \(31,17%\)\s*0,00 EUR/.test(full));
        // "teilw. befreit" ist der Beleg dafür, dass monatsweise gerechnet wurde:
        // nur 2026-10 gilt als befreit. Ein bloßes includes('RV-Anteil') wäre
        // auch bei durchgehend voller RV-Pflicht erfüllt und prüfte nichts.
        check('Gemischter Zeitraum: RV nur für den Minijob-Monat (teilw. befreit)', /RV-Anteil \(teilw\./.test(full));

        await browser.close();
    }

    console.log(fails === 0 ? '\nAlle Prüfungen bestanden.' : `\n${fails} Prüfung(en) fehlgeschlagen.`);
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
