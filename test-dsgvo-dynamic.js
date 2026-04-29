/* Test: DSGVO-Hinweis im Login-View ist dynamisch.
 *  - dailyBackup.enabled=false → kurzer Lokal-Speicherungs-Text
 *  - dailyBackup.enabled=true  → erweiterter Text mit Empfänger,
 *                                Auftragsverarbeiter (GMX, 1&1),
 *                                Rechtsgrundlage (Art. 6 Abs. 1 lit. f).
 *  - Nach Settings-Änderung + Logout/Reload zeigt der Login-View den
 *    aktualisierten Text.
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
        const el = document.getElementById('dsgvoNotice');
        return {
            text: el ? el.textContent.replace(/\s+/g, ' ').trim() : null,
            html: el ? el.innerHTML : null,
        };
    });
}

(async () => {
    // -------- 1. Default-Zustand: enabled=true mit gmx-Adresse --------
    console.log('\n=== Default (enabled=true, backup@example.org) ===');
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(800);
        const n = await readNotice(page);
        check('Hinweis enthält "Tagessicherung per E-Mail (aktiv)"',
            /Tagessicherung per E-Mail \(aktiv\)/.test(n.text), n.text.slice(0, 80));
        check('Hinweis enthält backup@example.org',
            /backup@example\.org/.test(n.text));
        check('Hinweis nennt Auftragsverarbeiter (1&1 / GMX)',
            /1&1|GMX/.test(n.text));
        check('Hinweis nennt Rechtsgrundlage Art. 6 Abs. 1 lit. f',
            /Art\.\s*6\s*Abs\.\s*1\s*lit\.\s*f/.test(n.text));
        check('Hinweis enthält Verantwortlichen (Beispiel…)',
            /Beispiel GbR/.test(n.text));
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
        check('Hinweis enthält Verantwortlichen',
            /Beispiel GbR/.test(n.text));
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
