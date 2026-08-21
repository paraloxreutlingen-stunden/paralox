/* Test: Migration der Eigentümer-Schlüssel (alte Vornamen -> owner1/owner2).
 *
 * Der kritische Punkt ist NICHT die Umbenennung, sondern dass sich dabei kein
 * einziger Betrag ändert: die Raum-Anteile steuern die Kostenaufteilung, und
 * ein verlorener Schlüssel würde die Kosten still auf 0 setzen. Der Test legt
 * deshalb Daten im ALTEN Format an, lässt normalize() laufen und vergleicht
 * die angezeigten Kosten mit von Hand gerechneten Erwartungswerten.
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

/* Daten im ALTEN Format: Raum-Anteile, doubleSplit, labels und assignedTo
 * tragen noch die früheren Schlüssel. Bewusst asymmetrisch (70/30 und 20/80),
 * damit ein Vertauschen oder Verlieren der Schlüssel sofort auffällt — bei
 * 50/50 wäre der Fehler unsichtbar. */
const ALT_FORMAT = {
    employees: [
        { id: 1, name: 'Admin', password: 'paralox', isAdmin: true, isAccountant: false,
          isActive: true, rvBefreit: false, rvHistorie: [{ gueltigAb: '2020-01', befreit: false }],
          assignedTo: 'sandra', monatspauschale: 0, pauschaleAb: '', createdAt: '2020-01-01T00:00:00.000Z' },
        { id: 2, name: 'Testkraft', password: 'paralox', isAdmin: false, isAccountant: false,
          isActive: true, rvBefreit: false, rvHistorie: [{ gueltigAb: '2020-01', befreit: false }],
          assignedTo: 'benedikt', monatspauschale: 0, pauschaleAb: '', createdAt: '2020-01-01T00:00:00.000Z' },
    ],
    shifts: [
        // 4 Std * 10 EUR = 40,00 EUR in Raum A (70/30) -> 28,00 / 12,00
        { id: 1, employeeId: 2, date: '2026-07-06', startTime: '08:00', endTime: '12:00',
          room: 'A', secondRoom: null, isDouble: false, note: '', createdAt: '2026-07-06T12:00:00.000Z' },
        // 5 Std * 10 EUR = 50,00 EUR in Raum B (20/80) -> 10,00 / 40,00
        { id: 2, employeeId: 2, date: '2026-07-07', startTime: '08:00', endTime: '13:00',
          room: 'B', secondRoom: null, isDouble: false, note: '', createdAt: '2026-07-07T13:00:00.000Z' },
    ],
    settings: {
        wageSingle: 10, wageDouble: 10,
        wageHistory: [{ gueltigAb: '2020-01-01', single: 10, double: 10 }],
        abgabenPercent: 31.17, rvAnteilProzent: 3.6, dataController: '',
        rooms: {
            A: { name: 'Raum A', sandra: 70, benedikt: 30 },
            B: { name: 'Raum B', sandra: 20, benedikt: 80 },
        },
        doubleSplit: { main: 50, sandra: 25, benedikt: 25 },
        labels: { sandra: 'Alpha GmbH', benedikt: 'Beta OHG' },
        dailyBackup: { enabled: false, recipient: '' },
        monthlyArchive: { enabled: false, recipient: '' },
    },
    pinboard: { text: '', updatedAt: null, updatedBy: null },
    adminNotes: '',
    updatedAt: '2026-07-07T13:00:00.000Z',
};

async function openWith(browser, db) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript(([key, data]) => {
        localStorage.setItem(key, JSON.stringify(data));
        const iso = new Date().toISOString();
        const seen = JSON.stringify({ '1': iso, '2': iso, '99': iso });
        localStorage.setItem('paraloxStunden.dsgvoAccepted', seen);
        localStorage.setItem('paraloxStunden.vacationReminder', seen);
    }, [DB_KEY, db]);
    await page.goto(APP_URL);
    await page.waitForTimeout(1000);
    return page;
}

