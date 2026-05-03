/* Test: DSGVO-Hinweis erscheint als Consent-Popup beim ALLERERSTEN Besuch
 * und ist dynamisch:
 *  - dailyBackup.enabled=false + monthlyArchive.enabled=false →
 *    kurzer Lokal-Speicherungs-Text
 *  - dailyBackup.enabled=true → erweiterter Text mit Empfänger,
 *    Auftragsverarbeiter (GMX, 1&1), Rechtsgrundlage (Art. 6 Abs. 1 lit. f).
 *  - Nach Klick auf "Verstanden, weiter" wird der Marker
 *    paraloxStunden.dsgvoAccepted gesetzt und das Popup nie wieder gezeigt.
 *  - Bei einem Re-Load mit gesetztem Marker bleibt das Popup verborgen.
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

async function readNotice(page) {
    return page.evaluate(() => {
        const modal = document.getElementById('dsgvoConsentModal');
        const el = document.getElementById('dsgvoNotice');
        return {
            modalVisible: !!modal && !modal.classList.contains('hidden'),
            text: el ? el.textContent.replace(/\s+/g, ' ').trim() : null,
            html: el ? el.innerHTML : null,
        };
    });
}

/* Vor jedem Test-Szenario gerätespezifische Werte (Empfänger, Verantwortliche
 * Stelle) ins localStorage schreiben — der öffentliche Quellcode enthält diese
 * Werte bewusst NICHT mehr (kein Daten-Leak via GitHub). */
async function seedDeviceSettings(page, dataController, recipient) {
    await page.evaluate(({ dc, r }) => {
        const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
        data.settings.dataController = dc;
        if (r !== null) {
            data.settings.dailyBackup.recipient = r;
            data.settings.monthlyArchive.recipient = r;
        }
        localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
    }, { dc: dataController, r: recipient });
}

/* Login als Default-Admin "Admin" mit Passwort "paralox" — DSGVO-Popup
 * erscheint jetzt erst NACH dem Login (pro Mitarbeiter), nicht mehr im
 * Login-View. */
