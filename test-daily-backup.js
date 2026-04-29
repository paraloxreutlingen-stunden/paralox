/* Tests für die Tagessicherung per Mail (Trigger: erster Login des Tages):
 *  1. Login → navigator.share wird einmal aufgerufen, Datei korrekt benannt,
 *     Share-Text enthält Empfänger.
 *  2. Zweiter Login desselben Tages → kein erneuter Share-Aufruf
 *     (lastBackupDate-Marker greift).
 *  3. Backup-Datei: enthält den vollen App-State.
 *  4. Share-Abort → lastBackupDate-Marker bleibt leer, nächster Login
 *     versucht erneut.
 *  5. dailyBackup.enabled=false → kein Share beim Login.
 *  6. "Jetzt sichern"-Button erzwingt auch nach erfolgtem Auto-Backup.
 *  7. lastBackup-Marker liegt SEPARAT (nicht in paraloxStunden.v1).
 */
'use strict';
const { chromium } = require('playwright-core');

const APP_URL = process.env.PARALOX_URL || 'http://127.0.0.1:8080/paralox-stunden.html';
const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const RECIPIENT = 'backup@example.com';

let fails = 0;
function check(label, cond, detail) {
    const m = cond ? '✓' : '✗';
    console.log(`  ${m} ${label}${detail ? ': ' + detail : ''}`);
    if (!cond) fails++;
}

async function setupShareMock(page, behavior = 'success') {
    // localStorage als Persistenz, damit __shareCalls einen location.reload()
    // (z.B. doLogout) überlebt. addInitScript läuft bei jedem Page-Load
    // wieder — aber localStorage bleibt.
    await page.addInitScript((b) => {
        const KEY = '__test_shareCalls';
        const load = () => {
            try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
            catch { return []; }
        };
        const save = (arr) => localStorage.setItem(KEY, JSON.stringify(arr));
        window.__shareBehavior = b;
        window.__getShareCalls = load;
        window.__resetShareCalls = () => save([]);
        navigator.canShare = (data) => !!(data && data.files && data.files.length);
        navigator.share = async (data) => {
            let fileText = null;
            if (data.files && data.files[0]) {
                try { fileText = await data.files[0].text(); } catch {}
            }
            const arr = load();
            arr.push({
                name: data.files?.[0]?.name || null,
                type: data.files?.[0]?.type || null,
                size: data.files?.[0]?.size || null,
                title: data.title,
                text: data.text,
                fileText,
            });
            save(arr);
            if (window.__shareBehavior === 'abort') {
                const err = new Error('User cancelled');
                err.name = 'AbortError';
                throw err;
            }
            if (window.__shareBehavior === 'fail') {
                throw new Error('Share fehlgeschlagen');
            }
        };
    }, behavior);
}

async function newPage(behavior = 'success', primeRecipient = RECIPIENT) {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await setupShareMock(page, behavior);
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(500);
    // Recipient vor Login auf Test-Adresse setzen — beim ersten Laden hat
    // storage.js den Default eingetragen, wir überschreiben hier.
    if (primeRecipient !== null) {
        await page.evaluate((r) => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            if (data && data.settings && data.settings.dailyBackup) {
                data.settings.dailyBackup.recipient = r;
                data.settings.dailyBackup.enabled = true;
                localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
            }
        }, primeRecipient);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(500);
    }
    return { browser, page };
}

