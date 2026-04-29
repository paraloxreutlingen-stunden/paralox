/* Tests für die Tagessicherung per Mail:
 *  1. Settings: Häkchen + Empfänger speichern
 *  2. Erstes Schicht-Speichern eines Tages → navigator.share wird aufgerufen
 *  3. Zweites Schicht-Speichern desselben Tages → KEIN weiterer share-Aufruf
 *  4. Backup-Datei: enthält den vollen App-State
 *  5. "Jetzt sichern"-Button: löst share manuell aus
 *  6. lastBackupDate-Marker liegt SEPARAT (nicht in paraloxStunden.v1) und
 *     wird beim Share gesetzt, beim Abort nicht.
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

/* Im Page-Kontext navigator.share + navigator.canShare mocken, damit jeder
 * Aufruf in window.__shareCalls gepuffert wird. shareBehavior steuert, ob
 * der Mock erfolgreich ist (resolve), abbricht (AbortError) oder fehlschlägt. */
async function setupShareMock(page, behavior = 'success') {
    await page.addInitScript((b) => {
        window.__shareCalls = [];
        window.__shareBehavior = b;
        navigator.canShare = (data) => !!(data && data.files && data.files.length);
        navigator.share = async (data) => {
            const files = (data.files || []).map(f => ({
                name: f.name, size: f.size, type: f.type,
            }));
            window.__shareCalls.push({
                files,
                title: data.title,
                text: data.text,
            });
            if (window.__shareBehavior === 'abort') {
                const err = new Error('User cancelled');
                err.name = 'AbortError';
                throw err;
            }
            if (window.__shareBehavior === 'fail') {
                throw new Error('Share fehlgeschlagen');
            }
            // success
        };
    }, behavior);
}

async function newPage(behavior = 'success') {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await setupShareMock(page, behavior);
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(500);
    return { browser, page };
}

