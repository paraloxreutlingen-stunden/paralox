/* Test: "Schicht starten / Schicht beenden"-Workflow.
 *  - Mitarbeiter startet Schicht: läuft auch nach Logout/Reload weiter
 *  - Beenden trägt eine fertige Schicht in shifts ein, löscht die offene
 *  - Doppelüberwachung kann beim Beenden noch geändert werden
 *  - Solange eine Schicht läuft, kann KEINE neue gestartet werden
 *  - Topbar-Indikator wird sichtbar, sobald eine Schicht läuft
 */
'use strict';
const { chromium } = require('playwright-core');
const APP_URL = process.env.PARALOX_URL || 'http://127.0.0.1:8080/index.html';
const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

let fails = 0;
function check(label, cond, detail) {
    const m = cond ? '✓' : '✗';
    console.log(`  ${m} ${label}${detail ? ': ' + detail : ''}`);
    if (!cond) fails++;
}

async function newPage(browser) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript(() => {
        // Login-blockierendes DSGVO-Popup vorab als gesehen markieren
        localStorage.setItem('paraloxStunden.dsgvoAccepted', new Date().toISOString());
    });
    return page;
}

async function loginAsOwner1(page) {
    // Falls bereits eingeloggt (sessionStorage): kein Login mehr nötig.
    const alreadyIn = await page.evaluate(() =>
        document.getElementById('view-login')?.classList.contains('hidden'));
    if (alreadyIn) return;
    await page.evaluate(() => {
        const sel = document.getElementById('loginName');
        const opt = Array.from(sel.options).find(o => o.textContent === 'Owner1');
        sel.value = opt.value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(
            new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(800);
}

async function fillForm(page, vals) {
    await page.evaluate((v) => {
        if (v.date != null)  document.getElementById('sfDate').value = v.date;
        if (v.start != null) document.getElementById('sfStart').value = v.start;
        if (v.end != null)   document.getElementById('sfEnd').value = v.end;
        if (v.room != null) {
            const sel = document.getElementById('sfRoom');
            sel.value = v.room;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (v.note != null)  document.getElementById('sfNote').value = v.note;
        if (v.isDouble != null) {
            const cb = document.getElementById('sfDouble');
            cb.checked = !!v.isDouble;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (v.room2 != null) {
            const sel = document.getElementById('sfRoom2');
            sel.value = v.room2;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }, vals);
}

(async () => {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });

    // -------- 1. Schicht starten, dann (auch nach Reload) das Ende eintragen --------
    console.log('\n=== Schicht starten → über Reload erhalten → beenden ===');
    {
        const page = await newPage(browser);
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(500);
        await loginAsOwner1(page);

        // Initial: Form ist im Normalmodus, Banner versteckt, Start-Button sichtbar
        let st = await page.evaluate(() => ({
            bannerHidden: document.getElementById('runningShiftBanner').classList.contains('hidden'),
            startVisible: !document.getElementById('sfStartBtn').classList.contains('hidden'),
            endHidden:    document.getElementById('sfEndBtn').classList.contains('hidden'),
            indicatorHidden: document.getElementById('topRunningIndicator').classList.contains('hidden'),
        }));
        check('Start: Banner versteckt', st.bannerHidden);
        check('Start: "Schicht starten"-Button sichtbar', st.startVisible);
        check('Start: "Schicht beenden"-Button versteckt', st.endHidden);
        check('Start: Topbar-Indikator versteckt', st.indicatorHidden);

        await fillForm(page, { start: '10:00', room: 'FP', note: 'Schichtbeginn' });
        await page.click('#sfStartBtn');
        await page.waitForTimeout(400);

        // localStorage hat die offene Schicht
        const open = await page.evaluate(() =>
            JSON.parse(localStorage.getItem('paraloxStunden.runningShifts') || '{}'));
        check('localStorage: offene Schicht für Owner1 (id=1) gespeichert',
            open['1'] && open['1'].startTime === '10:00' && open['1'].room === 'FP',
            JSON.stringify(open));

        st = await page.evaluate(() => ({
            bannerHidden: document.getElementById('runningShiftBanner').classList.contains('hidden'),
            bannerText: document.getElementById('runningShiftBanner').textContent,
            startHidden: document.getElementById('sfStartBtn').classList.contains('hidden'),
            saveHidden: document.getElementById('sfSaveBtn').classList.contains('hidden'),
            endVisible: !document.getElementById('sfEndBtn').classList.contains('hidden'),
            indicatorVisible: !document.getElementById('topRunningIndicator').classList.contains('hidden'),
            startInputDisabled: document.getElementById('sfStart').disabled,
            roomInputDisabled: document.getElementById('sfRoom').disabled,
        }));
        check('Nach Start: Banner sichtbar', !st.bannerHidden);
        check('Banner nennt Beginn-Zeit', /10:00/.test(st.bannerText), st.bannerText.slice(0, 100));
        check('Nach Start: "Schicht starten" versteckt', st.startHidden);
        check('Nach Start: "Komplett speichern" versteckt', st.saveHidden);
        check('Nach Start: "Schicht beenden" sichtbar', st.endVisible);
        check('Nach Start: Topbar-Indikator sichtbar', st.indicatorVisible);
        check('Nach Start: Beginn-Feld read-only (disabled)', st.startInputDisabled);
        check('Nach Start: Raum-Feld read-only (disabled)', st.roomInputDisabled);

        // Reload — offene Schicht muss erhalten bleiben, Banner muss wieder erscheinen
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(500);
        await loginAsOwner1(page);

        const stillOpen = await page.evaluate(() =>
            JSON.parse(localStorage.getItem('paraloxStunden.runningShifts') || '{}'));
        check('Nach Reload: offene Schicht noch da',
            stillOpen['1'] && stillOpen['1'].startTime === '10:00');

        st = await page.evaluate(() => ({
            bannerHidden: document.getElementById('runningShiftBanner').classList.contains('hidden'),
            endVisible: !document.getElementById('sfEndBtn').classList.contains('hidden'),
        }));
        check('Nach Reload: Banner wieder sichtbar', !st.bannerHidden);
        check('Nach Reload: "Schicht beenden" wieder sichtbar', st.endVisible);

        // Ende eintragen, beenden
        await fillForm(page, { end: '14:30' });
        await page.click('#sfEndBtn');
        await page.waitForTimeout(500);

        const result = await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            const last = data.shifts[data.shifts.length - 1];
            const open = JSON.parse(localStorage.getItem('paraloxStunden.runningShifts') || '{}');
            return { last, openCount: Object.keys(open).length };
        });
        check('Schicht in shifts gespeichert (Beginn 10:00, Ende 14:30, Raum FP)',
            result.last && result.last.startTime === '10:00' && result.last.endTime === '14:30'
                && result.last.room === 'FP' && result.last.employeeId === 1,
            JSON.stringify(result.last));
        check('Notiz vom Start übernommen (Schichtbeginn)',
            result.last && result.last.note === 'Schichtbeginn',
            result.last?.note);
        check('Offene Schicht ist wieder leer', result.openCount === 0);

        await page.context().close();
    }

    // -------- 2. Doppelüberwachung erst beim Beenden hinzufügen --------
    console.log('\n=== Doppelüberwachung wird erst beim Beenden festgelegt ===');
    {
        const page = await newPage(browser);
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(500);
        await loginAsOwner1(page);

        await fillForm(page, { start: '11:00', room: 'FP' });
        await page.click('#sfStartBtn');
        await page.waitForTimeout(400);

        // Beim Beenden: Doppelüberwachung aktivieren + zweiten Raum wählen
        await fillForm(page, { isDouble: true, room2: 'SL', end: '15:00' });
        await page.waitForTimeout(200);
        await page.click('#sfEndBtn');
        await page.waitForTimeout(400);

        const last = await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            return data.shifts[data.shifts.length - 1];
        });
        check('Schicht ist als Doppel gespeichert', last && last.isDouble === true, JSON.stringify(last));
        check('Zweiter Raum ist SL', last && last.secondRoom === 'SL');

        await page.context().close();
    }

    // -------- 3. Solange eine Schicht läuft, geht keine neue auf --------
    console.log('\n=== Während laufender Schicht kann KEINE neue gestartet werden ===');
    {
        const page = await newPage(browser);
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(500);
        await loginAsOwner1(page);

        await fillForm(page, { start: '09:00', room: 'FP' });
        await page.click('#sfStartBtn');
        await page.waitForTimeout(300);

        // "Schicht starten" ist jetzt versteckt — der Button kann gar nicht
        // mehr getriggert werden. Wir simulieren trotzdem einen direkten Klick
        // auf das Element (über Selector), um die Defense-in-Depth zu testen.
        const before = await page.evaluate(() =>
            JSON.parse(localStorage.getItem('paraloxStunden.runningShifts') || '{}')['1']);
        await page.evaluate(() => document.getElementById('sfStartBtn').click());
        await page.waitForTimeout(300);
        const after = await page.evaluate(() =>
            JSON.parse(localStorage.getItem('paraloxStunden.runningShifts') || '{}')['1']);
        check('Offene Schicht wurde nicht überschrieben (Beginn unverändert)',
            before && after && before.startTime === after.startTime,
            `vorher=${before?.startTime}, nachher=${after?.startTime}`);

        await page.context().close();
    }

    await browser.close();
    console.log('\n' + (fails === 0
        ? '✓ ALLE RUNNING-SHIFT-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
