/* Test: Übertrag von Resturlaub und dessen Verfall zum 30. Juni.
 *
 * § 9 der Rahmenvereinbarung: Resturlaub des Vorjahres bleibt bis zum
 * 30. Juni des Folgejahres nutzbar und verfällt danach — abweichend von der
 * sonst üblichen Frist zum 31. März.
 *
 *  - Übertrag = offener Rest des Vorjahres, bis 30.06. verfügbar
 *  - Am 30.06. selbst noch nutzbar, ab 01.07. verfallen
 *  - Genommene Tage zehren zuerst den Übertrag auf (er verfällt zuerst)
 *  - Die Erinnerung erscheint NUR bei offenem Übertrag und nennt die Zahl
 *  - Ohne Übertrag wird niemand behelligt
 *
 * Die Systemzeit der Seite wird gefälscht, damit der Test ganzjährig läuft.
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

const fmtT = n => (Math.round(n * 10) / 10).toString().replace('.', ',');

/* Vorjahr 2025: 26 Arbeitstage -> 26/13 = 2,0 Tage Anspruch.
 * Davon 0 genommen -> Übertrag 2,0 Tage nach 2026.
 * Laufendes Jahr 2026: 13 Arbeitstage -> 1,0 Tag Anspruch. */
const VORJAHR_TAGE = 26;
const HEUER_TAGE = 13;
const ERW_UEBERTRAG = 2;
const ERW_ANSPRUCH = 1;

function tage(jahr, anzahl) {
    // Fortlaufende Daten ab dem 6. Januar, sicher innerhalb des Jahres.
    const out = [];
    const start = new Date(Date.UTC(jahr, 0, 6));
    for (let i = 0; i < anzahl; i++) {
        const d = new Date(start);
        d.setUTCDate(d.getUTCDate() + i * 7);
        out.push(d.toISOString().slice(0, 10));
    }
    return out;
}

function db(urlaubVorjahr = []) {
    let id = 0;
    const schicht = date => ({
        id: ++id, employeeId: 2, date, startTime: '08:00', endTime: '13:00',
        room: 'A', secondRoom: null, isDouble: false, isVacation: false,
        note: '', createdAt: date + 'T13:00:00.000Z',
    });
    const urlaub = date => ({
        id: ++id, employeeId: 2, date, startTime: '', endTime: '',
        room: null, secondRoom: null, isDouble: false, isVacation: true,
        urlaubsBetrag: 50, note: '', createdAt: date + 'T00:00:00.000Z',
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
            ...tage(2025, VORJAHR_TAGE).map(schicht),
            ...tage(2026, HEUER_TAGE).map(schicht),
            ...urlaubVorjahr.map(urlaub),
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
        adminNotes: '', updatedAt: '2026-01-01T00:00:00.000Z',
    };
}

/* Seite mit gefälschtem Datum öffnen. wer: 'admin' oder 'kraft' — die
 * Erinnerung gilt für alle Rollen, geprüft wird sie beim Mitarbeiter. */
async function openApp(browser, data, fakeToday, wer = 'admin', ackVacation = true) {
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
    await ctx.addInitScript(([k, d, ack]) => {
        localStorage.setItem(k, JSON.stringify(d));
        const iso = new Date().toISOString();
        localStorage.setItem('paraloxStunden.dsgvoAccepted', JSON.stringify({ '1': iso, '2': iso }));
        if (ack) localStorage.setItem('paraloxStunden.vacationReminder', JSON.stringify({ '1': iso, '2': iso }));
    }, [DB_KEY, data, ackVacation]);
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 160)); fails++; });
    await page.goto(APP_URL);
    await page.waitForTimeout(900);
    await page.evaluate((name) => {
        const sel = document.getElementById('loginName');
        sel.value = Array.from(sel.options).find(o => o.textContent === name).value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }, wer === 'admin' ? 'Admin' : 'Testkraft');
    await page.waitForTimeout(900);
    return page;
}

// Werte aus dem Urlaubs-Dialog des Admins lesen.
async function konto(page) {
    await page.evaluate(() => document.querySelector('[data-tab="employees"]')?.click());
    await page.waitForTimeout(350);
    await page.evaluate(() => document.querySelector('[data-emp-urlaub="2"]').click());
    await page.waitForTimeout(400);
    const werte = await page.evaluate(() => ({
        stats: Array.from(document.querySelectorAll('#modalBody .stat')).map(s => ({
            label: s.querySelector('.label').textContent.trim(),
            value: s.querySelector('.value').textContent.trim(),
        })),
        hinweis: document.querySelector('#modalBody p.muted')?.textContent.trim() || '',
    }));
    await page.evaluate(() => document.getElementById('modalCancel').click());
    await page.waitForTimeout(150);
    return werte;
}
const wert = (k, l) => (k.stats.find(s => s.label.startsWith(l)) || {}).value;

