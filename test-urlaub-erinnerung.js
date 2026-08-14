/* Test: Jährliche Resturlaubs-Erinnerung.
 *
 *  - Erscheint ab dem 30. März bis zum 30. Juni beim ersten Login eines
 *    Mitarbeiters und blockiert die App, bis "Gelesen und verstanden"
 *    geklickt wurde.
 *  - Vor dem 30. März und ab dem 1. Juli erscheint sie nicht.
 *  - Klick setzt paraloxStunden.vacationReminder (employeeId → ISO); im
 *    selben Jahr kommt sie danach auch nach Reload nicht wieder.
 *  - Im Folgejahr poppt sie trotz vorhandener Bestätigung erneut auf.
 *  - Gilt für jede Rolle — auch Buchhaltung und Admin. Die Bestätigung des
 *    einen entlässt die anderen nicht.
 *  - Ist zusätzlich der DSGVO-Consent offen, kommt erst DSGVO, danach die
 *    Urlaubs-Erinnerung — die Modals überlagern sich nicht.
 *
 * Datumsunabhängig: die Systemzeit der Seite wird pro Szenario gefälscht,
 * damit der Test nicht nur zwischen Ende März und Ende Juni grün ist.
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

/* Kontext mit fest verdrahtetem "heute". Die App liest das Datum über
 * new Date() (todayISO), deshalb reicht es, den Konstruktor ohne Argumente
 * und Date.now() umzubiegen — Date-Parsing mit Argumenten bleibt intakt,
 * sonst würden Schicht-Berechnungen kaputtgehen. */
async function openApp(browser, fakeToday) {
    const ctx = await browser.newContext();
    await ctx.addInitScript((iso) => {
        const RealDate = Date;
        const fixed = new RealDate(iso + 'T09:00:00').getTime();
        function FakeDate(...args) {
            return args.length === 0 ? new RealDate(fixed) : new RealDate(...args);
        }
        FakeDate.prototype = RealDate.prototype;
        FakeDate.now = () => fixed;
        FakeDate.parse = RealDate.parse;
        FakeDate.UTC = RealDate.UTC;
        window.Date = FakeDate;
    }, fakeToday);
    const page = await ctx.newPage();
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(500);
    return page;
}

/* DSGVO-Consent vorab quittieren — sonst liegt dessen Pflicht-Modal über der
 * Urlaubs-Erinnerung und verfälscht die Szenarien. Optional zusätzlich eine
 * fertige Urlaubs-Bestätigung setzen. */
async function seedMarkers(page, { dsgvoFor = ['1', '2', '99'], vacation = null } = {}) {
    await page.evaluate(({ ids, vac }) => {
        const map = {};
        ids.forEach(id => { map[id] = '2020-01-01T00:00:00.000Z'; });
        localStorage.setItem('paraloxStunden.dsgvoAccepted', JSON.stringify(map));
        if (vac) localStorage.setItem('paraloxStunden.vacationReminder', JSON.stringify(vac));
        else localStorage.removeItem('paraloxStunden.vacationReminder');
    }, { ids: dsgvoFor, vac: vacation });
}

/* Legt einen zusätzlichen Mitarbeiter an (Default: Buchhaltung). */
async function seedEmployee(page, { id, name, isAccountant = false, isAdmin = false }) {
    await page.evaluate(({ id, name, isAccountant, isAdmin }) => {
        const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
        if (!data.employees.some(e => e.id === id)) {
            data.employees.push({
                id, name, password: 'paralox',
                isAdmin, isAccountant, isActive: true,
                rvBefreit: false, assignedTo: 'owner1',
                createdAt: '2020-01-01T00:00:00.000Z',
            });
        }
        localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
    }, { id, name, isAccountant, isAdmin });
}

async function login(page, name) {
    await page.evaluate((n) => {
        const sel = document.getElementById('loginName');
        const opt = Array.from(sel.options).find(o => o.textContent === n);
        sel.value = opt.value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(
            new Event('submit', { cancelable: true, bubbles: true }));
    }, name);
    await page.waitForTimeout(800);
}

async function readModal(page) {
    return page.evaluate(() => {
        const m = document.getElementById('vacationReminderModal');
        const t = document.getElementById('vacationReminderText');
        const d = document.getElementById('dsgvoConsentModal');
        return {
            visible: !!m && !m.classList.contains('hidden'),
            dsgvoVisible: !!d && !d.classList.contains('hidden'),
            text: t ? t.textContent.replace(/\s+/g, ' ').trim() : null,
        };
    });
}

