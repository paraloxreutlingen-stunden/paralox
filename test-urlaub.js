/* Test: Urlaubstage.
 *  - Urlaubsentgelt = Durchschnitt der letzten 13 Wochen (§ 11 BUrlG)
 *  - Nur GEARBEITETE Tage im Bezugszeitraum zählen, Urlaubstage nicht
 *  - Schichten außerhalb des Zeitraums fließen nicht ein
 *  - Der Betrag ist eingefroren: spätere Schichten verändern ihn NICHT
 *  - In der Schichtliste steht "Urlaub" statt einem Raum, ohne Stunden
 *  - Urlaubsentgelt zählt zum Brutto
 *  - Restkonto: Arbeitstage ÷ 365 × 24 Werktage, genommen, übrig
 *  - An einem Urlaubstag lässt sich keine Schicht erfassen (und umgekehrt)
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

const URLAUBSTAG = '2026-07-01';   // Bezugszeitraum: 2026-04-01 bis 2026-06-30
const STUNDENLOHN = 10;

/* 10 Arbeitstage IM Bezugszeitraum, je 5 Stunden à 10 EUR -> 50,00 EUR pro Tag.
 * Erwarteter Tagessatz: 500,00 / 10 = 50,00 EUR.
 *
 * Dazu 3 Tage im Januar, also AUSSERHALB der 13 Wochen. Sie sind bewusst
 * LÄNGER (10 Stunden = 100,00 EUR): flössen sie fälschlich mit ein, ergäbe
 * sich (500 + 300) / 13 = 61,54 statt 50,00 — der Unterschied ist damit
 * sichtbar. Bei gleicher Länge wäre der Fehler unbemerkt geblieben, weil
 * 650 / 13 ebenfalls genau 50,00 ergibt. */
const IM_ZEITRAUM = [
    '2026-04-07', '2026-04-14', '2026-04-21', '2026-04-28', '2026-05-05',
    '2026-05-12', '2026-05-19', '2026-05-26', '2026-06-02', '2026-06-09',
];
const AUSSERHALB = ['2026-01-13', '2026-01-20', '2026-01-27'];

const ERWARTETER_TAGESSATZ = 50;
const FALSCH_WENN_ALLES = Math.round((500 + 300) / 13 * 100) / 100;   // 61,54
const ARBEITSTAGE = IM_ZEITRAUM.length + AUSSERHALB.length;           // 13
// Wie in der App: EINMAL auf eine Nachkommastelle runden.
const ERWARTETER_ANSPRUCH = Math.round((ARBEITSTAGE / 365 * 24) * 10) / 10;
const fmtT = n => (Math.round(n * 10) / 10).toString().replace('.', ',');

function db(extraShifts = []) {
    let id = 0;
    // ende steuert die Länge: 13:00 = 5 Std = 50 EUR, 18:00 = 10 Std = 100 EUR.
    const mk = (date, ende) => ({
        id: ++id, employeeId: 2, date, startTime: '08:00', endTime: ende,
        room: 'A', secondRoom: null, isDouble: false, isVacation: false,
        note: '', createdAt: date + 'T20:00:00.000Z',
    });
    return {
        employees: [
            { id: 1, name: 'Admin', password: 'paralox', isAdmin: true, isAccountant: false,
              isActive: true, rvBefreit: false, rvHistorie: [{ gueltigAb: '2020-01', befreit: false }],
              assignedTo: 'owner1', monatspauschale: 0, pauschaleAb: '', createdAt: '2020-01-01T00:00:00.000Z' },
            { id: 2, name: 'Testkraft', password: 'paralox', isAdmin: false, isAccountant: false,
              isActive: true, rvBefreit: true, rvHistorie: [{ gueltigAb: '2020-01', befreit: true }],
              assignedTo: 'owner1', monatspauschale: 0, pauschaleAb: '', createdAt: '2020-01-01T00:00:00.000Z' },
        ],
        shifts: [
            ...IM_ZEITRAUM.map(d => mk(d, '13:00')),   // je 50,00 EUR
            ...AUSSERHALB.map(d => mk(d, '18:00')),    // je 100,00 EUR
            ...extraShifts.map((d, i) => ({ ...mk(d, '18:00'), id: 900 + i })),
        ],
        settings: {
            wageSingle: STUNDENLOHN, wageDouble: STUNDENLOHN,
            wageHistory: [{ gueltigAb: '2020-01-01', single: STUNDENLOHN, double: STUNDENLOHN }],
            abgabenPercent: 31.17, rvAnteilProzent: 3.6, dataController: '',
            rooms: { A: { name: 'Raum A', owner1: 50, owner2: 50 } },
            doubleSplit: { main: 50, owner1: 25, owner2: 25 },
            labels: { owner1: 'Eigentümer 1', owner2: 'Eigentümer 2' },
            dailyBackup: { enabled: false, recipient: '' },
            monthlyArchive: { enabled: false, recipient: '' },
        },
        pinboard: { text: '', updatedAt: null, updatedBy: null },
        adminNotes: '', updatedAt: '2026-07-01T00:00:00.000Z',
    };
}

