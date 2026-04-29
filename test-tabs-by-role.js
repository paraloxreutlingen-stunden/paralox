/* Prüft die Tab-Sichtbarkeit für jede Rolle:
 *  - normaler Mitarbeiter (kein Admin, kein Buchhalter): enter, mine
 *  - Buchhaltung (isAccountant): enter, mine, shifts, employees, settings
 *  - Admin (isAdmin):            enter, mine, shifts, employees, settings, pinboard
 */
'use strict';
const { chromium } = require('playwright-core');
const APP_URL = process.env.PARALOX_URL || 'http://127.0.0.1:8080/paralox-stunden.html';
const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

let fails = 0;
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function check(label, cond, detail) {
    const m = cond ? '✓' : '✗';
    console.log(`  ${m} ${label}${detail ? ': ' + detail : ''}`);
    if (!cond) fails++;
}

async function loginAs(role) {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });

    // Storage so präparieren, dass wir einen passenden User direkt einloggen können
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

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    const ok = await page.evaluate(() => {
        const sel = document.getElementById('loginName');
        const opt = Array.from(sel.options).find(o => o.textContent.startsWith('Test-'));
        if (!opt) return false;
        sel.value = opt.value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        return true;
    });
    if (!ok) { await browser.close(); throw new Error('Test-User nicht im Select'); }
    await page.waitForTimeout(800);

    const tabs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('#tabs button')).map(b => b.dataset.tab);
    });
    const activeTab = await page.evaluate(() => {
        return document.querySelector('#tabs button.active')?.dataset.tab || null;
    });

    await browser.close();
    return { tabs, activeTab };
}

(async () => {
    console.log('\n=== Rolle: Mitarbeiter (kein Admin, kein Buchhalter) ===');
    const r1 = await loginAs('mitarbeiter');
    console.log('  tabs:', r1.tabs, 'active:', r1.activeTab);
    check('Tabs: enter, mine', eq(r1.tabs, ['enter', 'mine']));
    check('Default-Tab: enter', r1.activeTab === 'enter');

    console.log('\n=== Rolle: Buchhaltung ===');
    const r2 = await loginAs('buchhaltung');
    console.log('  tabs:', r2.tabs, 'active:', r2.activeTab);
    check('Tabs enthalten enter (Bug-Fix)', r2.tabs.includes('enter'));
    check('Tabs enthalten mine', r2.tabs.includes('mine'));
    check('Tabs enthalten shifts', r2.tabs.includes('shifts'));
    check('Tabs enthalten employees', r2.tabs.includes('employees'));
    check('Tabs enthalten settings', r2.tabs.includes('settings'));
    check('Tabs enthalten KEIN pinboard', !r2.tabs.includes('pinboard'));
    check('Default-Tab: shifts (Auswertung)', r2.activeTab === 'shifts');

    console.log('\n=== Rolle: Admin ===');
    const r3 = await loginAs('admin');
    console.log('  tabs:', r3.tabs, 'active:', r3.activeTab);
    check('Tabs enthalten alle inkl. pinboard',
        ['enter','mine','shifts','employees','settings','pinboard'].every(t => r3.tabs.includes(t)));
    check('Default-Tab: enter', r3.activeTab === 'enter');

    console.log('\n' + (fails === 0 ? '✓ ALLE TAB-ROLLEN-TESTS BESTANDEN' : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