async function loginAsOwner1(page) {
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

async function logoutAndLoginAgain(page) {
    await page.evaluate(() => document.getElementById('btnLogout').click());
    await page.waitForTimeout(800);
    // doLogout ruft location.reload — wir warten auf Reload und Mocks neu
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    await loginAsOwner1(page);
}

async function saveShift(page, date, start, end) {
    await page.evaluate(() => {
        Array.from(document.querySelectorAll('#tabs button'))
            .find(b => b.dataset.tab === 'enter').click();
    });
    await page.waitForTimeout(300);
    await page.evaluate(({ d, s, e }) => {
        document.getElementById('sfDate').value = d;
        document.getElementById('sfStart').value = s;
        document.getElementById('sfEnd').value = e;
        document.getElementById('sfRoom').value = 'FP';
        document.getElementById('shiftForm').dispatchEvent(
            new Event('submit', { cancelable: true, bubbles: true }));
    }, { d: date, s: start, e: end });
    await page.waitForTimeout(500);
}

(async () => {
    // -------- 1. Erster Login des Tages → Web Share --------
    console.log('\n=== Erster Login des Tages → Web Share wird aufgerufen ===');
    {
        const { browser, page } = await newPage('success');
        await loginAsOwner1(page);

        const calls = await page.evaluate(() => window.__getShareCalls());
        check('navigator.share wurde 1× aufgerufen', calls.length === 1,
            'count=' + calls.length);
        if (calls.length) {
            const c = calls[0];
            const today = new Date().toISOString().slice(0, 10);
            check('Share-Datei hat .json-Endung', /\.json$/.test(c.name || ''), c.name);
            check('Dateiname enthält heutiges Datum',
                (c.name || '').includes(today), c.name);
            check('MIME-Type application/json', c.type === 'application/json', c.type);
            check('Share-Text enthält Empfänger',
                /backup@example\.com/.test(c.text || ''), c.text);
        }

        const today = new Date().toISOString().slice(0, 10);
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

    // -------- 2. Zweiter Login desselben Tages → kein erneuter Share --------
    console.log('\n=== Zweiter Login desselben Tages → kein erneuter Share ===');
    {
        const { browser, page } = await newPage('success');
        await loginAsOwner1(page);
        await logoutAndLoginAgain(page);

        const calls = await page.evaluate(() => window.__getShareCalls());
        check('navigator.share wurde nur 1× aufgerufen (nicht 2×)',
            calls.length === 1, 'count=' + calls.length);

        await browser.close();
    }

    // -------- 3. Backup-Datei enthält vollen App-State --------
    console.log('\n=== Backup-Datei enthält vollen App-State ===');
    {
        const { browser, page } = await newPage('success');
        // Vor dem Login: eine Schicht direkt in den Storage ablegen, damit
        // beim Login-Trigger der Backup-Inhalt eine Schicht enthält.
        await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.shifts.push({
                id: 9001, employeeId: 1, date: '2026-04-15',
                startTime: '10:00', endTime: '12:00',
                room: 'FP', secondRoom: null, isDouble: false, note: 'pre-test',
                createdAt: new Date().toISOString(),
            });
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(500);
        await loginAsOwner1(page);

        const calls = await page.evaluate(() => window.__getShareCalls());
        const fileText = calls[0]?.fileText;
        check('Datei-Inhalt vorhanden', !!fileText);
        if (fileText) {
            const j = JSON.parse(fileText);
            check('JSON hat type=paralox-stunden-backup',
                j.type === 'paralox-stunden-backup', j.type);
            check('JSON hat data.employees (>= 2)',
                Array.isArray(j.data?.employees) && j.data.employees.length >= 2);
            check('JSON hat data.settings', !!j.data?.settings);
            check('JSON enthält pre-populated Schicht',
                Array.isArray(j.data?.shifts) && j.data.shifts.length >= 1);
        }

        await browser.close();
    }

    // -------- 4. Share-Abort → marker bleibt leer, nächster Login triggert erneut --------
    console.log('\n=== Share-Abort → marker bleibt leer; nächster Login triggert erneut ===');
    {
        const { browser, page } = await newPage('abort');
        await loginAsOwner1(page);

        const lastDate = await page.evaluate(() =>
            localStorage.getItem('paraloxStunden.lastBackup'));
        check('lastBackup NICHT gesetzt nach Abbruch',
            lastDate === null || lastDate === undefined, lastDate);

        await logoutAndLoginAgain(page);

        const calls = await page.evaluate(() => window.__getShareCalls());
        check('Nach Abbruch: erneutes Login löst Share wieder aus',
            calls.length === 2, 'count=' + calls.length);

        await browser.close();
    }

    // -------- 5. Backup deaktiviert: kein Share beim Login --------
    console.log('\n=== Backup deaktiviert → kein Share beim Login ===');
    {
        const browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await setupShareMock(page, 'success');
        await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15000 });
        // Default ist enabled=true; explizit ausschalten BEVOR Login
        await page.evaluate(() => {
            const data = JSON.parse(localStorage.getItem('paraloxStunden.v1'));
            data.settings.dailyBackup.enabled = false;
            data.settings.dailyBackup.recipient = 'backup@example.com';
            localStorage.setItem('paraloxStunden.v1', JSON.stringify(data));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(500);
        await loginAsOwner1(page);

        const calls = await page.evaluate(() => window.__getShareCalls());
        check('Kein Share-Aufruf wenn Tagessicherung aus',
            calls.length === 0, 'count=' + calls.length);

        await browser.close();
    }

    // -------- 6. "Jetzt sichern"-Button erzwingt auch nach Auto-Backup --------
    console.log('\n=== "Jetzt sichern" erzwingt Share auch nach Auto-Backup ===');
    {
        const { browser, page } = await newPage('success');
        await loginAsOwner1(page); // → trigger 1
        await page.evaluate(() => {
            Array.from(document.querySelectorAll('#tabs button'))
                .find(b => b.dataset.tab === 'settings').click();
        });
        await page.waitForTimeout(300);
        await page.evaluate(() => document.getElementById('backupNow').click());
        await page.waitForTimeout(800);
        const calls = await page.evaluate(() => window.__getShareCalls());
        check('navigator.share 2× (auto + manuell)',
            calls.length === 2, 'count=' + calls.length);

        await browser.close();
    }

    console.log('\n' + (fails === 0
        ? '✓ ALLE TAGESSICHERUNG-TESTS BESTANDEN'
        : `✗ ${fails} TEST(S) FEHLGESCHLAGEN`));
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
