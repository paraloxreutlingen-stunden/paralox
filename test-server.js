/**
 * Paralox Stundenverwaltung - Lokaler Testserver (nur zum Entwickeln)
 * Bildet die Endpunkte von api.php in Node.js nach.
 *
 * Nutzung:  node test-server.js
 * Dann:     http://localhost:8080
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const EMP_FILE = path.join(DATA_DIR, 'employees.json');
const SHIFT_FILE = path.join(DATA_DIR, 'shifts.json');
const SET_FILE = path.join(DATA_DIR, 'settings.json');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.ico':  'image/x-icon',
};

// ---------- Storage ----------

function loadJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return null; }
}
function saveJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
function ensureInstalled() {
    return fs.existsSync(EMP_FILE) && fs.existsSync(SET_FILE);
}

// Einfache PBKDF2-Hashes (damit ohne native bcrypt auskommt)
function hashPin(pin) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(pin, salt, 100000, 32, 'sha256').toString('hex');
    return `pbkdf2$${salt}$${hash}`;
}
function verifyPin(pin, stored) {
    if (!stored || !stored.startsWith('pbkdf2$')) return false;
    const [, salt, hash] = stored.split('$');
    const check = crypto.pbkdf2Sync(pin, salt, 100000, 32, 'sha256').toString('hex');
    try { return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex')); }
    catch { return false; }
}

// ---------- Sessions (in-memory) ----------

const sessions = new Map(); // sid -> { uid }

function parseCookies(req) {
    const out = {};
    const raw = req.headers.cookie || '';
    raw.split(';').forEach(p => {
        const [k, ...v] = p.trim().split('=');
        if (k) out[k] = decodeURIComponent(v.join('='));
    });
    return out;
}
function getSession(req) {
    const sid = parseCookies(req).PARALOX_STUNDEN;
    if (sid && sessions.has(sid)) return { sid, data: sessions.get(sid) };
    return { sid: null, data: null };
}
function setSession(res, data) {
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, data);
    res.setHeader('Set-Cookie', `PARALOX_STUNDEN=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    return sid;
}
function clearSession(res, sid) {
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', `PARALOX_STUNDEN=deleted; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
}
function currentUser(req) {
    const { data } = getSession(req);
    if (!data || !data.uid) return null;
    const emps = loadJson(EMP_FILE) || [];
    return emps.find(e => e.id === data.uid && e.isActive) || null;
}

// ---------- Helpers ----------

function send(res, code, data) {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(JSON.stringify(data));
}
function ok(res, obj = {}) { send(res, 200, Object.assign({ ok: true }, obj)); }
function fail(res, msg, code = 400) { send(res, code, { ok: false, error: msg }); }

function readBody(req) {
    return new Promise((resolve) => {
        let buf = '';
        req.on('data', c => buf += c);
        req.on('end', () => {
            if (!buf) return resolve({});
            try { resolve(JSON.parse(buf)); } catch { resolve({}); }
        });
    });
}

function validDate(d) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const [y, m, da] = d.split('-').map(Number);
    const dt = new Date(y, m - 1, da);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === da;
}
function validTime(t) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(t); }
function nextId(items) { return (items.reduce((m, i) => Math.max(m, i.id || 0), 0) || 0) + 1; }

function toMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

function findOverlap(shifts, candidate, ignoreId = null) {
    let cS = toMin(candidate.startTime);
    let cE = toMin(candidate.endTime);
    if (cE <= cS) cE += 1440;
    return shifts.find(s => {
        if (ignoreId !== null && s.id === ignoreId) return false;
        if (s.employeeId !== candidate.employeeId) return false;
        if (s.date !== candidate.date) return false;
        let sS = toMin(s.startTime);
        let sE = toMin(s.endTime);
        if (sE <= sS) sE += 1440;
        return cS < sE && sS < cE;
    }) || null;
}

function isDuplicate(shifts, candidate, ignoreId = null) {
    return shifts.some(s => {
        if (ignoreId !== null && s.id === ignoreId) return false;
        return s.employeeId === candidate.employeeId
            && s.date === candidate.date
            && s.startTime === candidate.startTime
            && s.endTime === candidate.endTime
            && s.room === candidate.room
            && !!s.isDouble === !!candidate.isDouble
            && (s.secondRoom || null) === (candidate.secondRoom || null);
    });
}

function installIfMissing() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(EMP_FILE)) {
        // Default-Admin Eigentümer 1, PIN 1234 (bitte sofort ändern!)
        const emps = [{
            id: 1,
            name: 'Eigentümer 1',
            pinHash: hashPin('1234'),
            isAdmin: true,
            isActive: true,
            createdAt: new Date().toISOString(),
        }];
        saveJson(EMP_FILE, emps);
        console.log('>> Test-Admin angelegt: Name="Eigentümer 1", PIN="1234"');
    }
    if (!fs.existsSync(SHIFT_FILE)) saveJson(SHIFT_FILE, []);
    if (!fs.existsSync(SET_FILE)) {
        // Generische Testwerte — dieses Repo ist öffentlich, hier gehören
        // keine echten Raumnamen, Stundenlöhne oder Eigentümer-Anteile hin.
        saveJson(SET_FILE, {
            wageSingle: 0,
            wageDouble: 0,
            abgabenPercent: 31.17,
            rooms: {
                R1: { name: 'Raum 1', owner1: 50, owner2: 50 },
                R2: { name: 'Raum 2', owner1: 50, owner2: 50 },
            },
            doubleSplit: { main: 50, owner1: 25, owner2: 25 },
        });
    }
}

// ---------- API Handler ----------

async function handleApi(req, res, query) {
    const action = query.action || '';
    const method = req.method;

    if (action === 'session') {
        const u = currentUser(req);
        if (u) return ok(res, { user: {
            id: u.id, name: u.name,
            isAdmin: !!u.isAdmin,
            isAccountant: !!u.isAccountant,
        }});
        return ok(res, { user: null });
    }

    if (!ensureInstalled()) return fail(res, 'Nicht installiert.', 503);

    if (action === 'public-employees') {
        const list = (loadJson(EMP_FILE) || []).filter(e => e.isActive);
        const names = list.map(e => ({ id: e.id, name: e.name }))
            .sort((a, b) => a.name.localeCompare(b.name));
        return ok(res, { employees: names });
    }

    if (action === 'login') {
        const b = await readBody(req);
        const id = Number(b.id);
        const pin = String(b.pin || '');
        if (!id || !pin) return fail(res, 'Name und PIN erforderlich.');
        const emps = loadJson(EMP_FILE) || [];
        const e = emps.find(x => x.id === id && x.isActive);
        if (!e || !verifyPin(pin, e.pinHash)) {
            await new Promise(r => setTimeout(r, 400));
            return fail(res, 'Name oder PIN falsch.', 401);
        }
        setSession(res, { uid: e.id });
        return ok(res, { user: {
            id: e.id, name: e.name,
            isAdmin: !!e.isAdmin,
            isAccountant: !!e.isAccountant,
        }});
    }

    if (action === 'logout') {
        const { sid } = getSession(req);
        clearSession(res, sid);
        return ok(res);
    }

    const u = currentUser(req);
    if (!u) return fail(res, 'Nicht angemeldet.', 401);

    if (action === 'settings') return ok(res, { settings: loadJson(SET_FILE) });

    if (action === 'settings-update') {
        if (!u.isAdmin) return fail(res, 'Keine Berechtigung.', 403);
        const b = await readBody(req);
        const s = loadJson(SET_FILE);
        if (b.wageSingle != null) s.wageSingle = Math.max(0, Number(b.wageSingle));
        if (b.wageDouble != null) s.wageDouble = Math.max(0, Number(b.wageDouble));
        saveJson(SET_FILE, s);
        return ok(res, { settings: s });
    }

    if (action === 'change-pin') {
        const b = await readBody(req);
        if (!/^\d{4,10}$/.test(b.newPin || '')) return fail(res, 'Neue PIN muss 4-10 Ziffern haben.');
        if (!verifyPin(b.oldPin || '', u.pinHash)) return fail(res, 'Alte PIN falsch.');
        const emps = loadJson(EMP_FILE);
        const idx = emps.findIndex(e => e.id === u.id);
        emps[idx].pinHash = hashPin(b.newPin);
        saveJson(EMP_FILE, emps);
        return ok(res);
    }

    if (action === 'shifts') {
        let all = loadJson(SHIFT_FILE) || [];
        const mine = query.mine === '1' || query.mine === 1;
        const canSeeAll = u.isAdmin || u.isAccountant;
        if (mine || !canSeeAll) all = all.filter(s => s.employeeId === u.id);
        all.sort((a, b) => b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime));
        return ok(res, { shifts: all });
    }

    function validateShift(b) {
        const date = String(b.date || '');
        const start = String(b.startTime || '');
        const end = String(b.endTime || '');
        const room = String(b.room || '');
        const double = !!b.isDouble;
        let second = b.secondRoom != null ? String(b.secondRoom) : null;
        if (!validDate(date)) throw new Error('Ungültiges Datum.');
        if (!validTime(start) || !validTime(end)) throw new Error('Ungültige Uhrzeit.');
        if (start === end) throw new Error('Beginn und Ende dürfen nicht gleich sein.');
        const settings = loadJson(SET_FILE);
        if (!settings.rooms[room]) throw new Error('Unbekannter Raum.');
        if (double) {
            if (!second || !settings.rooms[second]) throw new Error('Zweiter Raum ungültig.');
            if (second === room) throw new Error('Zweiter Raum muss anders sein.');
        } else {
            second = null;
        }
        return { date, start, end, room, double, second };
    }

    if (action === 'shift-create') {
        if (u.isAccountant && !u.isAdmin) return fail(res, 'Buchhaltung kann keine Schichten erfassen.', 403);
        const b = await readBody(req);
        let v;
        try { v = validateShift(b); } catch (e) { return fail(res, e.message); }
        if (!u.isAdmin) {
            const t = new Date();
            const todayIso = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
            if (v.date !== todayIso) return fail(res, 'Schichten können nur für den heutigen Tag erfasst werden.', 403);
        }
        const shifts = loadJson(SHIFT_FILE) || [];
        let empId = u.id;
        if (u.isAdmin && b.employeeId) empId = Number(b.employeeId);
        const candidate = {
            employeeId: empId,
            date: v.date,
            startTime: v.start,
            endTime: v.end,
            room: v.room,
            secondRoom: v.second,
            isDouble: v.double,
        };
        const conflictA = findOverlap(shifts, candidate);
        if (conflictA) {
            return fail(res, `Zeit überschneidet sich mit bestehender Schicht (${conflictA.startTime}–${conflictA.endTime}, ${conflictA.room}).`, 409);
        }
        if (isDuplicate(shifts, candidate)) {
            return fail(res, 'Diese Schicht existiert bereits.', 409);
        }
        shifts.push(Object.assign({}, candidate, {
            id: nextId(shifts),
            note: String(b.note || '').trim(),
            createdAt: new Date().toISOString(),
        }));
        saveJson(SHIFT_FILE, shifts);
        return ok(res);
    }

    if (action === 'shift-update') {
        if (!u.isAdmin) return fail(res, 'Keine Berechtigung.', 403);
        const b = await readBody(req);
        const id = Number(b.id);
        if (!id) return fail(res, 'ID fehlt.');
        let v;
        try { v = validateShift(b); } catch (e) { return fail(res, e.message); }
        const shifts = loadJson(SHIFT_FILE) || [];
        const idx = shifts.findIndex(s => s.id === id);
        if (idx < 0) return fail(res, 'Eintrag nicht gefunden.', 404);
        const empId = b.employeeId != null ? Number(b.employeeId) : shifts[idx].employeeId;
        const candidate = {
            employeeId: empId,
            date: v.date,
            startTime: v.start,
            endTime: v.end,
            room: v.room,
            secondRoom: v.second,
            isDouble: v.double,
        };
        const conflictU = findOverlap(shifts, candidate, id);
        if (conflictU) {
            return fail(res, `Zeit überschneidet sich mit bestehender Schicht (${conflictU.startTime}–${conflictU.endTime}, ${conflictU.room}).`, 409);
        }
        if (isDuplicate(shifts, candidate, id)) {
            return fail(res, 'Diese Schicht existiert bereits.', 409);
        }
        shifts[idx] = Object.assign(shifts[idx], candidate);
        if (b.note != null) shifts[idx].note = String(b.note).trim();
        saveJson(SHIFT_FILE, shifts);
        return ok(res);
    }

    if (action === 'shift-delete') {
        const b = await readBody(req);
        const id = Number(b.id);
        if (!id) return fail(res, 'ID fehlt.');
        const shifts = loadJson(SHIFT_FILE) || [];
        const target = shifts.find(s => s.id === id);
        if (!target) return fail(res, 'Eintrag nicht gefunden.', 404);
        if (!u.isAdmin) {
            if (target.employeeId !== u.id) return fail(res, 'Keine Berechtigung.', 403);
            const today = new Date();
            const todayIso = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
            if (target.date !== todayIso) return fail(res, 'Eigene Schichten können nur am selben Tag gelöscht werden.', 403);
        }
        saveJson(SHIFT_FILE, shifts.filter(s => s.id !== id));
        return ok(res);
    }

    if (action === 'employees') {
        if (!u.isAdmin && !u.isAccountant) return fail(res, 'Keine Berechtigung.', 403);
        const list = (loadJson(EMP_FILE) || []).map(e => ({
            id: e.id, name: e.name,
            isAdmin: !!e.isAdmin,
            isAccountant: !!e.isAccountant,
            isActive: !!e.isActive,
            createdAt: e.createdAt || null,
        })).sort((a, b) => a.name.localeCompare(b.name));
        return ok(res, { employees: list });
    }

    if (action === 'employee-create') {
        if (!u.isAdmin) return fail(res, 'Keine Berechtigung.', 403);
        const b = await readBody(req);
        const name = String(b.name || '').trim();
        const pin = String(b.pin || '');
        if (!name) return fail(res, 'Name erforderlich.');
        if (!/^\d{4,10}$/.test(pin)) return fail(res, 'PIN muss 4-10 Ziffern haben.');
        const emps = loadJson(EMP_FILE) || [];
        if (emps.some(e => e.name.toLowerCase() === name.toLowerCase())) return fail(res, 'Name bereits vergeben.');
        emps.push({
            id: nextId(emps), name,
            pinHash: hashPin(pin),
            isAdmin: !!b.isAdmin,
            isAccountant: !!b.isAccountant,
            isActive: true,
            createdAt: new Date().toISOString(),
        });
        saveJson(EMP_FILE, emps);
        return ok(res);
    }

    if (action === 'employee-update') {
        if (!u.isAdmin) return fail(res, 'Keine Berechtigung.', 403);
        const b = await readBody(req);
        const id = Number(b.id);
        if (!id) return fail(res, 'ID fehlt.');
        const emps = loadJson(EMP_FILE) || [];
        const idx = emps.findIndex(e => e.id === id);
        if (idx < 0) return fail(res, 'Mitarbeiter nicht gefunden.', 404);
        const e = emps[idx];
        if (b.name != null) { const n = String(b.name).trim(); if (n) e.name = n; }
        if (b.pin != null && b.pin !== '') {
            if (!/^\d{4,10}$/.test(String(b.pin))) return fail(res, 'PIN muss 4-10 Ziffern haben.');
            e.pinHash = hashPin(String(b.pin));
        }
        if (b.isAdmin != null) {
            if (!b.isAdmin && e.isAdmin) {
                const others = emps.filter(x => x.id !== id && x.isAdmin && x.isActive);
                if (!others.length) return fail(res, 'Mindestens ein aktiver Admin erforderlich.');
            }
            e.isAdmin = !!b.isAdmin;
        }
        if (b.isAccountant != null) {
            e.isAccountant = !!b.isAccountant;
        }
        if (b.isActive != null) {
            if (!b.isActive && e.isAdmin) {
                const others = emps.filter(x => x.id !== id && x.isAdmin && x.isActive);
                if (!others.length) return fail(res, 'Mindestens ein aktiver Admin erforderlich.');
            }
            e.isActive = !!b.isActive;
        }
        saveJson(EMP_FILE, emps);
        return ok(res);
    }

    return fail(res, 'Unbekannte Aktion.', 404);
}

// ---------- Static Files ----------

function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    // keine Directory-Traversal, keine data/-Auslieferung
    if (rel.includes('..') || rel.startsWith('/data/')) { res.statusCode = 403; return res.end('Forbidden'); }
    const file = path.join(ROOT, rel);
    fs.readFile(file, (err, buf) => {
        if (err) { res.statusCode = 404; return res.end('Not found'); }
        const ext = path.extname(file).toLowerCase();
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        res.end(buf);
    });
}

// ---------- Main ----------

installIfMissing();

const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';

    try {
        if (pathname === '/api.php') {
            return await handleApi(req, res, parsed.query);
        }
        if (pathname === '/install.php') {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.end('<h1>Installer deaktiviert</h1><p>Im Testserver bereits automatisch eingerichtet. Login: <b>Eigentümer 1</b> / PIN <b>1234</b></p><p><a href="/">Zur App</a></p>');
        }
        serveStatic(req, res, pathname);
    } catch (e) {
        console.error(e);
        res.statusCode = 500;
        res.end('Server error');
    }
});

server.listen(PORT, () => {
    console.log('==========================================');
    console.log(' Paralox Stunden - Testserver laeuft');
    console.log(' URL:    http://localhost:' + PORT);
    console.log(' Login:  Eigentümer 1  /  PIN: 1234');
    console.log(' Stop:   Strg+C');
    console.log('==========================================');
});
