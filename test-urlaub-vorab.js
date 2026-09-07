/* Test: Vorab ausgezahltes Urlaubsentgelt (§ 11 Abs. 2 BUrlG).
 *
 * Das Urlaubsentgelt ist vor Urlaubsantritt auszuzahlen, nicht erst zum
 * regulären Monatstermin. Wurde separat überwiesen, darf es am Monatsende
 * nicht ein zweites Mal fließen.
 *
 * Der Kern des Tests ist die Frage, ob der Betrag GENAU EINMAL zählt:
 *  - Brutto bleibt unverändert (Vorab-Zahlung ändert nichts am Verdienst)
 *  - RV-Anteil bleibt unverändert (Bemessung auf dem vollen Brutto)
 *  - nur die noch zu überweisende Summe sinkt um den Vorab-Betrag
 *  - Brutto und Minijob-Grenze dürfen sich NICHT verschieben
 *  - Überzahlung (Vorschuss > Monatsanspruch) wird sichtbar gemacht
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

/* Monat Juli 2026: 4 Schichten à 5 Std à 10 EUR = 200,00 EUR
 * plus 1 Urlaubstag à 50,00 EUR  ->  Brutto 250,00 EUR.
 * Mitarbeiter ist RV-pflichtig, Brutto >= 175 -> 3,6 % = 9,00 EUR.
 * Auszahlung gesamt 241,00 EUR. Vorab geflossen: 50,00 EUR.
 * Noch zu überweisen: 191,00 EUR. */
const SCHICHTEN = ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27'];
const URLAUBSTAG = '2026-07-15';
const URLAUB_BETRAG = 50;
const ERW_BRUTTO = 250;
const ERW_RV = 9;
const ERW_AUSZAHLUNG = 241;
const ERW_NOCH_OFFEN = ERW_AUSZAHLUNG - URLAUB_BETRAG;   // 191,00