async function login(page) {
    await page.evaluate(() => {
        const sel = document.getElementById('loginName');
        const opt = Array.from(sel.options).find(o => o.textContent === 'Admin');
        sel.value = opt.value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(
            new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(900);
}

const storedDb = page => page.evaluate(k => JSON.parse(localStorage.getItem(k)), DB_KEY);

(async () => {
    const browser = await chromium.launch({ channel: 'chrome' });

    console.log('Schlüssel-Migration');
    let page = await openWith(browser, ALT_FORMAT);
    await login(page);
    let db = await storedDb(page);

    check('Raum A Anteile übernommen', db.settings.rooms.A.owner1 === 70 && db.settings.rooms.A.owner2 === 30,
        JSON.stringify(db.settings.rooms.A));
    check('Raum B Anteile übernommen', db.settings.rooms.B.owner1 === 20 && db.settings.rooms.B.owner2 === 80,
        JSON.stringify(db.settings.rooms.B));
    check('alte Raum-Schlüssel entfernt',
        db.settings.rooms.A.sandra === undefined && db.settings.rooms.A.benedikt === undefined);
    check('doubleSplit übernommen',
        db.settings.doubleSplit.owner1 === 25 && db.settings.doubleSplit.owner2 === 25,
        JSON.stringify(db.settings.doubleSplit));
    check('Labels übernommen',
        db.settings.labels.owner1 === 'Alpha GmbH' && db.settings.labels.owner2 === 'Beta OHG',
        JSON.stringify(db.settings.labels));
    check('assignedTo migriert',
        db.employees[0].assignedTo === 'owner1' && db.employees[1].assignedTo === 'owner2',
        db.employees.map(e => e.assignedTo).join(', '));

    console.log('Beträge unverändert');
    // Erwartung von Hand: 40,00 -> 28,00/12,00 und 50,00 -> 10,00/40,00.
    await page.evaluate(() => document.querySelector('[data-tab="shifts"]')?.click());
    await page.waitForTimeout(600);
    /* Die beiden Kostenspalten anhand ihrer Kopfzeilen-Position auslesen und
     * exakt vergleichen — Teilstring-Suche über die ganze Zeile wäre wertlos,
     * weil "40,00 EUR" das Muster "0,00 EUR" enthält. */
    const kosten = await page.evaluate(() => {
        const kopf = Array.from(document.querySelectorAll('#adminTable thead th'));
        const i1 = kopf.findIndex(th => th.id === 'thKostenOwner1');
        const i2 = kopf.findIndex(th => th.id === 'thKostenOwner2');
        return Array.from(document.querySelectorAll('#adminTable tbody tr')).map(tr => {
            const td = tr.querySelectorAll('td');
            return [td[i1]?.textContent.trim(), td[i2]?.textContent.trim()];
        });
    });
    const paare = kosten.map(p => p.join(' / '));
    check('Kostenaufteilung Raum A (70/30) korrekt',
        paare.includes('28,00 EUR / 12,00 EUR'), paare.join('  |  '));
    check('Kostenaufteilung Raum B (20/80) korrekt',
        paare.includes('10,00 EUR / 40,00 EUR'), paare.join('  |  '));
    check('keine Null-Kosten (Schlüssel nicht verloren)',
        kosten.length === 2 && kosten.flat().every(v => v && v !== '0,00 EUR'),
        paare.join('  |  '));

    console.log('Spaltenköpfe aus den Labels');
    const kopf = await page.evaluate(() => ({
        o1: document.getElementById('thKostenOwner1')?.textContent,
        o2: document.getElementById('thKostenOwner2')?.textContent,
    }));
    check('Tabellenkopf zeigt Label 1', kopf.o1 === 'Kosten Alpha GmbH', JSON.stringify(kopf.o1));
    check('Tabellenkopf zeigt Label 2', kopf.o2 === 'Kosten Beta OHG', JSON.stringify(kopf.o2));
    await page.context().close();

    console.log('Migration ist idempotent');
    page = await openWith(browser, db);   // bereits migrierte Daten erneut laden
    await login(page);
    const db2 = await storedDb(page);
    check('zweiter Lauf ändert nichts',
        JSON.stringify(db2.settings.rooms) === JSON.stringify(db.settings.rooms),
        JSON.stringify(db2.settings.rooms));
    await page.context().close();

    console.log('Neue Schlüssel gewinnen gegen alte');
    const gemischt = JSON.parse(JSON.stringify(ALT_FORMAT));
    gemischt.settings.rooms.A = { name: 'Raum A', owner1: 60, owner2: 40, sandra: 70, benedikt: 30 };
    page = await openWith(browser, gemischt);
    await login(page);
    const db3 = await storedDb(page);
    check('vorhandene owner1/owner2 bleiben unangetastet',
        db3.settings.rooms.A.owner1 === 60 && db3.settings.rooms.A.owner2 === 40,
        JSON.stringify(db3.settings.rooms.A));
    await page.context().close();

    await browser.close();
    console.log(fails === 0 ? '\nAlle Prüfungen bestanden.' : `\n${fails} Prüfung(en) fehlgeschlagen.`);
    process.exit(fails === 0 ? 0 : 1);
})();