async function loginAsAdmin(page) {
    await page.evaluate(() => {
        const sel = document.getElementById('loginName');
        const opt = Array.from(sel.options).find(o => o.textContent === 'Admin');
        sel.value = opt.value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(
            new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(800);
}

(async () => {
    // -------- 1. Erstes Login: Popup erscheint NACH dem Login --------
    console.log('\n=== Erstes Login: Pflicht-Popup erscheint nach Login ===');
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(500);
        await seedDeviceSettings(page, 'Test-Firma GbR, Teststraße 1, 12345 Teststadt', 'backup@example.org');
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(500);

        // Popup darf VOR dem Login NICHT erscheinen
        let n = await readNotice(page);
        check('Vor Login: Consent-Popup ist NICHT sichtbar',
            n.modalVisible === false);

        await loginAsAdmin(page);
        n = await readNotice(page);
        check('Nach Login: Consent-Popup ist sichtbar',
            n.modalVisible === true);
        check('Hinweis enthält "Tagessicherung per E-Mail (aktiv)"',
            /Tagessicherung per E-Mail \(aktiv\)/.test(n.text), n.text.slice(0, 80));
        check('Hinweis enthält den gerätespezifischen Empfänger',
            /backup@example\.org/.test(n.text));
        check('Hinweis nennt Auftragsverarbeiter (1&1 / GMX)',
            /1&1|GMX/.test(n.text));
        check('Hinweis nennt Rechtsgrundlage Art. 6 Abs. 1 lit. f',
            /Art\.\s*6\s*Abs\.\s*1\s*lit\.\s*f/.test(n.text));
        check('Hinweis enthält die gerätespezifische Verantwortliche Stelle',
            /Test-Firma GbR/.test(n.text));
        await browser.close();
    }

    // -------- 1b. Klick setzt Marker pro User, Reload → Popup bleibt weg --------
    console.log('\n=== Bestätigung: Marker pro User-ID gesetzt, Popup kommt für DIESEN User nicht wieder ===');
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(500);
        await loginAsAdmin(page);

        let n = await readNotice(page);
        check('Popup nach Login sichtbar', n.modalVisible === true);

        await page.click('#dsgvoConsentBtn');
        await page.waitForTimeout(200);

        n = await readNotice(page);
        check('Popup nach Klick verborgen', n.modalVisible === false);

        const map = await page.evaluate(() =>
            JSON.parse(localStorage.getItem('paraloxStunden.dsgvoAccepted') || '{}'));
        check('Marker als User-ID-Map gespeichert (Admin = id 1)',
            map['1'] && /^\d{4}-\d{2}-\d{2}T/.test(map['1']),
            JSON.stringify(map));

        // Reload → Popup darf für diesen User nicht erneut erscheinen
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(800);
        n = await readNotice(page);
        check('Nach Reload bleibt Popup für denselben User verborgen',
            n.modalVisible === false);

        await browser.close();
    }

    // -------- 1c. Neuer Mitarbeiter sieht Popup beim ersten Login --------
    console.log('\n=== Zweiter Mitarbeiter: muss eigene Bestätigung leisten ===');
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(500);

        // Admin-Bestätigung simulieren + zweiten Mitarbeiter anlegen
        await page.evaluate(() => {
            localStorage.setItem('paraloxStunden.dsgvoAccepted',
                JSON.stringify({ '1': new Date().toISOString() }));
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.employees.push({
                id: 99, name: 'Zweite', password: 'paralox',
                isAdmin: false, isAccountant: false, isActive: true,
                rvBefreit: false, assignedTo: 'owner1',
                createdAt: new Date().toISOString(),
            });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(500);

        // Login als "Zweite"
        await page.evaluate(() => {
            const sel = document.getElementById('loginName');
            const opt = Array.from(sel.options).find(o => o.textContent === 'Zweite');
            sel.value = opt.value;
            document.getElementById('loginPassword').value = 'paralox';
            document.getElementById('loginForm').dispatchEvent(
                new Event('submit', { cancelable: true, bubbles: true }));
        });
        await page.waitForTimeout(800);

        const n = await readNotice(page);
        check('Zweiter Mitarbeiter sieht Popup beim ersten Login',
            n.modalVisible === true);

        await browser.close();
    }

    // -------- 1d. Settings: "Datenschutz-Hinweis ansehen" zeigt nur an --------
    console.log('\n=== Settings-Knopf "Ansehen": kein Reset, nur Anzeige ===');
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(500);
        await loginAsAdmin(page);
        // Pflicht-Popup wegklicken
        await page.click('#dsgvoConsentBtn');
        await page.waitForTimeout(200);

        // In Settings wechseln und Knopf klicken
        await page.click('[data-tab="settings"]');
        await page.waitForTimeout(200);
        await page.click('#settingsShowDsgvo');
        await page.waitForTimeout(200);

        const st = await page.evaluate(() => ({
            modalVisible: !document.getElementById('dsgvoConsentModal').classList.contains('hidden'),
            consentBtnHidden: document.getElementById('dsgvoConsentBtn').classList.contains('hidden'),
            closeBtnVisible: !document.getElementById('dsgvoCloseBtn').classList.contains('hidden'),
        }));
        check('Modal ist sichtbar', st.modalVisible);
        check('"Verstanden, weiter"-Button ist im Read-Only-Modus versteckt',
            st.consentBtnHidden);
        check('"Schließen"-Button ist sichtbar', st.closeBtnVisible);

        // Schließen → Modal verschwindet, Marker bleibt unverändert
        const beforeMarker = await page.evaluate(() =>
            localStorage.getItem('paraloxStunden.dsgvoAccepted'));
        await page.click('#dsgvoCloseBtn');
        await page.waitForTimeout(200);
        const afterMarker = await page.evaluate(() =>
            localStorage.getItem('paraloxStunden.dsgvoAccepted'));
        check('Marker wurde durch "Ansehen" NICHT verändert',
            beforeMarker === afterMarker);
        const stEnd = await page.evaluate(() =>
            document.getElementById('dsgvoConsentModal').classList.contains('hidden'));
        check('Modal nach "Schließen" weg', stEnd === true);

        await browser.close();
    }

    // -------- 2. Beide Sicherungen deaktiviert → kurzer Text --------
    console.log('\n=== Beide Sicherungen deaktiviert → kurzer Lokal-Text ===');
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(500);
        await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.settings.dailyBackup.enabled = false;
            data.settings.monthlyArchive.enabled = false;
            data.settings.dataController = 'Test-Firma GbR';
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(500);
        await loginAsAdmin(page);
        const n = await readNotice(page);
        check('Hinweis enthält "lokal auf diesem Gerät"',
            /lokal auf diesem Gerät/.test(n.text), n.text.slice(0, 80));
        check('Hinweis sagt "keine Übertragung"',
            /keine Übertragung an externe Dienste/.test(n.text));
        check('Hinweis erwähnt KEIN GMX',
            !/GMX|1&1/.test(n.text));
        check('Hinweis erwähnt KEINEN Empfänger backup@example.org',
            !/backup@example\.org/.test(n.text));
        check('Hinweis enthält den gerätespezifischen Verantwortlichen',
            /Test-Firma GbR/.test(n.text));
        await browser.close();
    }

    // -------- 3. Owner ändert beide Empfänger → Text passt sich an --------
    console.log('\n=== Geänderter Empfänger erscheint im Hinweis ===');
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(500);
        await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.settings.dailyBackup.enabled = true;
            data.settings.dailyBackup.recipient = 'andere-adresse@firma.de';
            data.settings.monthlyArchive.enabled = true;
            data.settings.monthlyArchive.recipient = 'andere-adresse@firma.de';
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(500);
        await loginAsAdmin(page);
        const n = await readNotice(page);
        check('Hinweis nennt neue Adresse', /andere-adresse@firma\.de/.test(n.text),
            n.text.slice(0, 100));
        check('Hinweis nennt NICHT mehr die alte Adresse',
            !/backup@example\.org/.test(n.text));
    }

    // -------- 4. Monatsabschluss erwähnt 10 Jahre Aufbewahrung --------
    console.log('\n=== Monatsabschluss-Hinweis erwähnt 10-Jahre-Aufbewahrung ===');
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(500);
        await loginAsAdmin(page);
        const n = await readNotice(page);
        check('Hinweis erwähnt Monatsabschluss',
            /Monatsabschluss per E-Mail/.test(n.text), n.text.slice(0, 80));
        check('Hinweis erwähnt 10-Jahres-Aufbewahrungspflicht',
            /10 Jahre|§ 147 AO/.test(n.text));
        check('Hinweis erwähnt Minijob-PDF',
            /Minijob-PDF/.test(n.text));
        await browser.close();
    }

    console.log('\n' + (fails === 0
        ? '✓ ALLE DSGVO-DYNAMIC-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
