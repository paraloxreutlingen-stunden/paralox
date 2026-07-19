/* Test: Monatspauschale fließt in die Limit-Anzeige („Meine Stunden") ein.
 *
 * Regression zu dem Fehler, dass die Pauschale beim Mitarbeiter zwar im
 * Summary angezeigt, aber NICHT in den Monats-/Jahresbetrag der Minijob-Grenze
 * (renderLimits) eingerechnet wurde. Die Pauschale gehört zum Brutto und zählt
 * damit zur 556-EUR-Grenze — Monats- und Jahresbetrag müssen sie enthalten.
 *
 * renderLimits nutzt das echte `new Date()`, deshalb werden die Schicht-Daten
 * hier aus dem AKTUELLEN Monat/Jahr erzeugt (datumsunabhängig lauffähig).
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

// Aktuellen Monat/Jahr bestimmen — renderLimits rechnet gegen das echte Datum.
const now = new Date();
const curYear = now.getFullYear();
const curMonthNum = now.getMonth() + 1;
const pad2 = n => String(n).padStart(2, '0');
const curMonth = `${curYear}-${pad2(curMonthNum)}`;       // aktueller Monat
// Zweiter, DISTINKTER Monat im selben Jahr — damit sich Jahres- von Monatsbetrag
// unterscheidet. Januar → Februar, sonst → Januar (bleibt im aktuellen Jahr).
const otherMonthNum = curMonthNum === 1 ? 2 : 1;
const otherMonth = `${curYear}-${pad2(otherMonthNum)}`;

// Als Login-Helfer: Mitarbeiter per Name aus dem Login-Select auswählen.
async function loginAs(page, name) {
    await page.evaluate(n => {
        const sel = document.getElementById('loginName');
        const opt = Array.from(sel.options).find(o => o.textContent === n);
        sel.value = opt.value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }, name);
    await page.waitForTimeout(600);
}

// Limit-Karten aus „Meine Stunden" auslesen: { jahr, monat } als Text der Werte.
async function readLimits(page) {
    await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('#tabs button')).find(b => b.dataset.tab === 'mine');
        btn.click();
    });
    await page.waitForTimeout(300);
    return page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('#mineLimits .limit-card'));
        const out = {};
        cards.forEach(c => {
            const label = c.querySelector('.limit-label').textContent;
            const value = c.querySelector('.limit-value').textContent;
            if (/Jahresverdienst/.test(label)) out.jahr = value;
            else out.monat = value;
        });
        return out;
    });
}

(async () => {
    // -------- 1. Mit Pauschale: Monats- UND Jahresbetrag enthalten sie --------
    console.log('\n=== Limit-Anzeige: Pauschale im Monats-/Jahresbetrag ===');
    {
        const { browser, page } = await newPage();
        await page.evaluate(({ curMonth, otherMonth }) => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.settings.wageSingle = 14;
            // Normaler Mitarbeiter (kein Admin/Buchhaltung) mit 100-EUR-Pauschale,
            // Stichtag am Jahresanfang → gilt in beiden Testmonaten.
            data.employees.push({
                id: 700, name: 'LimitMA', password: 'paralox',
                isAdmin: false, isAccountant: false, rvBefreit: false,
                isActive: true, assignedTo: 'owner1',
                monatspauschale: 100, pauschaleAb: `${curMonth.slice(0, 4)}-01`,
                createdAt: '2025-01-01T00:00:00Z',
            });
            const mk = (id, date) => ({
                id, employeeId: 700, date,
                startTime: '10:00', endTime: '12:00', // 2 h à 14 EUR = 28 EUR Brutto
                room: 'FP', secondRoom: null, isDouble: false, note: '',
            });
            data.shifts.push(mk(7001, `${curMonth}-15`));   // aktueller Monat
            data.shifts.push(mk(7002, `${otherMonth}-15`)); // zweiter Monat (nur Jahr)
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        }, { curMonth, otherMonth });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(600);
        await loginAs(page, 'LimitMA');
        const lim = await readLimits(page);
        console.log('  Monat:', lim.monat, '| Jahr:', lim.jahr);
        // Monat: 28 (Schicht) + 100 (Pauschale) = 128,00 EUR.
        check('Monatsbetrag enthält Pauschale (128,00 EUR)', /128,00 EUR/.test(lim.monat || ''), lim.monat);
        // Jahr: 2× 28 (Schichten) + 2× 100 (Pauschale je Monat) = 256,00 EUR.
        check('Jahresbetrag enthält Pauschale beider Monate (256,00 EUR)', /256,00 EUR/.test(lim.jahr || ''), lim.jahr);
        await browser.close();
    }

    // -------- 2. Kontroll-Fall: ohne Pauschale bleibt es beim reinen Lohn --------
    console.log('\n=== Kontrolle: ohne Pauschale nur Schicht-Brutto ===');
    {
        const { browser, page } = await newPage();
        await page.evaluate(({ curMonth }) => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.settings.wageSingle = 14;
            data.employees.push({
                id: 701, name: 'OhnePauschaleMA', password: 'paralox',
                isAdmin: false, isAccountant: false, rvBefreit: false,
                isActive: true, assignedTo: 'owner1',
                monatspauschale: 0, pauschaleAb: '',
                createdAt: '2025-01-01T00:00:00Z',
            });
            data.shifts.push({
                id: 7101, employeeId: 701, date: `${curMonth}-15`,
                startTime: '10:00', endTime: '12:00',
                room: 'FP', secondRoom: null, isDouble: false, note: '',
            });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        }, { curMonth });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(600);
        await loginAs(page, 'OhnePauschaleMA');
        const lim = await readLimits(page);
        console.log('  Monat:', lim.monat, '| Jahr:', lim.jahr);
        // Nur 28,00 EUR — keine Pauschale, kein Aufschlag.
        check('Monatsbetrag = 28,00 EUR (kein Aufschlag)', /28,00 EUR/.test(lim.monat || '') && !/128,00 EUR/.test(lim.monat || ''), lim.monat);
        await browser.close();
    }

    console.log('\n' + (fails === 0
        ? '✓ ALLE PAUSCHALE-LIMIT-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
