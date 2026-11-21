/* Test: vergessene offene Schicht von einem früheren Tag.
 *
 * Ein Mitarbeiter startet eine Schicht und beendet sie nicht. Am nächsten
 * Tag soll er sie selbst beenden können — frei in die Vergangenheit
 * nachtragen darf aber weiterhin nur der Admin. Geprüft wird:
 *
 *  - Banner kennzeichnet die Schicht als nicht beendet, "Beenden" ist da
 *  - Beenden speichert die Schicht mit dem Datum des Starttags
 *  - "Offene Schicht verwerfen" löscht nur den Running-Marker, in shifts
 *    steht danach nichts
 *  - "Komplett speichern" mit Datum von gestern bleibt für Mitarbeiter gesperrt
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
        shifts: JSON.parse(localStorage.getItem('paraloxStunden.v1')).shifts,
    };
});

const gestern = () => {
    const t = new Date();
    t.setDate(t.getDate() - 1);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

(async () => {
    const browser = await chromium.launch({ channel: 'chrome' });

    console.log('Offene Schicht von gestern beenden');
    let page = await openApp(browser, 1);
    let z = await zustand(page);
    check('Banner sichtbar', z.bannerSichtbar);
    check('Banner nennt nicht beendete Schicht', z.banner.includes('Nicht beendete Schicht'), z.banner.slice(0, 60));
    check('"Schicht beenden" sichtbar', z.beenden);
    check('"Offene Schicht verwerfen" sichtbar', z.verwerfen);

    await page.fill('#sfEnd', '21:00');
    await page.click('#sfEndBtn');
    await page.waitForTimeout(400);
    z = await zustand(page);
    const s = z.shifts[0] || {};
    check('Schicht gespeichert', z.shifts.length === 1, String(z.shifts.length));
    check('Datum ist der Starttag', s.date === gestern(), s.date);
    check('Beginn/Ende übernommen', s.startTime === '17:00' && s.endTime === '21:00', `${s.startTime}–${s.endTime}`);
    check('Running-Marker gelöscht', !z.running);
    check('Formular wieder im Normalmodus', z.starten && !z.bannerSichtbar);
    await page.context().close();

    console.log('Komplett speichern mit Datum von gestern');
    page = await openApp(browser, 1);
    // Offene Schicht vorher verwerfen, damit das Formular im Normalmodus ist.
    await page.click('#sfDiscardBtn');
    await page.waitForTimeout(200);
    await page.click('#modalOk');
    await page.waitForTimeout(300);
    await page.evaluate((d) => {
        document.getElementById('sfDate').value = d;
        document.getElementById('sfStart').value = '10:00';
        document.getElementById('sfEnd').value = '12:00';
        const sel = document.getElementById('sfRoom');
        sel.value = 'A';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, gestern());
    await page.click('#sfSaveBtn');
    await page.waitForTimeout(400);
    z = await zustand(page);
    check('Mitarbeiter kann nicht frei in die Vergangenheit nachtragen', z.shifts.length === 0, String(z.shifts.length));
    await page.context().close();

    console.log('Offene Schicht von gestern verwerfen');
    page = await openApp(browser, 1);

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
    check('Keine Schicht in der Datenbank angelegt', z.shifts.length === 0, String(z.shifts.length));

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