(async () => {
    const browser = await chromium.launch({ channel: 'chrome' });

    console.log('Übertrag vor dem Stichtag');
    let page = await openApp(browser, db(), '2026-05-15');
    let k = await konto(page);
    check(`Anspruch 2026 = ${ERW_ANSPRUCH} (${HEUER_TAGE} Arbeitstage ÷ 13)`,
        wert(k, 'Anspruch') === fmtT(ERW_ANSPRUCH) + ' Tage', wert(k, 'Anspruch'));
    check(`Übertrag aus 2025 = ${ERW_UEBERTRAG} (${VORJAHR_TAGE} ÷ 13, nichts genommen)`,
        wert(k, 'Übertrag') === fmtT(ERW_UEBERTRAG) + ' Tage', wert(k, 'Übertrag'));
    check('Übrig = Anspruch + Übertrag',
        wert(k, 'Übrig') === fmtT(ERW_ANSPRUCH + ERW_UEBERTRAG) + ' Tage', wert(k, 'Übrig'));
    check('Hinweis nennt den Verfall zum 30. Juni',
        /verfällt zum 30\. Juni 2026/.test(k.hinweis), k.hinweis.slice(-70));
    await page.context().close();

    console.log('Am Stichtag selbst noch nutzbar');
    page = await openApp(browser, db(), '2026-06-30');
    k = await konto(page);
    check('am 30.06. Übertrag weiterhin verfügbar',
        wert(k, 'Übertrag') === fmtT(ERW_UEBERTRAG) + ' Tage', wert(k, 'Übertrag'));
    await page.context().close();

    console.log('Nach dem Stichtag verfallen');
    page = await openApp(browser, db(), '2026-07-01');
    k = await konto(page);
    check('am 01.07. als verfallen ausgewiesen',
        /verfallen/.test(wert(k, 'Übertrag') || ''), wert(k, 'Übertrag'));
    check('Übrig nur noch der laufende Anspruch',
        wert(k, 'Übrig') === fmtT(ERW_ANSPRUCH) + ' Tage', wert(k, 'Übrig'));
    check('Hinweis spricht in der Vergangenheit',
        /ist zum 30\. Juni 2026 verfallen/.test(k.hinweis), k.hinweis.slice(-70));
    await page.context().close();

    console.log('Genommene Tage zehren zuerst den Übertrag auf');
    // Ein Urlaubstag im Januar 2026 -> geht gegen den Übertrag, nicht gegen 2026.
    page = await openApp(browser, db(['2026-01-02']), '2026-05-15');
    k = await konto(page);
    check('Genommen = 1', wert(k, 'Genommen') === '1 Tage', wert(k, 'Genommen'));
    check('Übrig = Anspruch + Übertrag − 1',
        wert(k, 'Übrig') === fmtT(ERW_ANSPRUCH + ERW_UEBERTRAG - 1) + ' Tage', wert(k, 'Übrig'));
    await page.context().close();

    console.log('Erinnerung Ende März');
    // Mitarbeiter mit offenem Übertrag, Quittierung NICHT gesetzt.
    page = await openApp(browser, db(), '2026-03-30', 'kraft', false);
    let modal = await page.evaluate(() => {
        const m = document.getElementById('vacationReminderModal');
        return { sichtbar: m && !m.classList.contains('hidden'),
                 text: document.getElementById('vacationReminderText')?.textContent || '' };
    });
    check('Erinnerung erscheint am 30.03.', modal.sichtbar);
    check('nennt die offenen Tage konkret',
        new RegExp(`${fmtT(ERW_UEBERTRAG)} Urlaubstage`).test(modal.text), modal.text.slice(0, 130));
    check('nennt den 30. Juni als Frist', /30\. Juni 2026/.test(modal.text));
    await page.context().close();

    console.log('Ohne offenen Übertrag keine Erinnerung');
    // Beide Urlaubstage des Vorjahres genommen -> Übertrag 0.
    page = await openApp(browser, db(['2025-03-03', '2025-03-10']), '2026-03-30', 'kraft', false);
    modal = await page.evaluate(() => {
        const m = document.getElementById('vacationReminderModal');
        return { sichtbar: m && !m.classList.contains('hidden') };
    });
    check('keine Erinnerung ohne offenen Übertrag', !modal.sichtbar);
    await page.context().close();

    console.log('Vor dem Fenster keine Erinnerung');
    page = await openApp(browser, db(), '2026-03-29', 'kraft', false);
    modal = await page.evaluate(() => {
        const m = document.getElementById('vacationReminderModal');
        return { sichtbar: m && !m.classList.contains('hidden') };
    });
    check('am 29.03. noch nicht', !modal.sichtbar);
    await page.context().close();

    await browser.close();
    console.log(fails === 0 ? '\nAlle Prüfungen bestanden.' : `\n${fails} Prüfung(en) fehlgeschlagen.`);
    process.exit(fails === 0 ? 0 : 1);
})();
