/* Test: Buchhaltungs-Konten sehen in der Stundenliste und in den Exporten
 *  nur Schichten der letzten 90 Tage. Eigene Schichten in „Meine Stunden"
 *  bleiben unbegrenzt sichtbar. Admin sieht weiterhin alles.
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

function todayMinusDays(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${da}`;
}

/* Erzeugt einen Test-User mit gewünschter Rolle, fügt eine Reihe von Schichten
 * mit definierten Daten hinzu (recent + alt) und loggt sich ein. */
async function setupAndLogin(page, role) {
    await page.addInitScript(() => {
        // DSGVO-Popup vorab bestätigen, sonst überlagert es den Login.
        localStorage.setItem('paraloxStunden.dsgvoAccepted', new Date().toISOString());
        localStorage.setItem('paraloxStunden.backupPassword', 'TestPasswort12345');
    });
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
    await page.evaluate((r) => {
        const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
        data.employees.push({
            id: 99,
            name: 'Test-' + r,
            password: 'paralox',
            isAdmin: r === 'admin',
            isAccountant: r === 'buchhaltung',
            isActive: true,
            assignedTo: 'owner1',
            createdAt: new Date().toISOString(),
        });
        localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
    }, role);

    // Schichten einfügen: 3 frische (innerhalb 90 Tage), 3 alte (vor >90 Tage)
    const inWindow = [
        { id: 8001, days: 5,  uid: 1 },
        { id: 8002, days: 30, uid: 99 },
        { id: 8003, days: 80, uid: 1 },
    ];
    const outWindow = [
        { id: 8101, days: 100, uid: 1 },
        { id: 8102, days: 200, uid: 99 },
        { id: 8103, days: 365, uid: 1 },
    ];
    const all = [...inWindow, ...outWindow];
    await page.evaluate((arr) => {
        const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
        const dateOf = (days) => {
            const d = new Date(); d.setDate(d.getDate() - days);
            return d.toISOString().slice(0, 10);
        };
        arr.forEach(s => data.shifts.push({
            id: s.id, employeeId: s.uid, date: dateOf(s.days),
            startTime: '10:00', endTime: '14:00',
            room: 'R1', secondRoom: null, isDouble: false, note: '',
            createdAt: new Date().toISOString(),
        }));
        localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
    }, all);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
        const sel = document.getElementById('loginName');
        const opt = Array.from(sel.options).find(o => o.textContent.startsWith('Test-'));
        sel.value = opt.value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(
            new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(1000);
    return { inWindow, outWindow };
}

async function shiftIdsInAdminTable(page) {
    return page.evaluate(() => {
        const tab = document.querySelector('#tabs button[data-tab="shifts"]');
        if (tab) tab.click();
        return new Promise(resolve => setTimeout(() => {
            const rows = document.querySelectorAll('#shiftsTable tbody tr, #adminTable tbody tr, #view-shifts table tbody tr');
            const ids = Array.from(rows).map(r => r.dataset.id || r.dataset.shiftId).filter(Boolean);
            resolve(ids.map(Number));
        }, 400));
    });
}

async function shiftIdsInMineTable(page) {
    return page.evaluate(() => {
        const tab = document.querySelector('#tabs button[data-tab="mine"]');
        if (tab) tab.click();
        return new Promise(resolve => setTimeout(() => {
            const rows = document.querySelectorAll('#mineTable tbody tr');
            const ids = Array.from(rows).map(r => r.dataset.id || r.dataset.shiftId).filter(Boolean);
            resolve(ids.map(Number));
        }, 400));
    });
}

(async () => {
    // -------- Buchhaltung: Stundenliste begrenzt, Eigene unbegrenzt --------
    console.log('\n=== Buchhaltung sieht in Stundenliste nur die letzten 90 Tage ===');
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const { inWindow, outWindow } = await setupAndLogin(page, 'buchhaltung');

        const adminIds = await shiftIdsInAdminTable(page);
        const inIds = inWindow.map(s => s.id);
        const outIds = outWindow.map(s => s.id);
        check('Stundenliste enthält ALLE neuen Schichten (≤ 90 Tage)',
            inIds.every(id => adminIds.includes(id)),
            'erwartet: ' + inIds.join(',') + ' · gesehen: ' + adminIds.join(','));
        check('Stundenliste enthält KEINE alten Schichten (> 90 Tage)',
            outIds.every(id => !adminIds.includes(id)),
            'unerwartet sichtbar: ' + adminIds.filter(id => outIds.includes(id)).join(','));

        // „Meine Stunden" — eigene (uid 99) sollten alle sichtbar sein, auch alte
        const mineIds = await shiftIdsInMineTable(page);
        const ownIn = inWindow.filter(s => s.uid === 99).map(s => s.id);
        const ownOut = outWindow.filter(s => s.uid === 99).map(s => s.id);
        check('„Meine Stunden" zeigt eigene neue Schichten',
            ownIn.every(id => mineIds.includes(id)),
            'erwartet: ' + ownIn.join(',') + ' · gesehen: ' + mineIds.join(','));
        check('„Meine Stunden" zeigt AUCH eigene alte Schichten (> 90 Tage)',
            ownOut.every(id => mineIds.includes(id)),
            'fehlt: ' + ownOut.filter(id => !mineIds.includes(id)).join(','));

        await browser.close();
    }

    // -------- Admin sieht weiterhin alles --------
    console.log('\n=== Admin sieht in Stundenliste weiterhin alles (kein 90-Tage-Limit) ===');
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const { inWindow, outWindow } = await setupAndLogin(page, 'admin');

        const adminIds = await shiftIdsInAdminTable(page);
        const inIds = inWindow.map(s => s.id);
        const outIds = outWindow.map(s => s.id);
        check('Stundenliste enthält neue Schichten', inIds.every(id => adminIds.includes(id)),
            adminIds.join(','));
        check('Stundenliste enthält AUCH alte Schichten (Admin: kein Limit)',
            outIds.every(id => adminIds.includes(id)),
            'fehlt: ' + outIds.filter(id => !adminIds.includes(id)).join(','));

        await browser.close();
    }

    console.log('\n' + (fails === 0
        ? '✓ ALLE BUCHHALTUNG-90-TAGE-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
