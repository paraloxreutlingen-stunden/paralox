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
            // 15 Stunden Einzel-Schicht à 14 EUR = 210 EUR Brutto pro MA.
            // Bewusst ÜBER der Mindestbeitragsbemessungsgrundlage (175 EUR),
            // damit hier der reguläre Prozentsatz greift und nicht die
            // Mindestbeitragslogik (die wird unten separat geprüft).
            // → RV-pflichtig: 210 * 0,036 = 7,56 → Auszahlung 202,44
            // → RV-befreit:   0 RV          → Auszahlung 210,00
            const mkShift = (id, empId) => ({
                id, employeeId: empId, date: '2026-04-15',
                startTime: '08:00', endTime: '23:00',
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
        check('Brutto 210,00 EUR sichtbar', /210,00 EUR/.test(summaryPflichtig));
        check('RV-Anteil 7,56 EUR sichtbar (3,6%)', /7,56 EUR/.test(summaryPflichtig));
        check('Auszahlung 202,44 EUR sichtbar', /202,44 EUR/.test(summaryPflichtig));
        check('RV-Anteil-Label nennt "3,6%"', /3,6%/.test(summaryPflichtig));

        const summaryBefreit = await page.evaluate(() => {
            const sel = document.getElementById('adminEmpFilter');
            const opt = Array.from(sel.options).find(o => o.textContent.startsWith('TestBefreit'));
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return document.getElementById('adminSummary').textContent;
        });
        console.log('  TestBefreit-Summary (Auszug):', summaryBefreit.replace(/\s+/g, ' ').slice(0, 250));
        check('TestBefreit: Brutto 210,00 EUR', /210,00 EUR/.test(summaryBefreit));
        check('TestBefreit: Auszahlung 210,00 EUR (kein Abzug)',
            (summaryBefreit.match(/210,00 EUR/g) || []).length >= 2);
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
            // 10 Stunden à 20 EUR = 200 EUR Brutto (über der 175-EUR-Schwelle,
            // damit der eingestellte Prozentsatz greift).
            // → 200 * 0,042 = 8,40 RV → 191,60 Auszahlung
            data.shifts.push({
                id: 2001, employeeId: 100, date: '2026-04-15',
                startTime: '08:00', endTime: '18:00',
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
        check('200,00 EUR Brutto', /200,00 EUR/.test(sumText));
        check('8,40 EUR RV-Anteil', /8,40 EUR/.test(sumText));
        check('191,60 EUR Auszahlung', /191,60 EUR/.test(sumText));
        check('Label "4,2%"', /4,2%/.test(sumText));
        await browser.close();
    }

    // -------- 2b. Mindestbeitragsbemessung: Brutto unter 175 EUR --------
    // Deckt den Pfad ab, den die Abschnitte 1 und 2 bewusst NICHT nehmen (sie
    // liegen über der Schwelle). Brutto 150 EUR < 175 EUR:
    //   AG-Pauschale 15 % von 150      = 22,50
    //   AN-Anteil = 32,55 (Mindestbeitrag) − 22,50 = 10,05
    //   Auszahlung = 150,00 − 10,05    = 139,95
    // Der AN-Anteil ist damit HÖHER als die glatten 3,6 % (5,40) — genau das ist
    // der Sinn der Mindestbeitragsbemessungsgrundlage.
    console.log('\n=== Mindestbeitragsbemessung: Brutto 150 EUR (< 175 EUR) ===');
    {
        const { browser, page } = await newPage();
        await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.settings.rvAnteilProzent = 3.6;
            data.settings.wageHistory = [{ gueltigAb: '2026-01-01', single: 15, double: 18 }];
            data.employees.push({
                id: 150, name: 'TestMindest', password: 'paralox',
                isAdmin: true, isAccountant: false, rvBefreit: false,
                isActive: true, assignedTo: 'owner1',
                monatspauschale: 0, pauschaleAb: '',
                createdAt: new Date().toISOString(),
            });
            // 10 Stunden à 15 EUR = 150 EUR Brutto.
            data.shifts.push({
                id: 1501, employeeId: 150, date: '2026-04-15',
                startTime: '08:00', endTime: '18:00',
                room: 'FP', secondRoom: null, isDouble: false, note: '',
            });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(800);
        await page.evaluate(() => {
            const sel = document.getElementById('loginName');
            const opt = Array.from(sel.options).find(o => o.textContent === 'TestMindest');
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
                const opt = Array.from(sel.options).find(o => o.textContent.startsWith('TestMindest'));
                sel.value = opt.value;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                return document.getElementById('adminSummary').textContent;
            });
        });
        console.log('  Summary:', sumText.replace(/\s+/g, ' ').slice(0, 260));
        check('150,00 EUR Brutto', /150,00 EUR/.test(sumText));
        check('RV-Anteil 10,05 EUR (Mindestbeitrag, nicht 5,40 = 3,6%)',
            /10,05 EUR/.test(sumText) && !/5,40 EUR/.test(sumText));
        check('Auszahlung 139,95 EUR', /139,95 EUR/.test(sumText));
        check('Label nennt den Mindestbeitrag', /Mindestbeitrag/.test(sumText));
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
        check('rvHistorie wurde nachgereicht', Array.isArray(result.rvHistorie) && result.rvHistorie.length === 1,
            JSON.stringify(result.rvHistorie));
        check('Migrationseintrag übernimmt den bisherigen Status (befreit=false)',
            result.rvHistorie[0].befreit === false, JSON.stringify(result.rvHistorie[0]));
        await browser.close();
    }

    // -------- 4. Mitarbeiter-UI: "RV-Status ändern" schreibt datierten Eintrag --------
    console.log('\n=== UI: "RV-Status ändern" legt datierten Historien-Eintrag an ===');
    {
        const { browser, page } = await newPage();
        await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.employees.push({
                id: 300, name: 'ToggleMA', password: 'paralox',
                isAdmin: false, isAccountant: false, rvBefreit: false,
                isActive: true, assignedTo: 'owner1',
                createdAt: '2025-01-01T00:00:00Z',
                // Früher datierter Anker, damit der Wechsel auf 2026-08 einen
                // ZWEITEN Historien-Eintrag erzeugt (sonst — ohne Schichten —
                // ankert normalize auf den aktuellen Monat, und ein Wechsel im
                // selben Monat würde nur den Anker ersetzen statt einen Wechsel
                // anzulegen). So ist der Test unabhängig vom heutigen Datum.
                rvHistorie: [{ gueltigAb: '2025-01', befreit: false }],
            });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(500);
        // Seed-Admin heißt generisch "Admin" (keine echten Namen im Repo).
        await page.evaluate(() => {
            const sel = document.getElementById('loginName');
            const opt = Array.from(sel.options).find(o => o.textContent === 'Admin');
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
                return { btnText: rvBtn?.textContent, hasRvPflichtig: /RV-pflichtig/.test(text) };
            });
        });
        check('ToggleMA initial RV-pflichtig (Badge)', before.hasRvPflichtig);
        check('Button heißt "RV-Status ändern"', /RV-Status ändern/.test(before.btnText || ''), before.btnText);

        // Dialog: Status "befreit" ab 2026-08 setzen.
        await page.evaluate(() => {
            const tr = Array.from(document.querySelectorAll('#empTable tbody tr'))
                .find(t => t.textContent.includes('ToggleMA'));
            tr.querySelector('[data-emp-rv]').click();
        });
        await page.waitForTimeout(200);
        const after = await page.evaluate(() => {
            document.getElementById('pm_0').value = 'befreit';
            document.getElementById('pm_1').value = '2026-08';
            document.getElementById('modalOk').click();
            return new Promise(r => setTimeout(r, 300)).then(() => {
                const tr2 = Array.from(document.querySelectorAll('#empTable tbody tr'))
                    .find(t => t.textContent.includes('ToggleMA'));
                const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
                const emp = data.employees.find(e => e.name === 'ToggleMA');
                return {
                    badgeText: tr2.textContent,
                    hist: emp.rvHistorie,
                    storedRvBefreit: emp.rvBefreit,
                };
            });
        });
        check('Badge zeigt jetzt "RV-befreit"', /RV-befreit/.test(after.badgeText));
        check('Badge nennt den Stichtag "ab 2026-08"', /ab 2026-08/.test(after.badgeText), after.badgeText.replace(/\s+/g, ' ').trim());
        check('rvHistorie hat einen Eintrag ab 2026-08 mit befreit=true',
            Array.isArray(after.hist) && after.hist.some(h => h.gueltigAb === '2026-08' && h.befreit === true),
            JSON.stringify(after.hist));
        check('rvHistorie ist chronologisch sortiert',
            after.hist.every((h, i) => i === 0 || after.hist[i - 1].gueltigAb <= h.gueltigAb),
            JSON.stringify(after.hist.map(h => h.gueltigAb)));
        check('rvBefreit spiegelt den jüngsten Eintrag (true)', after.storedRvBefreit === true);

        await browser.close();
    }

    console.log('\n' + (fails === 0
        ? '✓ ALLE RV-LOHNBERECHNUNGS-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