(async () => {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });

    // -------- 1. Im Fenster: Erinnerung erscheint und blockiert --------
    console.log('\n=== 02.04.: Erinnerung erscheint nach dem Login ===');
    {
        const page = await openApp(browser, '2027-04-02');
        await seedMarkers(page);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(400);

        let s = await readModal(page);
        check('Vor Login NICHT sichtbar', s.visible === false);

        await login(page, 'Admin');
        s = await readModal(page);
        check('Nach Login sichtbar', s.visible === true);
        check('Nennt die Frist 30. Juni des laufenden Jahres',
            /30\.\s*Juni\s*2027/.test(s.text), s.text);
        check('Nennt den Verfall', /verfällt/i.test(s.text));
        check('Spricht den Mitarbeiter mit Namen an', /Admin/.test(s.text));
        await page.context().close();
    }

    // -------- 2. Bestätigung: Marker gesetzt, kommt nicht wieder --------
    console.log('\n=== Klick "Gelesen und verstanden" quittiert für dieses Jahr ===');
    {
        const page = await openApp(browser, '2027-04-02');
        await seedMarkers(page);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        await login(page, 'Admin');

        await page.click('#vacationReminderBtn');
        await page.waitForTimeout(200);
        let s = await readModal(page);
        check('Nach Klick verborgen', s.visible === false);

        const map = await page.evaluate(() =>
            JSON.parse(localStorage.getItem('paraloxStunden.vacationReminder') || '{}'));
        check('Marker als User-ID-Map mit Zeitstempel gespeichert (Admin = id 1)',
            !!map['1'] && /^2027-\d{2}-\d{2}T/.test(map['1']), JSON.stringify(map));

        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(800);
        s = await readModal(page);
        check('Nach Reload im selben Jahr verborgen', s.visible === false);
        await page.context().close();
    }

    // -------- 3. Außerhalb des Fensters --------
    console.log('\n=== Außerhalb des Fensters: kein Popup ===');
    for (const [datum, label] of [['2027-03-29', 'Tag vor dem Stichtag'],
                                  ['2027-07-01', 'nach dem 30. Juni'],
                                  ['2027-12-15', 'Dezember']]) {
        const page = await openApp(browser, datum);
        await seedMarkers(page);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        await login(page, 'Admin');
        const s = await readModal(page);
        check(`${datum} (${label}): kein Popup`, s.visible === false);
        await page.context().close();
    }

    // -------- 4. Genau am Stichtag 30.03. --------
    console.log('\n=== Stichtag 30.03. selbst löst aus ===');
    {
        const page = await openApp(browser, '2027-03-30');
        await seedMarkers(page);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        await login(page, 'Admin');
        const s = await readModal(page);
        check('30.03. zeigt die Erinnerung', s.visible === true);
        await page.context().close();
    }
    console.log('\n=== Letzter Tag 30.06. zeigt noch, 01.07. nicht mehr ===');
    {
        const page = await openApp(browser, '2027-06-30');
        await seedMarkers(page);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        await login(page, 'Admin');
        const s = await readModal(page);
        check('30.06. zeigt die Erinnerung noch', s.visible === true);
        await page.context().close();
    }

    // -------- 5. Folgejahr: trotz Bestätigung wieder da --------
    console.log('\n=== Folgejahr: Bestätigung von 2027 gilt 2028 nicht mehr ===');
    {
        const page = await openApp(browser, '2028-04-02');
        await seedMarkers(page, { vacation: { '1': '2027-04-02T09:00:00.000Z' } });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        await login(page, 'Admin');
        const s = await readModal(page);
        check('2028 erscheint die Erinnerung erneut', s.visible === true);
        check('Frist ist jetzt der 30. Juni 2028', /30\.\s*Juni\s*2028/.test(s.text), s.text);
        await page.context().close();
    }

    // -------- 6. Gilt für alle Rollen --------
    console.log('\n=== Jede Rolle muss bestätigen (Buchhaltung inklusive) ===');
    {
        const page = await openApp(browser, '2027-04-02');
        await seedMarkers(page);
        await seedEmployee(page, { id: 98, name: 'Buchhalter', isAccountant: true });
        await seedEmployee(page, { id: 99, name: 'Zweite' });
        await page.evaluate(() => {
            const m = JSON.parse(localStorage.getItem('paraloxStunden.dsgvoAccepted'));
            m['98'] = '2020-01-01T00:00:00.000Z';
            localStorage.setItem('paraloxStunden.dsgvoAccepted', JSON.stringify(m));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(400);

        await login(page, 'Buchhalter');
        let s = await readModal(page);
        check('Buchhaltungs-Rolle sieht die Erinnerung ebenfalls', s.visible === true);
        check('Anrede "Buchhalter"', /Buchhalter/.test(s.text), s.text.slice(0, 60));
        // Quittierung gilt nur für DIESEN User — der nächste muss selbst klicken.
        await page.click('#vacationReminderBtn');
        await page.waitForTimeout(200);

        await page.evaluate(() => document.getElementById('btnLogout').click());
        await page.waitForTimeout(400);
        await login(page, 'Zweite');
        s = await readModal(page);
        check('Normaler Mitarbeiter muss trotzdem selbst bestätigen', s.visible === true);
        check('Anrede mit dem richtigen Namen', /Zweite/.test(s.text), s.text.slice(0, 60));

        const map = await page.evaluate(() =>
            JSON.parse(localStorage.getItem('paraloxStunden.vacationReminder') || '{}'));
        check('Nur die Buchhaltungs-ID (98) ist quittiert, nicht die des Mitarbeiters (99)',
            !!map['98'] && !map['99'], JSON.stringify(map));
        await page.context().close();
    }

    // -------- 7. Reihenfolge mit dem DSGVO-Pflicht-Modal --------
    console.log('\n=== Beide Pflicht-Modals offen: erst DSGVO, dann Urlaub ===');
    {
        const page = await openApp(browser, '2027-04-02');
        await page.evaluate(() => {
            localStorage.removeItem('paraloxStunden.dsgvoAccepted');
            localStorage.removeItem('paraloxStunden.vacationReminder');
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        await login(page, 'Admin');

        let s = await readModal(page);
        check('DSGVO-Modal ist offen', s.dsgvoVisible === true);
        check('Urlaubs-Erinnerung wartet noch', s.visible === false);

        await page.click('#dsgvoConsentBtn');
        await page.waitForTimeout(300);
        s = await readModal(page);
        check('Nach DSGVO-Bestätigung erscheint die Urlaubs-Erinnerung', s.visible === true);
        check('DSGVO-Modal ist zu', s.dsgvoVisible === false);
        await page.context().close();
    }

    await browser.close();
    console.log('\n' + (fails === 0
        ? '✓ ALLE URLAUBS-ERINNERUNG-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