function db({ vorab = '', urlaubBetrag = URLAUB_BETRAG, schichten = SCHICHTEN } = {}) {
    let id = 0;
    return {
        employees: [
            { id: 1, name: 'Admin', password: 'paralox', isAdmin: true, isAccountant: false,
              isActive: true, rvBefreit: false, rvHistorie: [{ gueltigAb: '2020-01', befreit: false }],
              assignedTo: 'owner1', monatspauschale: 0, pauschaleAb: '', createdAt: '2020-01-01T00:00:00.000Z' },
            { id: 2, name: 'Testkraft', password: 'paralox', isAdmin: false, isAccountant: false,
              isActive: true, rvBefreit: false, rvHistorie: [{ gueltigAb: '2020-01', befreit: false }],
              assignedTo: 'owner1', monatspauschale: 0, pauschaleAb: '', createdAt: '2020-01-01T00:00:00.000Z' },
        ],
        shifts: [
            ...schichten.map(d => ({
                id: ++id, employeeId: 2, date: d, startTime: '08:00', endTime: '13:00',
                room: 'A', secondRoom: null, isDouble: false, isVacation: false,
                note: '', createdAt: d + 'T13:00:00.000Z',
            })),
            {
                id: 500, employeeId: 2, date: URLAUBSTAG, startTime: '', endTime: '',
                room: null, secondRoom: null, isDouble: false, isVacation: true,
                urlaubsBetrag: urlaubBetrag, vorabAusgezahltAm: vorab,
                note: '', createdAt: URLAUBSTAG + 'T00:00:00.000Z',
            },
        ],
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

async function openApp(browser, data) {
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
    await page.evaluate(() => {
        const sel = document.getElementById('loginName');
        sel.value = Array.from(sel.options).find(o => o.textContent === 'Admin').value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(900);
    return page;
}

/* Zusammenfassung der Auswertung für genau einen Mitarbeiter im Juli 2026. */
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
        setz('adminYear', '2026');
        setz('adminMonth', '07');
        setz('adminEmpFilter', '2');
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

    console.log('Ohne Vorab-Auszahlung (Ausgangswerte)');
    let page = await openApp(browser, db());
    let s = await auswertung(page);
    check(`Brutto ${ERW_BRUTTO},00 EUR`, wert(s, 'Brutto') === '250,00 EUR', wert(s, 'Brutto'));
    check(`RV-Anteil ${ERW_RV},00 EUR`, wert(s, 'RV-Anteil') === '− 9,00 EUR', wert(s, 'RV-Anteil'));
    check(`Auszahlung ${ERW_AUSZAHLUNG},00 EUR`, wert(s, 'Auszahlung an') === '241,00 EUR', wert(s, 'Auszahlung an'));
    check('keine Vorab-Zeile ohne Vorab-Zahlung', wert(s, 'vorab ausgezahlt') === undefined);
    check('keine "Noch zu überweisen"-Zeile', wert(s, 'Noch zu überweisen') === undefined);
    await page.context().close();

    console.log('Mit Vorab-Auszahlung: Betrag zählt genau einmal');
    page = await openApp(browser, db({ vorab: '2026-07-10' }));
    s = await auswertung(page);
    check('Brutto UNVERÄNDERT — Vorab-Zahlung ändert nichts am Verdienst',
        wert(s, 'Brutto') === '250,00 EUR', wert(s, 'Brutto'));
    check('RV-Anteil UNVERÄNDERT — Bemessung auf dem vollen Brutto',
        wert(s, 'RV-Anteil') === '− 9,00 EUR', wert(s, 'RV-Anteil'));
    check('Auszahlung gesamt unverändert',
        wert(s, 'Auszahlung an') === '241,00 EUR', wert(s, 'Auszahlung an'));
    check(`davon vorab ausgezahlt = ${URLAUB_BETRAG},00 EUR`,
        wert(s, 'vorab ausgezahlt') === '− 50,00 EUR', wert(s, 'vorab ausgezahlt'));
    check(`Noch zu überweisen = ${ERW_NOCH_OFFEN},00 EUR`,
        wert(s, 'Noch zu überweisen') === '191,00 EUR', wert(s, 'Noch zu überweisen'));
    check('Summe aus Überweisung und Vorschuss ergibt die Auszahlung — keine Doppelzählung',
        (191 + 50) === ERW_AUSZAHLUNG);
    await page.context().close();

    console.log('Urlaubstag bleibt in der Schichtliste sichtbar');
    page = await openApp(browser, db({ vorab: '2026-07-10' }));
    await page.evaluate(() => document.querySelector('[data-tab="shifts"]')?.click());
    await page.waitForTimeout(500);
    const zeile = await page.evaluate(() => {
        const tr = Array.from(document.querySelectorAll('#adminTable tbody tr'))
            .find(r => r.cells[0]?.textContent.trim() === '15.07.2026');
        return tr ? Array.from(tr.cells).map(c => c.textContent.trim()) : null;
    });
    check('Urlaubszeile weiterhin vorhanden', !!zeile, zeile ? zeile.slice(0, 8).join(' | ') : '(keine)');
    check('Betrag in der Zeile unverändert', zeile && zeile[7] === '50,00 EUR', zeile && zeile[7]);
    await page.context().close();

    console.log('Umschalten im Urlaubs-Dialog');
    page = await openApp(browser, db());
    await page.evaluate(() => document.querySelector('[data-tab="employees"]')?.click());
    await page.waitForTimeout(350);
    await page.evaluate(() => document.querySelector('[data-emp-urlaub="2"]').click());
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('[data-urlaub-vorab]').click());
    await page.waitForTimeout(400);
    const gesetzt = await page.evaluate(k =>
        JSON.parse(localStorage.getItem(k)).shifts.find(x => x.isVacation)?.vorabAusgezahltAm, DB_KEY);
    check('Markierung setzt ein Datum', /^\d{4}-\d{2}-\d{2}$/.test(gesetzt || ''), gesetzt);
    await page.evaluate(() => document.querySelector('[data-urlaub-vorab]').click());
    await page.waitForTimeout(400);
    const zurueck = await page.evaluate(k =>
        JSON.parse(localStorage.getItem(k)).shifts.find(x => x.isVacation)?.vorabAusgezahltAm, DB_KEY);
    check('Zurücknehmen leert das Datum wieder', zurueck === '', JSON.stringify(zurueck));
    await page.context().close();

    console.log('Überzahlung wird sichtbar');
    /* Nur ein Urlaubstag im Monat, vorab ausgezahlt: 200,00 EUR Brutto ergeben
     * 7,20 EUR RV und 192,80 EUR Auszahlung — der Vorschuss von 200,00 EUR
     * übersteigt das, es bleibt ein Minus von 7,20 EUR. */
    page = await openApp(browser, db({ vorab: '2026-07-10', urlaubBetrag: 200, schichten: [] }));
    s = await auswertung(page);
    check('Brutto = nur der Urlaubstag', wert(s, 'Brutto') === '200,00 EUR', wert(s, 'Brutto'));
    check('Noch zu überweisen ist negativ',
        (wert(s, 'Noch zu überweisen') || '').startsWith('-'), wert(s, 'Noch zu überweisen'));
    await page.context().close();

    await browser.close();
    console.log(fails === 0 ? '\nAlle Prüfungen bestanden.' : `\n${fails} Prüfung(en) fehlgeschlagen.`);
    process.exit(fails === 0 ? 0 : 1);
})();
