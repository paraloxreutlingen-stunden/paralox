/* Test: Sonderzahlungen (Weihnachtsgeld, Prämien, Arbeitgeberzuschüsse).
 *
 * Der Kern ist die Unterscheidung beitragspflichtig / beitragsfrei:
 *
 *  beitragspflichtig — zählt wie Lohn: ins Brutto, auf die Minijob-Grenze,
 *                      in die RV-Bemessung, mit Pauschalabgaben
 *  beitragsfrei      — zählt in NICHTS davon (§ 1 Abs. 1 Nr. 6 SvEV, z. B.
 *                      Arbeitgeberzuschuss zum Mutterschaftsgeld), wird aber
 *                      trotzdem ausgezahlt
 *
 * Geprüft wird derselbe Betrag einmal so und einmal so — die Zahlen müssen
 * sich unterscheiden, sonst greift die Unterscheidung nicht.
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

/* Juli 2026: 4 Schichten à 5 Std à 10 EUR = 200,00 EUR Lohn.
 * Dazu eine Sonderzahlung über 100,00 EUR.
 *
 *  beitragspflichtig: Brutto 300,00 → RV 3,6 % = 10,80 → Auszahlung 289,20
 *  beitragsfrei:      Brutto 200,00 → RV 3,6 % =  7,20 → Auszahlung 192,80
 *                     + 100,00 beitragsfrei                        = 292,80
 *
 * Beide Wege führen zu unterschiedlichem Brutto UND unterschiedlicher
 * Auszahlung — eine vertauschte Behandlung fiele sofort auf. */
const SCHICHTEN = ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27'];
const SONDER_DATUM = '2026-07-15';
const SONDER_BETRAG = 100;
const NOTIZ = 'Arbeitgeberzuschuss Mutterschaftsgeld';

function db({ frei = false, betrag = SONDER_BETRAG, mitSonder = true, datum = SONDER_DATUM,
              schichten = SCHICHTEN } = {}) {
    let id = 0;
    const shifts = schichten.map(d => ({
        id: ++id, employeeId: 2, date: d, startTime: '08:00', endTime: '13:00',
        room: 'A', secondRoom: null, isDouble: false, isVacation: false,
        isSonderzahlung: false, note: '', createdAt: d + 'T13:00:00.000Z',
    }));
    if (mitSonder) {
        shifts.push({
            id: 500, employeeId: 2, date: datum, startTime: '', endTime: '',
            room: null, secondRoom: null, isDouble: false, isVacation: false,
            isSonderzahlung: true, sonderBetrag: betrag, beitragsfrei: frei,
            note: NOTIZ, createdAt: datum + 'T00:00:00.000Z',
        });
    }
    return {
        employees: [
            { id: 1, name: 'Admin', password: 'paralox', isAdmin: true, isAccountant: false,
              isActive: true, rvBefreit: false, rvHistorie: [{ gueltigAb: '2020-01', befreit: false }],
              assignedTo: 'owner1', monatspauschale: 0, pauschaleAb: '', createdAt: '2020-01-01T00:00:00.000Z' },
            { id: 2, name: 'Testkraft', password: 'paralox', isAdmin: false, isAccountant: false,
              isActive: true, rvBefreit: false, rvHistorie: [{ gueltigAb: '2020-01', befreit: false }],
              assignedTo: 'owner1', monatspauschale: 0, pauschaleAb: '', createdAt: '2020-01-01T00:00:00.000Z' },
        ],
        shifts,
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
        adminNotes: '', updatedAt: '2026-07-31T00:00:00.000Z',
    };
}

async function openApp(browser, data, wer = 'Admin') {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 160)); fails++; });
    await page.addInitScript(([k, d]) => {
        localStorage.setItem(k, JSON.stringify(d));
        const iso = new Date().toISOString();
        const seen = JSON.stringify({ '1': iso, '2': iso });
        localStorage.setItem('paraloxStunden.dsgvoAccepted', seen);
        localStorage.setItem('paraloxStunden.vacationReminder', seen);
    }, [DB_KEY, data]);
    await page.goto(APP_URL);
    await page.waitForTimeout(1000);
    await page.evaluate((name) => {
        const sel = document.getElementById('loginName');
        sel.value = Array.from(sel.options).find(o => o.textContent === name).value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }, wer);
    await page.waitForTimeout(900);
    return page;
}