async function openApp(browser, data) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 160)); fails++; });
    await page.addInitScript(([k, d]) => {
        localStorage.setItem(k, JSON.stringify(d));
        const iso = new Date().toISOString();
        const seen = JSON.stringify({ '1': iso, '2': iso, '99': iso });
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

// Urlaubstag über den Admin-Dialog eintragen — deckt den echten Bedienweg ab.
async function urlaubEintragen(page, datum) {
    await page.evaluate(() => document.querySelector('[data-tab="employees"]')?.click());
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('[data-emp-urlaub="2"]').click());
    await page.waitForTimeout(400);
    const vorschau = await page.evaluate(() => document.getElementById('urlaubVorschau')?.textContent || '');
    await page.evaluate(d => {
        const f = document.getElementById('urlaubDatum');
        f.value = d;
        f.dispatchEvent(new Event('input', { bubbles: true }));
        f.dispatchEvent(new Event('change', { bubbles: true }));
    }, datum);
    await page.waitForTimeout(200);
    const vorschauNeu = await page.evaluate(() => document.getElementById('urlaubVorschau')?.textContent || '');
    await page.evaluate(() => document.getElementById('modalOk').click());
    await page.waitForTimeout(500);
    return { vorschau, vorschauNeu };
}

const gespeicherteSchichten = page => page.evaluate(k =>
    JSON.parse(localStorage.getItem(k)).shifts, DB_KEY);

(async () => {
    const browser = await chromium.launch({ channel: 'chrome' });

    console.log('Urlaubsentgelt aus 13-Wochen-Durchschnitt');
    let page = await openApp(browser, db());
    const { vorschauNeu } = await urlaubEintragen(page, URLAUBSTAG);
    check('Vorschau nennt den Bezugszeitraum',
        /01\.04\.2026/.test(vorschauNeu) && /30\.06\.2026/.test(vorschauNeu), vorschauNeu.slice(0, 120));
    check('Vorschau nennt die Zahl der Arbeitstage',
        new RegExp(`${IM_ZEITRAUM.length} Arbeitstagen`).test(vorschauNeu), vorschauNeu.slice(0, 120));

    let alle = await gespeicherteSchichten(page);
    const urlaub = alle.find(s => s.isVacation);
    check('Urlaubstag angelegt', !!urlaub, urlaub ? urlaub.date : '(keiner)');
    check(`Betrag = ${ERWARTETER_TAGESSATZ.toFixed(2)} EUR (500,00 / ${IM_ZEITRAUM.length} Arbeitstage)`,
        urlaub && urlaub.urlaubsBetrag === ERWARTETER_TAGESSATZ, String(urlaub && urlaub.urlaubsBetrag));
    check(`Schichten außerhalb der 13 Wochen zählen nicht mit (sonst ${FALSCH_WENN_ALLES})`,
        urlaub && urlaub.urlaubsBetrag !== FALSCH_WENN_ALLES, String(urlaub && urlaub.urlaubsBetrag));
    check('Urlaubstag ohne Uhrzeiten und Raum',
        urlaub && urlaub.startTime === '' && urlaub.endTime === '' && urlaub.room === null);
    await page.context().close();

    console.log('Betrag ist eingefroren');
    /* Datenstand mit bereits eingetragenem Urlaubstag (50,00 EUR) UND einer
     * später erfassten, deutlich besser bezahlten Schicht im Bezugszeitraum.
     * Würde der Betrag beim Laden neu gerechnet, stiege er — er darf nicht. */
    const mitNachtrag = db(['2026-06-16']);
    mitNachtrag.shifts.push({
        id: 800, employeeId: 2, date: URLAUBSTAG, startTime: '', endTime: '',
        room: null, secondRoom: null, isDouble: false, isVacation: true,
        urlaubsBetrag: ERWARTETER_TAGESSATZ, note: '', createdAt: '2026-07-01T00:00:00.000Z',
    });
    page = await openApp(browser, mitNachtrag);
    const nachher = (await gespeicherteSchichten(page)).find(s => s.isVacation);
    check('Betrag nach zusätzlicher Schicht unverändert',
        nachher && nachher.urlaubsBetrag === ERWARTETER_TAGESSATZ, String(nachher && nachher.urlaubsBetrag));
    /* Gegenprobe: eine FRISCHE Berechnung liefert wegen der zusätzlichen
     * Schicht einen anderen Satz. Der Betrag wird gezielt aus der Vorschau
     * gelesen, nicht per Textsuche — "250,00 EUR" enthält sonst "50,00 EUR"
     * als Teilstring und die Prüfung wäre wertlos. */
    await page.evaluate(() => document.querySelector('[data-tab="employees"]')?.click());
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('[data-emp-urlaub="2"]').click());
    await page.waitForTimeout(400);
    const vorschauJetzt = await page.evaluate(() => document.getElementById('urlaubVorschau')?.textContent || '');
    const frischerSatz = (vorschauJetzt.match(/Betrag:\s*([\d.]+,\d\d)\s*EUR/) || [])[1];
    check('frisch gerechnet ergäbe einen anderen Satz als den gespeicherten',
        !!frischerSatz && frischerSatz !== '50,00',
        `frisch ${frischerSatz} vs. gespeichert 50,00`);
    await page.context().close();

    console.log('Darstellung in der Schichtliste');
    page = await openApp(browser, db());
    await urlaubEintragen(page, URLAUBSTAG);
    await page.evaluate(() => document.querySelector('[data-tab="shifts"]')?.click());
    await page.waitForTimeout(600);
    const zeile = await page.evaluate(() => {
        const tr = Array.from(document.querySelectorAll('#adminTable tbody tr'))
            .find(r => r.cells[0]?.textContent.trim() === '01.07.2026');
        return tr ? Array.from(tr.cells).map(c => c.textContent.trim()) : null;
    });
    check('Urlaubszeile vorhanden', !!zeile, zeile ? zeile.slice(0, 8).join(' | ') : '(keine)');
    check('Raum-Spalte zeigt "Urlaub"', zeile && zeile[5] === 'Urlaub', zeile && zeile[5]);
    check('keine Uhrzeiten', zeile && zeile[2] === '–' && zeile[3] === '–');
    check('keine Stunden', zeile && zeile[4] === '–', zeile && zeile[4]);
    check('Betrag in der Zeile', zeile && zeile[7] === '50,00 EUR', zeile && zeile[7]);

    console.log('Urlaubsentgelt zählt zum Brutto');
    const summe = await page.evaluate(() => {
        const stats = Array.from(document.querySelectorAll('#adminSummary .stat'));
        const s = stats.find(x => /Verdienst/.test(x.querySelector('.label')?.textContent || ''));
        return s ? s.querySelector('.value').textContent.trim() : '';
    });
    // 10 x 50,00 + 3 x 100,00 + 1 Urlaubstag x 50,00 = 850,00
    check('Verdienst enthält das Urlaubsentgelt', summe === '850,00 EUR', summe);

    console.log('Restkonto');
    await page.evaluate(() => document.querySelector('[data-tab="employees"]')?.click());
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('[data-emp-urlaub="2"]').click());
    await page.waitForTimeout(400);
    const konto = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#modalBody .stat')).map(s => ({
            label: s.querySelector('.label').textContent.trim(),
            value: s.querySelector('.value').textContent.trim(),
        })));
    const wert = l => (konto.find(k => k.label.startsWith(l)) || {}).value;
    check(`Anspruch = ${ERWARTETER_ANSPRUCH} (${ARBEITSTAGE} Arbeitstage ÷ 365 × 24)`,
        wert('Anspruch') === fmtT(ERWARTETER_ANSPRUCH) + ' Tage',
        wert('Anspruch'));
    check('Genommen = 1 Tag', wert('Genommen') === '1 Tage', wert('Genommen'));
    check('Übrig = Anspruch − 1',
        wert('Übrig') === fmtT(ERWARTETER_ANSPRUCH - 1) + ' Tage',
        wert('Übrig'));
    check('Urlaubstage zählen nicht als Arbeitstage',
        !konto.some(k => k.value.includes(String(ARBEITSTAGE + 1))), 'sonst würde Urlaub den Anspruch erhöhen');
    await page.evaluate(() => document.getElementById('modalCancel').click());
    await page.waitForTimeout(200);

    console.log('Konflikt Schicht / Urlaubstag');
    await page.evaluate(() => document.querySelector('[data-tab="enter"]')?.click());
    await page.waitForTimeout(400);
    const toastText = await page.evaluate(async (d) => {
        const set = (id, v) => {
            const el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const emp = document.getElementById('sfEmp');
        if (emp) { emp.value = '2'; emp.dispatchEvent(new Event('change', { bubbles: true })); }
        set('sfDate', d); set('sfStart', '09:00'); set('sfEnd', '12:00');
        const room = document.getElementById('sfRoom');
        room.value = 'A'; room.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('sfSaveBtn').click();
        await new Promise(r => setTimeout(r, 400));
        return document.getElementById('toasts')?.innerText || '';
    }, URLAUBSTAG);
    check('Schicht am Urlaubstag wird abgelehnt', /Urlaub eingetragen/.test(toastText),
        JSON.stringify(toastText.trim().slice(0, 90)));
    const nachVersuch = await gespeicherteSchichten(page);
    check('keine Schicht am Urlaubstag gespeichert',
        !nachVersuch.some(s => !s.isVacation && s.date === URLAUBSTAG && s.employeeId === 2));
    await page.context().close();

    console.log('Ohne Arbeitstage im Bezugszeitraum');
    page = await openApp(browser, db());
    // Urlaubstag weit vor allen Schichten -> kein Durchschnitt bildbar.
    const r = await urlaubEintragen(page, '2026-01-05');
    check('Vorschau warnt vor 0,00 EUR', /Keine Arbeitstage/.test(r.vorschauNeu), r.vorschauNeu.slice(0, 100));
    const leer = (await gespeicherteSchichten(page)).find(s => s.isVacation);
    check('Betrag 0,00 statt Absturz', leer && leer.urlaubsBetrag === 0, String(leer && leer.urlaubsBetrag));
    await page.context().close();

    await browser.close();
    console.log(fails === 0 ? '\nAlle Prüfungen bestanden.' : `\n${fails} Prüfung(en) fehlgeschlagen.`);
    process.exit(fails === 0 ? 0 : 1);
})();
