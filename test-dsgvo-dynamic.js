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

(async () => {
    // -------- 1. Geräte-Setting + Empfänger gesetzt → erweiterter Text --------
    console.log('\n=== Mit gespeichertem Empfänger + Verantwortlicher Stelle ===');
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(500);
        await seedDeviceSettings(page, 'Test-Firma GbR, Teststraße 1, 12345 Teststadt', 'backup@example.org');
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(800);
        const n = await readNotice(page);
        check('Consent-Popup ist sichtbar (erster Besuch)',
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

    // -------- 1b. Consent-Klick setzt Marker und schließt Popup --------
    console.log('\n=== Bestätigung: Marker gesetzt, Popup verschwindet, kommt nicht wieder ===');
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(800);
        let n = await readNotice(page);
        check('Popup vor Klick sichtbar', n.modalVisible === true);

        await page.click('#dsgvoConsentBtn');
        await page.waitForTimeout(200);

        n = await readNotice(page);
        check('Popup nach Klick verborgen', n.modalVisible === false);

        const marker = await page.evaluate(() =>
            localStorage.getItem('paraloxStunden.dsgvoAccepted'));
        check('Marker paraloxStunden.dsgvoAccepted gesetzt (ISO-Zeitstempel)',
            !!marker && /^\d{4}-\d{2}-\d{2}T/.test(marker), marker);

        // Reload → Popup darf nicht erneut erscheinen
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(800);
        n = await readNotice(page);
        check('Nach Reload bleibt Popup verborgen', n.modalVisible === false);

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
        await page.waitForTimeout(800);
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
        await page.waitForTimeout(800);
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
        await page.waitForTimeout(800);
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
