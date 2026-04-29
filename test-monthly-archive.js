/* Tests für die Monatsabschluss-Mail (zusätzlich zur Tagessicherung):
 *  - Beim ersten Login eines neuen Monats wird (1× pro Monat) eine
 *    zusätzliche Share-Mail mit Vormonats-Daten ausgelöst.
 *  - Diese Mail enthält JSON + CSV. Minijob-PDF wenn jspdf-Lib geladen.
 *  - Marker LAST_MONTHLY in localStorage verhindert Mehrfach-Auslösung.
 *  - Wenn Vormonat keine Schichten hatte: kein Share, aber Marker wird
 *    gesetzt (kein wiederholter Versuch).
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

async function setupShareMock(page, behavior = 'success') {
    await page.addInitScript((b) => {
        const KEY = '__test_shareCalls';
        const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
        const save = (arr) => localStorage.setItem(KEY, JSON.stringify(arr));
        window.__shareBehavior = b;
        window.__getShareCalls = load;
        navigator.canShare = (data) => !!(data && data.files && data.files.length);
        navigator.share = async (data) => {
            const fileMetas = [];
            for (const f of (data.files || [])) {
                let text = null;
                try { text = await f.text(); } catch {}
                fileMetas.push({ name: f.name, type: f.type, size: f.size, hasText: !!text });
            }
            const arr = load();
            arr.push({ files: fileMetas, title: data.title, text: data.text });
            save(arr);
            if (window.__shareBehavior === 'abort') {
                const err = new Error('User cancelled');
                err.name = 'AbortError';
                throw err;
            }
        };
    }, behavior);
}

function previousMonthYYYYMM() {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

async function loginAsOwner1(page) {
    await page.evaluate(() => {
        const sel = document.getElementById('loginName');
        const opt = Array.from(sel.options).find(o => o.textContent === 'Owner1');
        sel.value = opt.value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(
            new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(1500);
}

(async () => {
    const prevMonth = previousMonthYYYYMM();

    // -------- 1. Login mit Vormonats-Schichten → 2 Share-Aufrufe (Tag + Monat) --------
    console.log(`\n=== Erster Login: Tagessicherung + Monatsabschluss für ${prevMonth} ===`);
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await setupShareMock(page, 'success');
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.evaluate((pm) => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.shifts.push({
                id: 7001, employeeId: 1, date: pm + '-15',
                startTime: '10:00', endTime: '14:00',
                room: 'FP', secondRoom: null, isDouble: false, note: 'Vormonats-Schicht',
                createdAt: new Date().toISOString(),
            });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        }, prevMonth);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(500);
        await loginAsOwner1(page);
        // sequentielle Share-Aufrufe → 2. wartet bis 1. fertig
        await page.waitForTimeout(1500);

        const calls = await page.evaluate(() => window.__getShareCalls());
        check('navigator.share wurde 2× aufgerufen (Tag + Monat)',
            calls.length === 2, 'count=' + calls.length);
        if (calls.length >= 2) {
            const monthly = calls[1];
            check('Monatsabschluss-Title nennt den Monat',
                /Monatsabschluss/.test(monthly.title || ''), monthly.title);
            const fileNames = monthly.files.map(f => f.name);
            check('Monatsabschluss enthält JSON',
                fileNames.some(n => n.endsWith('.json')), fileNames.join(', '));
            check('Monatsabschluss enthält CSV des Vormonats',
                fileNames.some(n => n.includes(prevMonth) && n.endsWith('.csv')),
                fileNames.join(', '));
        }

        const lastMonthly = await page.evaluate(() =>
            localStorage.getItem('paraloxStunden.lastMonthlyArchive'));
        check('lastMonthlyArchive-Marker auf Vormonat gesetzt',
            lastMonthly === prevMonth, lastMonthly);

        await browser.close();
    }

    // -------- 2. Vormonat keine Schichten → kein Monats-Share, Marker trotzdem gesetzt --------
    console.log('\n=== Vormonat ohne Schichten → kein Monatsabschluss-Share ===');
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await setupShareMock(page, 'success');
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(500);
        await loginAsOwner1(page);
        await page.waitForTimeout(1500);

        const calls = await page.evaluate(() => window.__getShareCalls());
        check('Nur 1× Share (Tagessicherung), kein Monatsabschluss',
            calls.length === 1, 'count=' + calls.length);
        const lastMonthly = await page.evaluate(() =>
            localStorage.getItem('paraloxStunden.lastMonthlyArchive'));
        check('Monats-Marker dennoch gesetzt (verhindert Wiederholungen)',
            lastMonthly === prevMonth, lastMonthly);

        await browser.close();
    }

    // -------- 3. Zweiter Login desselben Tages → kein Re-Trigger --------
    console.log('\n=== Zweiter Login (selber Tag, selber Monat) → kein Re-Trigger ===');
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await setupShareMock(page, 'success');
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.evaluate((pm) => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.shifts.push({
                id: 7002, employeeId: 1, date: pm + '-10',
                startTime: '10:00', endTime: '14:00',
                room: 'FP', secondRoom: null, isDouble: false, note: '',
                createdAt: new Date().toISOString(),
            });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        }, prevMonth);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(500);
        await loginAsOwner1(page);
        await page.waitForTimeout(1500);

        // Logout + erneuter Login
        await page.evaluate(() => document.getElementById('btnLogout').click());
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);
        await loginAsOwner1(page);
        await page.waitForTimeout(1500);

        const calls = await page.evaluate(() => window.__getShareCalls());
        check('Share-Aufrufe bleiben bei 2 (Tag+Monat) — kein Re-Trigger',
            calls.length === 2, 'count=' + calls.length);

        await browser.close();
    }

    // -------- 4. Monatsabschluss deaktiviert → nur Tagessicherung --------
    console.log('\n=== Monatsabschluss deaktiviert → nur Tagessicherung ===');
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await setupShareMock(page, 'success');
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.evaluate((pm) => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.settings.monthlyArchive.enabled = false;
            data.shifts.push({
                id: 7003, employeeId: 1, date: pm + '-15',
                startTime: '10:00', endTime: '14:00',
                room: 'FP', secondRoom: null, isDouble: false, note: '',
                createdAt: new Date().toISOString(),
            });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        }, prevMonth);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(500);
        await loginAsOwner1(page);
        await page.waitForTimeout(1500);

        const calls = await page.evaluate(() => window.__getShareCalls());
        check('Nur 1× Share (Tagessicherung)', calls.length === 1, 'count=' + calls.length);

        await browser.close();
    }

    console.log('\n' + (fails === 0
        ? '✓ ALLE MONATSABSCHLUSS-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
