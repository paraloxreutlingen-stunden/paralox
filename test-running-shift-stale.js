/* Test: vergessene offene Schicht von einem früheren Tag.
 *
 * Ein Mitarbeiter startet eine Schicht und beendet sie nicht. Am nächsten
 * Tag darf er sie nicht mehr selbst beenden (Vergangenheit ist Admin-Sache),
 * und solange sie offen ist, kann er auch keine neue Schicht erfassen. Ohne
 * Ausweg säße er dauerhaft fest. Geprüft wird:
 *
 *  - Banner kennzeichnet die Schicht als nicht beendet, "Beenden" ist weg
 *  - "Offene Schicht verwerfen" ist da und löscht nur den Running-Marker
 *  - danach ist das Formular wieder im Normalmodus und in shifts steht nichts
 *  - bei einer Schicht von heute bleibt "Beenden" erhalten
 *
 * Läuft gegen Test-Daten, nicht gegen die produktiven Daten.
 */
'use strict';
const { chromium } = require('playwright-core');
const APP_URL = process.env.PARALOX_URL || 'http://127.0.0.1:8080/index.html';
const DB_KEY = 'paraloxStunden.v1';

let fails = 0;
function check(label, cond, detail) {
    console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? ': ' + detail : ''}`);
    if (!cond) fails++;
}

function db() {
    const emp = (id, name, isAdmin) => ({
        id, name, password: 'paralox', isAdmin, isAccountant: false,
        isActive: true, rvBefreit: false, rvHistorie: [{ gueltigAb: '2020-01', befreit: false }],
        assignedTo: 'owner1', monatspauschale: 0, pauschaleAb: '', createdAt: '2020-01-01T00:00:00.000Z',
    });
    return {
        employees: [emp(1, 'Admin', true), emp(2, 'Testkraft', false)],
        shifts: [],
        settings: {
            wageSingle: 10, wageDouble: 10,
            wageHistory: [{ gueltigAb: '2020-01-01', single: 10, double: 10 }],
            abgabenPercent: 31.17, rvAnteilProzent: 3.6, dataController: '',
            rooms: { A: { name: 'Raum A', owner1: 50, owner2: 50 } },
            doubleSplit: { main: 50, owner1: 25, owner2: 25 },
            labels: { owner1: 'Eigentümer 1', owner2: 'Eigentümer 2' },
            dailyBackup: { enabled: false, recipient: '' },
            monthlyArchive: { enabled: false, recipient: '' },
        },
        pinboard: { text: '', updatedAt: null, updatedBy: null },
        adminNotes: '', updatedAt: '2026-01-01T00:00:00.000Z',
    };
}

/* tageZurueck = 1 legt die offene Schicht auf gestern, 0 auf heute. Das Datum
 * wird in der Seite berechnet, damit es zu deren todayISO() passt. */
async function openApp(browser, tageZurueck) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 160)); fails++; });
    await page.addInitScript(([k, d, zurueck]) => {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem(k, JSON.stringify(d));
        const iso = new Date().toISOString();
        const seen = JSON.stringify({ '1': iso, '2': iso });
        localStorage.setItem('paraloxStunden.dsgvoAccepted', seen);
        localStorage.setItem('paraloxStunden.vacationReminder', seen);
        const t = new Date();
        t.setDate(t.getDate() - zurueck);
        const datum = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
        localStorage.setItem('paraloxStunden.runningShifts', JSON.stringify({
            '2': { date: datum, startTime: '17:00', room: 'A', isDouble: false,
                   secondRoom: null, note: '', startedAt: t.toISOString() },
        }));
    }, [DB_KEY, db(), tageZurueck]);
    await page.goto(APP_URL);
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
        const sel = document.getElementById('loginName');
        sel.value = Array.from(sel.options).find(o => o.textContent === 'Testkraft').value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(900);
    return page;
}

const zustand = (page) => page.evaluate(() => {
    const sichtbar = (id) => !document.getElementById(id).classList.contains('hidden');
    return {
        banner: document.getElementById('runningShiftBanner').textContent,
        bannerSichtbar: sichtbar('runningShiftBanner'),
        beenden: sichtbar('sfEndBtn'),
        verwerfen: sichtbar('sfDiscardBtn'),
        starten: sichtbar('sfStartBtn'),
        running: JSON.parse(localStorage.getItem('paraloxStunden.runningShifts') || '{}')['2'] || null,
        shifts: JSON.parse(localStorage.getItem('paraloxStunden.v1')).shifts.length,
    };
});

(async () => {
    const browser = await chromium.launch({ channel: 'chrome' });

    console.log('Offene Schicht von gestern');
    let page = await openApp(browser, 1);
    let z = await zustand(page);
    check('Banner sichtbar', z.bannerSichtbar);
    check('Banner nennt nicht beendete Schicht', z.banner.includes('Nicht beendete Schicht'), z.banner.slice(0, 60));
    check('"Schicht beenden" ausgeblendet', !z.beenden);
    check('"Offene Schicht verwerfen" sichtbar', z.verwerfen);

    // Abbrechen im Rückfrage-Dialog darf nichts verändern.
    await page.click('#sfDiscardBtn');
    await page.waitForTimeout(200);
    await page.click('#modalCancel');
    await page.waitForTimeout(200);
    z = await zustand(page);
    check('Abbrechen lässt die offene Schicht stehen', !!z.running);

    await page.click('#sfDiscardBtn');
    await page.waitForTimeout(200);
    await page.click('#modalOk');
    await page.waitForTimeout(300);
    z = await zustand(page);
    check('Running-Marker gelöscht', !z.running);
    check('Formular wieder im Normalmodus', z.starten && !z.verwerfen && !z.bannerSichtbar);
    check('Keine Schicht in der Datenbank angelegt', z.shifts === 0, String(z.shifts));

    await page.reload();
    await page.waitForTimeout(1000);
    z = await zustand(page);
    check('Nach Reload bleibt die Schicht verworfen', !z.running && !z.bannerSichtbar);
    await page.context().close();

    console.log('Offene Schicht von heute');
    page = await openApp(browser, 0);
    z = await zustand(page);
    check('Banner "Deine Schicht läuft"', z.banner.includes('Deine Schicht läuft'));
    check('"Schicht beenden" sichtbar', z.beenden);
    check('"Offene Schicht verwerfen" sichtbar', z.verwerfen);
    await page.context().close();

    await browser.close();
    console.log(fails ? `\n${fails} Fehler` : '\nAlle Checks bestanden');
    process.exit(fails ? 1 : 0);
})();
