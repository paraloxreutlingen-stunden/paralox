/* Tests für die Renten­versicherungs-Lohnberechnung:
 *  1. payoutInfo: rvBefreit=true → 0% Abzug; rvBefreit=false → 3,6% Abzug;
 *     custom rate (4,2%) wird respektiert; Cent-genaue Rundung.
 *  2. E2E: Mitarbeiter mit Häkchen anlegen, Schicht eintragen, Summary prüft
 *     Brutto/RV-Anteil/Auszahlung.
 *  3. Migration: bestehende Mitarbeiter ohne rvBefreit-Feld bekommen false.
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
    // -------- 1. Unit: payoutInfo --------
    console.log('\n=== Unit: payoutInfo (in der App-Konsole ausführen) ===');
    {
        const { browser, page } = await newPage();
        const r = await page.evaluate(() => {
            // payoutInfo ist module-private — wir reproduzieren die Logik gegen
            // ParaloxStorage-Settings, indem wir window-Funktion erzeugen
            // ODER wir setzen rvAnteil und prüfen via Mitarbeiter-Lohn.
            // Einfacher: Settings ändern, einen MA mit/ohne rvBefreit anlegen,
            // und die Summary nach einer Schicht prüfen.
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.settings.rvAnteilProzent = 3.6;
            data.settings.wageSingle = 14;
            data.employees.push({
                id: 100, name: 'TestPflichtig', password: 'paralox',
                isAdmin: true, isAccountant: false, rvBefreit: false,
                isActive: true, assignedTo: 'owner1',
                createdAt: new Date().toISOString(),
            });
            data.employees.push({
                id: 101, name: 'TestBefreit', password: 'paralox',
                isAdmin: true, isAccountant: false, rvBefreit: true,
                isActive: true, assignedTo: 'owner1',
                createdAt: new Date().toISOString(),
            });
            // 2 Stunden Einzel-Schicht à 14 EUR = 28 EUR Brutto pro MA
            // → RV-pflichtig: 28 * 0,036 = 1,008 → gerundet 1,01
            //   Auszahlung   = 28 - 1,01 = 26,99
            // → RV-befreit: 0 RV, 28 Auszahlung
            const mkShift = (id, empId) => ({
                id, employeeId: empId, date: '2026-04-15',
                startTime: '10:00', endTime: '12:00',
                room: 'FP', secondRoom: null, isDouble: false, note: '',
            });
            data.shifts.push(mkShift(1001, 100));
            data.shifts.push(mkShift(1002, 101));
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
            return true;
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(800);

        // Login als TestPflichtig (Admin) → Tab "Alle Schichten" → Filter auf TestPflichtig
        await page.evaluate(() => {
            const sel = document.getElementById('loginName');
            const opt = Array.from(sel.options).find(o => o.textContent === 'TestPflichtig');
            sel.value = opt.value;
            document.getElementById('loginPassword').value = 'paralox';
            document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        });
        await page.waitForTimeout(800);

        // Wechsle zu shifts-Tab (Admin landet default auf "enter")
        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('#tabs button')).find(b => b.dataset.tab === 'shifts');
            btn.click();
        });
        await page.waitForTimeout(500);

        // Filter auf TestPflichtig
        const summaryPflichtig = await page.evaluate(() => {
            const sel = document.getElementById('adminEmpFilter');
            const opt = Array.from(sel.options).find(o => o.textContent.startsWith('TestPflichtig'));
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return document.getElementById('adminSummary').textContent;
        });
        console.log('  TestPflichtig-Summary (Auszug):', summaryPflichtig.replace(/\s+/g, ' ').slice(0, 250));
        check('Brutto 28,00 EUR sichtbar', /28,00 EUR/.test(summaryPflichtig));
        check('RV-Anteil 1,01 EUR sichtbar (3,6%)', /1,01 EUR/.test(summaryPflichtig));
        check('Auszahlung 26,99 EUR sichtbar', /26,99 EUR/.test(summaryPflichtig));
        check('RV-Anteil-Label nennt "3,6%"', /3,6%/.test(summaryPflichtig));

        const summaryBefreit = await page.evaluate(() => {
            const sel = document.getElementById('adminEmpFilter');
            const opt = Array.from(sel.options).find(o => o.textContent.startsWith('TestBefreit'));
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return document.getElementById('adminSummary').textContent;
        });
        console.log('  TestBefreit-Summary (Auszug):', summaryBefreit.replace(/\s+/g, ' ').slice(0, 250));
        check('TestBefreit: Brutto 28,00 EUR', /28,00 EUR/.test(summaryBefreit));
        check('TestBefreit: Auszahlung 28,00 EUR (kein Abzug)',
            (summaryBefreit.match(/28,00 EUR/g) || []).length >= 2);
        check('TestBefreit: Label "befreit"', /befreit/i.test(summaryBefreit));

        await browser.close();
    }

    // -------- 2. Custom Rate 4,2% --------
    console.log('\n=== Custom Rate: 4,2% ===');
    {
        const { browser, page } = await newPage();
        await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.settings.rvAnteilProzent = 4.2;
            data.settings.wageSingle = 20;
            data.employees.push({
                id: 100, name: 'TestRate', password: 'paralox',
                isAdmin: true, isAccountant: false, rvBefreit: false,
                isActive: true, assignedTo: 'owner1',
                createdAt: new Date().toISOString(),
            });
            // 5 Stunden à 20 EUR = 100 EUR Brutto
            // → 100 * 0,042 = 4,20 RV
            //   95,80 Auszahlung
            data.shifts.push({
                id: 2001, employeeId: 100, date: '2026-04-15',
                startTime: '08:00', endTime: '13:00',
                room: 'FP', secondRoom: null, isDouble: false, note: '',
            });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(800);
        await page.evaluate(() => {
            const sel = document.getElementById('loginName');
            const opt = Array.from(sel.options).find(o => o.textContent === 'TestRate');
            sel.value = opt.value;
            document.getElementById('loginPassword').value = 'paralox';
            document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        });
        await page.waitForTimeout(800);
        const sumText = await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('#tabs button')).find(b => b.dataset.tab === 'shifts');
            btn.click();
            return new Promise(r => setTimeout(r, 300)).then(() => {
                const sel = document.getElementById('adminEmpFilter');
                const opt = Array.from(sel.options).find(o => o.textContent.startsWith('TestRate'));
                sel.value = opt.value;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                return document.getElementById('adminSummary').textContent;
            });
        });
        console.log('  Summary:', sumText.replace(/\s+/g, ' ').slice(0, 250));
        check('100,00 EUR Brutto', /100,00 EUR/.test(sumText));
        check('4,20 EUR RV-Anteil', /4,20 EUR/.test(sumText));
        check('95,80 EUR Auszahlung', /95,80 EUR/.test(sumText));
        check('Label "4,2%"', /4,2%/.test(sumText));
        await browser.close();
    }

    // -------- 3. Migration: alte Daten ohne rvBefreit-Feld --------
    console.log('\n=== Migration alter Mitarbeiter ohne rvBefreit ===');
    {
        const { browser, page } = await newPage();
        const result = await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            // simuliere alten Mitarbeiter ohne rvBefreit-Feld
            data.employees.push({
                id: 200, name: 'AlterMA', password: 'paralox',
                isAdmin: false, isAccountant: false,
                isActive: true, assignedTo: 'owner1',
                createdAt: '2025-01-01T00:00:00Z',
                // KEIN rvBefreit-Feld
            });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
            // normalize() sollte beim nächsten load() aufgerufen werden
            const reloaded = window.ParaloxStorage.load();
            return reloaded.employees.find(e => e.id === 200);
        });
        check('rvBefreit-Feld wurde nachgereicht', typeof result.rvBefreit === 'boolean');
        check('Default ist false (= RV-pflichtig)', result.rvBefreit === false);
        await browser.close();
    }

    // -------- 4. Mitarbeiter-Toggle UI (Admin klickt RV-Befreiung geben) --------
    console.log('\n=== UI: RV-Befreiungs-Toggle in Mitarbeiter-Liste ===');
    {
        const { browser, page } = await newPage();
        await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.employees.push({
                id: 300, name: 'ToggleMA', password: 'paralox',
                isAdmin: false, isAccountant: false, rvBefreit: false,
                isActive: true, assignedTo: 'owner1',
                createdAt: new Date().toISOString(),
            });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(500);
        await page.evaluate(() => {
            const sel = document.getElementById('loginName');
            const opt = Array.from(sel.options).find(o => o.textContent === 'Owner1');
            sel.value = opt.value;
            document.getElementById('loginPassword').value = 'paralox';
            document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        });
        await page.waitForTimeout(500);
        const before = await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('#tabs button')).find(b => b.dataset.tab === 'employees');
            btn.click();
            return new Promise(r => setTimeout(r, 300)).then(() => {
                const tr = Array.from(document.querySelectorAll('#empTable tbody tr'))
                    .find(t => t.textContent.includes('ToggleMA'));
                const text = tr.textContent;
                const rvBtn = tr.querySelector('[data-emp-rv]');
                return { text, btnText: rvBtn?.textContent, hasRvPflichtig: /RV-pflichtig/.test(text) };
            });
        });
        check('ToggleMA initial RV-pflichtig (Badge)', before.hasRvPflichtig);
        check('Toggle-Button heißt "RV-Befreiung geben"', /Befreiung geben/.test(before.btnText));

        const after = await page.evaluate(() => {
            const tr = Array.from(document.querySelectorAll('#empTable tbody tr'))
                .find(t => t.textContent.includes('ToggleMA'));
            tr.querySelector('[data-emp-rv]').click();
            return new Promise(r => setTimeout(r, 300)).then(() => {
                const tr2 = Array.from(document.querySelectorAll('#empTable tbody tr'))
                    .find(t => t.textContent.includes('ToggleMA'));
                const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
                const emp = data.employees.find(e => e.name === 'ToggleMA');
                return {
                    badgeText: tr2.textContent,
                    btnText: tr2.querySelector('[data-emp-rv]')?.textContent,
                    storedRvBefreit: emp.rvBefreit,
                };
            });
        });
        check('Badge wechselt zu "RV-befreit"', /RV-befreit/.test(after.badgeText));
        check('Toggle-Button wechselt zu "RV-Befreiung entziehen"', /Befreiung entziehen/.test(after.btnText));
        check('localStorage hat rvBefreit=true', after.storedRvBefreit === true);

        await browser.close();
    }

    console.log('\n' + (fails === 0
        ? '✓ ALLE RV-LOHNBERECHNUNGS-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
