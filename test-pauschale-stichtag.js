/* Tests für den Monatspauschale-Stichtag (pauschaleAb):
 *  1. Migration: bestehender MA mit Pauschale > 0 ohne pauschaleAb bekommt
 *     '2026-06'; MA ohne Pauschale bekommt '' (keine Beschränkung).
 *  2. Berechnung: Pauschale greift NUR in Monaten ab dem Stichtag. Schicht im
 *     Vormonat (vor Stichtag) zählt keine Pauschale, Schicht ab Stichtag schon.
 *  3. UI: "Pauschale ändern"-Dialog setzt Betrag + Stichtag; Badge zeigt "ab".
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

async function newPage() {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(500);
    return { browser, page };
}

(async () => {
    // -------- 1. Migration: pauschaleAb wird nachgereicht --------
    console.log('\n=== Migration: pauschaleAb für bestehende Daten ===');
    {
        const { browser, page } = await newPage();
        const result = await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            // Alter MA MIT Pauschale, aber OHNE pauschaleAb-Feld
            data.employees.push({
                id: 400, name: 'PauschaleAlt', password: 'paralox',
                isAdmin: false, isAccountant: false, rvBefreit: false,
                isActive: true, assignedTo: 'owner1', monatspauschale: 50,
                createdAt: '2025-01-01T00:00:00Z',
                // KEIN pauschaleAb
            });
            // Alter MA OHNE Pauschale, OHNE pauschaleAb-Feld
            data.employees.push({
                id: 401, name: 'OhnePauschale', password: 'paralox',
                isAdmin: false, isAccountant: false, rvBefreit: false,
                isActive: true, assignedTo: 'owner1', monatspauschale: 0,
                createdAt: '2025-01-01T00:00:00Z',
            });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
            const reloaded = window.ParaloxStorage.load();
            return {
                mit: reloaded.employees.find(e => e.id === 400),
                ohne: reloaded.employees.find(e => e.id === 401),
            };
        });
        check('MA mit Pauschale: pauschaleAb = "2026-06"', result.mit.pauschaleAb === '2026-06', result.mit.pauschaleAb);
        check('MA ohne Pauschale: pauschaleAb = "" (leer)', result.ohne.pauschaleAb === '', JSON.stringify(result.ohne.pauschaleAb));
        await browser.close();
    }

    // -------- 2. Berechnung: Pauschale erst ab Stichtag --------
    console.log('\n=== Berechnung: Pauschale nur ab Stichtag (2026-06) ===');
    {
        const { browser, page } = await newPage();
        await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.settings.rvAnteilProzent = 3.6;
            data.settings.wageSingle = 14;
            data.employees.push({
                id: 500, name: 'StichtagMA', password: 'paralox',
                isAdmin: true, isAccountant: false, rvBefreit: true,
                isActive: true, assignedTo: 'owner1',
                monatspauschale: 50, pauschaleAb: '2026-06',
                createdAt: new Date().toISOString(),
            });
            // 2h à 14 EUR = 28 EUR Brutto je Monat.
            const mk = (id, date) => ({
                id, employeeId: 500, date,
                startTime: '10:00', endTime: '12:00',
                room: 'FP', secondRoom: null, isDouble: false, note: '',
            });
            data.shifts.push(mk(5001, '2026-05-15')); // VOR Stichtag → keine Pauschale
            data.shifts.push(mk(5002, '2026-06-15')); // AB Stichtag  → 50 EUR Pauschale
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(800);
        await page.evaluate(() => {
            const sel = document.getElementById('loginName');
            const opt = Array.from(sel.options).find(o => o.textContent === 'StichtagMA');
            sel.value = opt.value;
            document.getElementById('loginPassword').value = 'paralox';
            document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        });
        await page.waitForTimeout(800);
        const sumText = await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('#tabs button')).find(b => b.dataset.tab === 'shifts');
            btn.click();
            return new Promise(r => setTimeout(r, 300)).then(() => {
                // Zeitraum auf "Alle" (beide Monate), Filter auf StichtagMA
                const y = document.getElementById('adminYear');
                const mo = document.getElementById('adminMonth');
                if (y) { y.value = ''; y.dispatchEvent(new Event('change', { bubbles: true })); }
                if (mo) { mo.value = ''; mo.dispatchEvent(new Event('change', { bubbles: true })); }
                const sel = document.getElementById('adminEmpFilter');
                const opt = Array.from(sel.options).find(o => o.textContent.startsWith('StichtagMA'));
                sel.value = opt.value;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                return document.getElementById('adminSummary').textContent;
            });
        });
        console.log('  Summary:', sumText.replace(/\s+/g, ' ').slice(0, 300));
        // Schicht-Brutto 28 + 28 = 56; Pauschale nur 1× 50 = 50 → Brutto 106,00.
        check('Brutto inkl. Pauschale = 106,00 EUR', /106,00 EUR/.test(sumText));
        check('davon Pauschale für genau 1 Monat', /Pauschale \(1 Monat\)/.test(sumText));
        check('Pauschale-Betrag 50,00 EUR (nicht 100,00)', /50,00 EUR/.test(sumText) && !/100,00 EUR/.test(sumText));
        await browser.close();
    }

    // -------- 3. UI: Dialog setzt Betrag + Stichtag, Badge zeigt "ab" --------
    console.log('\n=== UI: "Pauschale ändern" setzt Betrag + Stichtag ===');
    {
        const { browser, page } = await newPage();
        await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.employees.push({
                id: 600, name: 'DialogMA', password: 'paralox',
                isAdmin: false, isAccountant: false, rvBefreit: false,
                isActive: true, assignedTo: 'owner1', monatspauschale: 0, pauschaleAb: '',
                createdAt: new Date().toISOString(),
            });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(500);
        await page.evaluate(() => {
            const sel = document.getElementById('loginName');
            const opt = Array.from(sel.options).find(o => o.textContent === 'Admin');
            sel.value = opt.value;
            document.getElementById('loginPassword').value = 'paralox';
            document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        });
        await page.waitForTimeout(500);
        // Mitarbeiter-Tab öffnen, Dialog für DialogMA starten
        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('#tabs button')).find(b => b.dataset.tab === 'employees');
            btn.click();
        });
        await page.waitForTimeout(300);
        await page.evaluate(() => {
            const tr = Array.from(document.querySelectorAll('#empTable tbody tr'))
                .find(t => t.textContent.includes('DialogMA'));
            tr.querySelector('[data-emp-pauschale]').click();
        });
        await page.waitForTimeout(200);
        // Betrag 75, Stichtag 2026-07 eingeben und bestätigen
        const stored = await page.evaluate(() => {
            document.getElementById('pm_0').value = '75';
            document.getElementById('pm_1').value = '2026-07';
            document.getElementById('modalOk').click();
            return new Promise(r => setTimeout(r, 300)).then(() => {
                const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
                const emp = data.employees.find(e => e.id === 600);
                const tr = Array.from(document.querySelectorAll('#empTable tbody tr'))
                    .find(t => t.textContent.includes('DialogMA'));
                return { mp: emp.monatspauschale, ab: emp.pauschaleAb, badge: tr.textContent };
            });
        });
        check('monatspauschale gespeichert = 75', stored.mp === 75, String(stored.mp));
        check('pauschaleAb gespeichert = "2026-07"', stored.ab === '2026-07', stored.ab);
        check('Badge zeigt "ab 2026-07"', /ab 2026-07/.test(stored.badge));
        await browser.close();
    }

    console.log('\n' + (fails === 0
        ? '✓ ALLE PAUSCHALE-STICHTAG-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