async function loginAsOwner1(page) {
    await page.evaluate(() => {
        const sel = document.getElementById('loginName');
        const opt = Array.from(sel.options).find(o => o.textContent === 'Owner1');
        sel.value = opt.value;
        document.getElementById('loginPassword').value = 'paralox';
        document.getElementById('loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
    await page.waitForTimeout(800);
}

async function enableBackup(page, recipient = 'backup@example.com') {
    // Settings-Tab öffnen
    await page.evaluate(() => {
        Array.from(document.querySelectorAll('#tabs button'))
            .find(b => b.dataset.tab === 'settings').click();
    });
    await page.waitForTimeout(300);
    await page.evaluate((r) => {
        document.getElementById('setBackupEnabled').checked = true;
        document.getElementById('setBackupRecipient').value = r;
        document.getElementById('backupForm').dispatchEvent(
            new Event('submit', { cancelable: true, bubbles: true }));
    }, recipient);
    await page.waitForTimeout(300);
}

async function saveShift(page, date, start, end) {
    // Tab "Neue Schicht" → Form ausfüllen → submit
    await page.evaluate(() => {
        Array.from(document.querySelectorAll('#tabs button'))
            .find(b => b.dataset.tab === 'enter').click();
    });
    await page.waitForTimeout(300);
    await page.evaluate(({ d, s, e }) => {
        document.getElementById('sfDate').value = d;
        document.getElementById('sfStart').value = s;
        document.getElementById('sfEnd').value = e;
        const room = document.getElementById('sfRoom');
        room.value = 'FP';
        document.getElementById('shiftForm').dispatchEvent(
            new Event('submit', { cancelable: true, bubbles: true }));
    }, { d: date, s: start, e: end });
    await page.waitForTimeout(800);
}

(async () => {
    // -------- 1. Erstes Save eines Tages triggert Backup --------
    console.log('\n=== Erstes Schicht-Speichern → Web Share wird aufgerufen ===');
    {
        const { browser, page } = await newPage('success');
        await loginAsOwner1(page);
        await enableBackup(page, 'backup@example.com');

        const today = new Date().toISOString().slice(0, 10);
        await saveShift(page, today, '10:00', '12:00');

        const calls = await page.evaluate(() => window.__shareCalls);
        check('navigator.share wurde 1× aufgerufen', calls.length === 1,
            'count=' + calls.length);
        if (calls.length) {
            const c = calls[0];
            check('Share-Datei hat .json-Endung', /\.json$/.test(c.files[0]?.name || ''),
                c.files[0]?.name);
            check('Dateiname enthält heutiges Datum',
                (c.files[0]?.name || '').includes(today),
                c.files[0]?.name);
            check('MIME-Type application/json',
                c.files[0]?.type === 'application/json', c.files[0]?.type);
            check('Share-Text enthält Empfänger',
                /backup@example\.com/.test(c.text || ''), c.text);
        }

        const lastDate = await page.evaluate(() =>
            localStorage.getItem('paraloxStunden.lastBackup'));
        check('lastBackup-Marker auf heute gesetzt', lastDate === today, lastDate);

        const inMain = await page.evaluate(() => {
            const raw = localStorage.getItem('paraloxStunden.v1');
            return /lastBackup/.test(raw);
        });
        check('lastBackup NICHT in paraloxStunden.v1 (Backup-sicher)', !inMain);

        await browser.close();
    }

    // -------- 2. Zweites Save desselben Tages → KEIN re-trigger --------
    console.log('\n=== Zweites Schicht-Speichern desselben Tages → kein erneuter Share ===');
    {
        const { browser, page } = await newPage('success');
        await loginAsOwner1(page);
        await enableBackup(page);

        const today = new Date().toISOString().slice(0, 10);
        await saveShift(page, today, '10:00', '12:00');
        await saveShift(page, today, '14:00', '16:00');

        const calls = await page.evaluate(() => window.__shareCalls);
        check('navigator.share wurde nur 1× aufgerufen (nicht 2×)', calls.length === 1,
            'count=' + calls.length);

        await browser.close();
    }

    // -------- 3. Backup-Inhalt: voller App-State --------
    console.log('\n=== Backup-Datei enthält vollen App-State ===');
    {
        // Eigener Mock, der die Datei direkt liest und mit einbettet.
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.addInitScript(() => {
            window.__shareCalls = [];
            navigator.canShare = (data) => !!(data && data.files && data.files.length);
            navigator.share = async (data) => {
                let fileText = null;
                if (data.files && data.files[0]) fileText = await data.files[0].text();
                window.__shareCalls.push({
                    name: data.files?.[0]?.name || null,
                    title: data.title,
                    text: data.text,
                    fileText,
                });
            };
        });
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(500);
        await loginAsOwner1(page);
        await enableBackup(page);
        const today = new Date().toISOString().slice(0, 10);
        await saveShift(page, today, '10:00', '12:00');
        await page.waitForTimeout(500);

        const calls = await page.evaluate(() => window.__shareCalls);
        const fileText = calls[0]?.fileText;
        check('Datei-Inhalt vorhanden', !!fileText);
        if (fileText) {
            const j = JSON.parse(fileText);
            check('JSON hat type=paralox-stunden-backup',
                j.type === 'paralox-stunden-backup', j.type);
            check('JSON hat data.employees (>= 2)',
                Array.isArray(j.data?.employees) && j.data.employees.length >= 2);
            check('JSON hat data.settings', !!j.data?.settings);
            check('JSON hat eingetragene Schicht (>= 1)',
                Array.isArray(j.data?.shifts) && j.data.shifts.length >= 1);
        }

        await browser.close();
    }

    // -------- 4. Abort: lastBackupDate wird NICHT gesetzt --------
    console.log('\n=== Share-Abort: lastBackup-Marker bleibt leer ===');
    {
        const { browser, page } = await newPage('abort');
        await loginAsOwner1(page);
        await enableBackup(page);
        const today = new Date().toISOString().slice(0, 10);
        await saveShift(page, today, '10:00', '12:00');

        const calls = await page.evaluate(() => window.__shareCalls);
        check('navigator.share wurde versucht', calls.length === 1);
        const lastDate = await page.evaluate(() =>
            localStorage.getItem('paraloxStunden.lastBackup'));
        check('lastBackup-Marker NICHT gesetzt nach Abbruch',
            lastDate === null || lastDate === undefined, lastDate);

        // Nochmal speichern → erneuter Versuch
        await saveShift(page, today, '14:00', '16:00');
        const calls2 = await page.evaluate(() => window.__shareCalls);
        check('Nach Abbruch: nächstes Save versucht erneut zu sichern',
            calls2.length === 2, 'count=' + calls2.length);

        await browser.close();
    }

    // -------- 5. Backup deaktiviert → kein Trigger --------
    console.log('\n=== Backup deaktiviert: kein Share beim Save ===');
    {
        const { browser, page } = await newPage('success');
        await loginAsOwner1(page);
        // Settings nicht aktivieren → enabled bleibt false
        const today = new Date().toISOString().slice(0, 10);
        await saveShift(page, today, '10:00', '12:00');
        const calls = await page.evaluate(() => window.__shareCalls);
        check('Kein Share-Aufruf wenn Tagessicherung aus', calls.length === 0,
            'count=' + calls.length);
        await browser.close();
    }

    // -------- 6. "Jetzt sichern"-Button funktioniert auch wenn schon heute gesichert --------
    console.log('\n=== "Jetzt sichern" erzwingt Share auch heute ===');
    {
        const { browser, page } = await newPage('success');
        await loginAsOwner1(page);
        await enableBackup(page);
        const today = new Date().toISOString().slice(0, 10);
        await saveShift(page, today, '10:00', '12:00');
        // Manuell nochmal sichern
        await page.evaluate(() => {
            Array.from(document.querySelectorAll('#tabs button'))
                .find(b => b.dataset.tab === 'settings').click();
        });
        await page.waitForTimeout(300);
        await page.evaluate(() => document.getElementById('backupNow').click());
        await page.waitForTimeout(800);
        const calls = await page.evaluate(() => window.__shareCalls);
        check('navigator.share 2× (auto + manuell)', calls.length === 2,
            'count=' + calls.length);
        await browser.close();
    }

    console.log('\n' + (fails === 0
        ? '✓ ALLE TAGESSICHERUNG-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
