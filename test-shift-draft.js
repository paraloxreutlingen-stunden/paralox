/* Test: Entwurf einer angefangenen Schicht übersteht den Auto-Logout.
 *  - Halb ausgefülltes Formular wird gerätelokal gesichert
 *  - Nach Auto-Logout + Wieder-Login sind die Felder zurück
 *  - Eine laufende Schicht hat Vorrang, ihr Entwurf wird nicht danebengelegt
 *  - Nach dem Speichern der Schicht ist der Entwurf verworfen
 *  - Entwurf eines früheren Tages wird nicht wiederhergestellt
 *  - Der Entwurf landet NICHT in der Haupt-Datenbank (keine Phantom-Schicht)
 *
 * Läuft gegen Test-Daten (Default-Seed), nicht gegen die produktiven Daten.
 */
'use strict';
const { chromium } = require('playwright-core');
const APP_URL = process.env.PARALOX_URL || 'http://127.0.0.1:8080/index.html';

let fails = 0;
function check(label, cond, detail) {
    console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? ': ' + detail : ''}`);
    if (!cond) fails++;
}

const DRAFT_KEY = 'paraloxStunden.shiftDrafts';

async function newPage(browser) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript(() => {
        const iso = new Date().toISOString();
        const seen = JSON.stringify({ '1': iso, '2': iso, '99': iso });
        localStorage.setItem('paraloxStunden.dsgvoAccepted', seen);
        localStorage.setItem('paraloxStunden.vacationReminder', seen);
    });
    await page.clock.install();
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
    await page.evaluate(() => document.querySelector('[data-tab="enter"]')?.click());
    await page.waitForTimeout(300);
}

// Felder so füllen, wie es ein Mitarbeiter täte — mit echten Events, damit die
// Entwurfs-Sicherung anspringt.
async function fill(page, vals) {
    await page.evaluate((v) => {
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el.type === 'checkbox') el.checked = !!val; else el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        if (v.start != null) set('sfStart', v.start);
        if (v.end != null) set('sfEnd', v.end);
        if (v.note != null) set('sfNote', v.note);
        if (v.room != null) {
            const sel = document.getElementById('sfRoom');
            const opt = Array.from(sel.options).find(o => o.value) || sel.options[0];
            set('sfRoom', v.room === true ? opt.value : v.room);
        }
    }, vals);
    await page.waitForTimeout(150);
}

const formState = page => page.evaluate(() => ({
    start: document.getElementById('sfStart').value,
    end: document.getElementById('sfEnd').value,
    room: document.getElementById('sfRoom').value,
    note: document.getElementById('sfNote').value,
}));
const draftRaw = page => page.evaluate(k => localStorage.getItem(k) || '(leer)', DRAFT_KEY);
const shiftCount = page => page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('paraloxStunden.v1') || '{}');
    return (db.shifts || []).length;
});
const eingeloggt = page => page.evaluate(() =>
    !!document.getElementById('view-login')?.classList.contains('hidden'));

// Frist aus app.js lesen, statt die Zahl im Test zu duplizieren.
async function idleMs(page) {
    const src = await page.evaluate(async () => {
        const r = await fetch('app.js'); return r.ok ? await r.text() : '';
    });
    const m = src.match(/IDLE_TIMEOUT_MS\s*=\s*([\d\s*]+);/);
    return m ? Function(`return ${m[1]}`)() : 90000;
}

(async () => {
    const browser = await chromium.launch({ channel: 'chrome' });

    console.log('Entwurf übersteht den Auto-Logout');
    {
        const page = await newPage(browser);
        const ms = await idleMs(page);
        await login(page);
        const vorher = await shiftCount(page);

        await fill(page, { start: '17:15', room: true, note: 'Zeugnis-Event' });
        check('Entwurf gesichert', (await draftRaw(page)).includes('17:15'));
        check('keine Schicht in der Datenbank', (await shiftCount(page)) === vorher,
            `${await shiftCount(page)} Schichten`);

        await page.clock.fastForward(ms + 2000);
        await page.waitForTimeout(1200);
        check('automatisch abgemeldet', !(await eingeloggt(page)));
        check('Entwurf hat den Logout überlebt', (await draftRaw(page)).includes('17:15'));

        await login(page);
        const f = await formState(page);
        check('Beginn wiederhergestellt', f.start === '17:15', JSON.stringify(f.start));
        check('Raum wiederhergestellt', !!f.room, JSON.stringify(f.room));
        check('Notiz wiederhergestellt', f.note === 'Zeugnis-Event', JSON.stringify(f.note));
        await page.context().close();
    }

    console.log('Laufende Schicht hat Vorrang');
    {
        const page = await newPage(browser);
        const ms = await idleMs(page);
        await login(page);
        await fill(page, { start: '08:00', room: true });
        await page.evaluate(() => document.getElementById('sfStartBtn').click());
        await page.waitForTimeout(500);
        check('Entwurf beim Starten verworfen', (await draftRaw(page)) === '{}' ||
            !(await draftRaw(page)).includes('08:00'), await draftRaw(page));

        // Endezeit im Beenden-Modus eintippen darf keinen Entwurf anlegen.
        await fill(page, { end: '12:00' });
        check('im Beenden-Modus kein Entwurf', !(await draftRaw(page)).includes('12:00'),
            await draftRaw(page));

        await page.clock.fastForward(ms + 2000);
        await page.waitForTimeout(1200);
        await login(page);
        const f = await formState(page);
        check('laufende Schicht weiterhin vorbelegt', f.start === '08:00', JSON.stringify(f.start));
        await page.context().close();
    }

    console.log('Entwurf wird nach dem Speichern verworfen');
    {
        const page = await newPage(browser);
        await login(page);
        const vorher = await shiftCount(page);
        await fill(page, { start: '09:00', end: '11:00', room: true });
        check('Entwurf vor dem Speichern da', (await draftRaw(page)).includes('09:00'));

        await page.evaluate(() => document.getElementById('sfSaveBtn').click());
        await page.waitForTimeout(700);
        check('Schicht gespeichert', (await shiftCount(page)) === vorher + 1,
            `${vorher} -> ${await shiftCount(page)}`);
        check('Entwurf verworfen', !(await draftRaw(page)).includes('09:00'), await draftRaw(page));
        await page.context().close();
    }

    console.log('Entwurf von gestern wird nicht wiederhergestellt');
    {
        const page = await newPage(browser);
        await page.evaluate((k) => {
            const gestern = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
            localStorage.setItem(k, JSON.stringify({
                '1': { date: gestern, startTime: '23:00', endTime: '', room: '',
                       isDouble: false, secondRoom: '', note: 'alt', savedAt: gestern },
            }));
        }, DRAFT_KEY);
        await login(page);
        const f = await formState(page);
        check('alter Entwurf nicht übernommen', f.start === '' && f.note === '',
            JSON.stringify(f));
        check('alter Entwurf entfernt', !(await draftRaw(page)).includes('23:00'),
            await draftRaw(page));
        await page.context().close();
    }

    await browser.close();
    console.log(fails === 0 ? '\nAlle Prüfungen bestanden.' : `\n${fails} Prüfung(en) fehlgeschlagen.`);
    process.exit(fails === 0 ? 0 : 1);
})();