// Auswertung für Testkraft, Juli 2026.
async function auswertung(page) {
    await page.evaluate(() => document.querySelector('[data-tab="shifts"]')?.click());
    await page.waitForTimeout(400);
    await page.evaluate(() => {
        const setz = (id, v) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setz('adminYear', '2026'); setz('adminMonth', '07'); setz('adminEmpFilter', '2');
    });
    await page.waitForTimeout(500);
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('#adminSummary .stat')).map(s => ({
            label: s.querySelector('.label').textContent.trim(),
            value: s.querySelector('.value').textContent.trim(),
        })));
}
const wert = (stats, teil) => (stats.find(s => s.label.includes(teil)) || {}).value;

(async () => {
    const browser = await chromium.launch({ channel: 'chrome' });

    console.log('Ohne Sonderzahlung (Ausgangswerte)');
    let page = await openApp(browser, db({ mitSonder: false }));
    let s = await auswertung(page);
    check('Brutto 200,00 EUR', wert(s, 'Brutto') === '200,00 EUR', wert(s, 'Brutto'));
    check('Auszahlung 192,80 EUR', wert(s, 'Auszahlung an') === '192,80 EUR', wert(s, 'Auszahlung an'));
    await page.context().close();

    console.log('Beitragspflichtig: zählt wie Lohn');
    page = await openApp(browser, db({ frei: false }));
    s = await auswertung(page);
    check('Brutto 300,00 EUR — Betrag ist im Brutto',
        wert(s, 'Brutto') === '300,00 EUR', wert(s, 'Brutto'));
    check('RV-Anteil 10,80 EUR — auf das erhöhte Brutto',
        wert(s, 'RV-Anteil') === '− 10,80 EUR', wert(s, 'RV-Anteil'));
    check('Auszahlung 289,20 EUR', wert(s, 'Auszahlung an') === '289,20 EUR', wert(s, 'Auszahlung an'));
    check('keine Beitragsfrei-Zeile', wert(s, 'Beitragsfrei') === undefined);
    await page.context().close();

    console.log('Beitragsfrei: zählt in nichts, wird aber ausgezahlt');
    page = await openApp(browser, db({ frei: true }));
    s = await auswertung(page);
    check('Brutto 200,00 EUR — Betrag NICHT im Brutto',
        wert(s, 'Brutto') === '200,00 EUR', wert(s, 'Brutto'));
    check('RV-Anteil 7,20 EUR — Bemessung ohne den Betrag',
        wert(s, 'RV-Anteil') === '− 7,20 EUR', wert(s, 'RV-Anteil'));
    check('Beitragsfrei getrennt ausgewiesen: 100,00 EUR',
        wert(s, 'Beitragsfrei') === '100,00 EUR', wert(s, 'Beitragsfrei'));
    check('Auszahlung 292,80 EUR — Betrag ist enthalten',
        wert(s, 'Auszahlung an') === '292,80 EUR', wert(s, 'Auszahlung an'));
    check('Auszahlung liegt über dem Brutto — genau das ist der Unterschied',
        wert(s, 'Auszahlung an') === '292,80 EUR' && wert(s, 'Brutto') === '200,00 EUR');
    await page.context().close();

    console.log('Darstellung in der Schichtliste');
    page = await openApp(browser, db({ frei: true }));
    await auswertung(page);
    const zeile = await page.evaluate(() => {
        const tr = Array.from(document.querySelectorAll('#adminTable tbody tr'))
            .find(r => r.cells[0]?.textContent.trim() === '15.07.2026');
        return tr ? Array.from(tr.cells).map(c => c.textContent.trim()) : null;
    });
    check('Zeile vorhanden', !!zeile, zeile ? zeile.slice(0, 8).join(' | ') : '(keine)');
    check('Raum-Spalte zeigt "Sonderzahlung"', zeile && zeile[5] === 'Sonderzahlung', zeile && zeile[5]);
    check('Typ nennt beitragsfrei', zeile && /beitragsfrei/.test(zeile[6]), zeile && zeile[6]);
    check('keine Uhrzeiten, keine Stunden',
        zeile && zeile[2] === '–' && zeile[3] === '–' && zeile[4] === '–');
    check('Notiz sichtbar', zeile && zeile[10] === NOTIZ, zeile && zeile[10]);
    await page.context().close();

    console.log('Minijob-Grenze beim Mitarbeiter');
    /* Daten im LAUFENDEN Monat, weil die Grenzanzeige immer den aktuellen
     * Monat zeigt. Datumsunabhängig, weil aus dem Testlauf selbst abgeleitet. */
    const heute = new Date();
    const j = heute.getFullYear();
    const m = String(heute.getMonth() + 1).padStart(2, '0');
    const tag = d => `${j}-${m}-${String(d).padStart(2, '0')}`;
    for (const [frei, erwartet, txt] of [[true, '100,00 EUR', 'beitragsfrei'],
                                         [false, '600,00 EUR', 'beitragspflichtig']]) {
        page = await openApp(browser, db({
            frei, betrag: 500, datum: tag(15), schichten: [tag(5), tag(12)],
        }), 'Testkraft');
        await page.evaluate(() => document.querySelector('[data-tab="mine"]')?.click());
        await page.waitForTimeout(500);
        const monat = await page.evaluate(() => {
            const karten = Array.from(document.querySelectorAll('#mineLimits .limit-card'));
            const k = karten[1];
            return k ? k.querySelector('.limit-value').textContent.trim() : '';
        });
        check(`Monatsgrenze ${txt}: ${erwartet}`, monat === erwartet, monat);
        await page.context().close();
    }

    console.log('Notiz ist Pflicht');
    page = await openApp(browser, db({ mitSonder: false }));
    await page.evaluate(() => document.querySelector('[data-tab="employees"]')?.click());
    await page.waitForTimeout(350);
    await page.evaluate(() => document.querySelector('[data-emp-sonder="2"]').click());
    await page.waitForTimeout(400);
    const toastOhneNotiz = await page.evaluate(async () => {
        document.getElementById('sonderBetrag').value = '50';
        document.getElementById('sonderNotiz').value = '';
        document.getElementById('modalOk').click();
        await new Promise(r => setTimeout(r, 400));
        return document.getElementById('toasts')?.innerText || '';
    });
    check('ohne Notiz abgelehnt', /Grund der Zahlung/.test(toastOhneNotiz),
        JSON.stringify(toastOhneNotiz.trim().slice(0, 70)));
    const keinEintrag = await page.evaluate(k =>
        JSON.parse(localStorage.getItem(k)).shifts.filter(x => x.isSonderzahlung).length, DB_KEY);
    check('nichts gespeichert', keinEintrag === 0, String(keinEintrag));

    // Jetzt mit Notiz — muss durchgehen.
    await page.evaluate(async () => {
        document.getElementById('sonderBetrag').value = '50';
        document.getElementById('sonderNotiz').value = 'Weihnachtsgeld';
        document.getElementById('modalOk').click();
        await new Promise(r => setTimeout(r, 400));
    });
    await page.waitForTimeout(400);
    const angelegt = await page.evaluate(k =>
        JSON.parse(localStorage.getItem(k)).shifts.find(x => x.isSonderzahlung), DB_KEY);
    check('mit Notiz angelegt', !!angelegt && angelegt.sonderBetrag === 50,
        angelegt ? `${angelegt.sonderBetrag} / ${angelegt.note}` : '(keiner)');
    check('standardmäßig beitragspflichtig', angelegt && angelegt.beitragsfrei === false,
        String(angelegt && angelegt.beitragsfrei));
    await page.context().close();

    console.log('Nur beitragsfreie Zahlung, keine Schichten');
    /* Der Fall, um den es geht: eine Mitarbeiterin im Mutterschutz bekommt den
     * Arbeitgeberzuschuss, arbeitet aber nicht. Brutto 0 — es darf KEIN
     * RV-Beitrag anfallen und der Zuschuss muss 1:1 ausgezahlt werden.
     * Ohne Sonderbehandlung liefe der Monat in die Mindestbeitragsbemessung
     * und zöge 32,55 EUR von einem Brutto von 0 ab. */
    page = await openApp(browser, db({ frei: true, betrag: 200, schichten: [] }));
    s = await auswertung(page);
    check('Brutto 0,00 EUR', wert(s, 'Brutto') === '0,00 EUR', wert(s, 'Brutto'));
    check('KEIN RV-Anteil bei Brutto 0',
        wert(s, 'RV-Anteil') === '− 0,00 EUR' || wert(s, 'RV-Anteil') === '0,00 EUR',
        wert(s, 'RV-Anteil'));
    check('Auszahlung genau 200,00 EUR — 1:1, nichts abgezogen',
        wert(s, 'Auszahlung an') === '200,00 EUR', wert(s, 'Auszahlung an'));
    await page.context().close();

    console.log('Sonderzahlung löst keine Monatspauschale aus');
    /* Eine Sonderzahlung allein begründet keinen Pauschalenanspruch — sonst
     * entstünde in einem Monat ohne Arbeit ein Brutto aus dem Nichts, auf das
     * dann auch noch der Mindestbeitrag fiele. Der Monat MIT Schichten muss die
     * Pauschale dagegen weiterhin bekommen. */
    const mitPauschale = (schichten) => {
        const d = db({ frei: true, betrag: 200, schichten });
        d.employees[1].monatspauschale = 50;
        d.employees[1].pauschaleAb = '2020-01';
        return d;
    };
    page = await openApp(browser, mitPauschale([]));
    s = await auswertung(page);
    check('ohne Schichten: Brutto bleibt 0,00 EUR',
        wert(s, 'Brutto') === '0,00 EUR', wert(s, 'Brutto'));
    check('ohne Schichten: keine Pauschale eingerechnet',
        wert(s, 'davon Pauschale') === undefined, wert(s, 'davon Pauschale'));
    check('ohne Schichten: Auszahlung 200,00 EUR — 1:1',
        wert(s, 'Auszahlung an') === '200,00 EUR', wert(s, 'Auszahlung an'));
    await page.context().close();

    page = await openApp(browser, mitPauschale(SCHICHTEN));
    s = await auswertung(page);
    check('mit Schichten: Pauschale greift weiterhin (200 + 50)',
        wert(s, 'Brutto') === '250,00 EUR', wert(s, 'Brutto'));
    check('mit Schichten: Pauschale ausgewiesen',
        wert(s, 'davon Pauschale') === '50,00 EUR', wert(s, 'davon Pauschale'));
    await page.context().close();

    console.log('Kein Einfluss auf den Urlaub');
    page = await openApp(browser, db({ frei: false }));
    await page.evaluate(() => document.querySelector('[data-tab="employees"]')?.click());
    await page.waitForTimeout(350);
    await page.evaluate(() => document.querySelector('[data-emp-urlaub="2"]').click());
    await page.waitForTimeout(400);
    const konto = await page.evaluate(() => ({
        hinweis: document.querySelector('#modalBody p.muted')?.textContent.trim() || '',
        vorschau: document.getElementById('urlaubVorschau')?.textContent || '',
    }));
    /* 4 Schichten = 4 Arbeitstage. Zählte die Sonderzahlung als Arbeitstag mit,
     * stünden hier 5 — der Urlaubsanspruch wüchse ohne geleistete Arbeit. */
    check('Sonderzahlung ist kein Arbeitstag', /Anspruch = 4 Arbeitstage/.test(konto.hinweis),
        konto.hinweis.slice(0, 60));
    await page.context().close();

    await browser.close();
    console.log(fails === 0 ? '\nAlle Prüfungen bestanden.' : `\n${fails} Prüfung(en) fehlgeschlagen.`);
    process.exit(fails === 0 ? 0 : 1);
})();
