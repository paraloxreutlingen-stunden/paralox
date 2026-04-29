/* Paralox Stundenverwaltung - Frontend (localStorage + Google Drive) */
(() => {
    'use strict';

    const ABGABEN_PCT = 31.17; // fester Satz, nicht änderbar
    const LIMIT_YEAR       = 7236;
    const LIMIT_YEAR_WARN  = 5736;
    const LIMIT_MONTH      = 603;
    const LIMIT_MONTH_WARN = 550;
    const IDLE_TIMEOUT_MS  = 8 * 60 * 1000; // 8 Minuten Auto-Logout
    const MAX_END_MIN_NONADMIN = 24 * 60 + 30; // 00:30 am Folgetag (Schichtende darf nicht später liegen)
    const MONTH_NAMES = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

    const state = {
        user: null,
        data: null, // Ganze DB aus localStorage
        activeTab: null, // wird beim ersten buildTabs() rollenabhängig gesetzt
    };

    // ---------- Utilities ----------

    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const fmtEUR = n => (Math.round(n * 100) / 100).toFixed(2).replace('.', ',') + ' EUR';
    const pad = n => String(n).padStart(2, '0');

    function fmtDateDE(iso) {
        if (!iso) return '';
        const [y, m, d] = iso.split('-');
        return `${d}.${m}.${y}`;
    }
    function fmtDateTimeDE(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    function fmtHours(minutes) {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return `${h}:${pad(m)}`;
    }
    function minutesOf(start, end) {
        const [sh, sm] = start.split(':').map(Number);
        const [eh, em] = end.split(':').map(Number);
        let s = sh * 60 + sm;
        let e = eh * 60 + em;
        if (e <= s) e += 24 * 60;
        return e - s;
    }
    function todayISO() {
        const d = new Date();
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    function validTime(t) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(t); }
    function validDate(d) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
        const [y, m, da] = d.split('-').map(Number);
        const dt = new Date(y, m - 1, da);
        return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === da;
    }

    function toast(msg, type = 'info') {
        const wrap = $('#toasts');
        const t = document.createElement('div');
        t.className = `toast ${type}`;
        t.textContent = msg;
        wrap.appendChild(t);
        setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2800);
        setTimeout(() => t.remove(), 3200);
    }

    function confirmModal(title, bodyHtml) {
        return new Promise(resolve => {
            const modal = $('#modal');
            $('#modalTitle').textContent = title;
            $('#modalBody').innerHTML = bodyHtml;
            modal.classList.remove('hidden');
            const ok = $('#modalOk');
            const cancel = $('#modalCancel');
            const done = (v) => {
                modal.classList.add('hidden');
                ok.onclick = null;
                cancel.onclick = null;
                resolve(v);
            };
            ok.onclick = () => done(true);
            cancel.onclick = () => done(false);
        });
    }

    // Modal mit Jahr+Monat-Dropdowns; gibt "YYYY-MM" zurück oder null bei Abbruch
    function promptMonthModal(title, defaultYear, defaultMonth) {
        return new Promise(resolve => {
            const modal = $('#modal');
            $('#modalTitle').textContent = title;
            const cur = new Date().getFullYear();
            const yearSet = new Set([cur, cur - 1, cur + 1]);
            shifts().forEach(s => { const y = Number(s.date.slice(0, 4)); if (y) yearSet.add(y); });
            const years = [...yearSet].sort((a, b) => b - a);
            const yearOpts = years.map(y =>
                `<option value="${y}" ${String(y) === String(defaultYear) ? 'selected' : ''}>${y}</option>`).join('');
            const monthOpts = MONTH_NAMES.map((n, i) => {
                const v = pad(i + 1);
                return `<option value="${v}" ${v === defaultMonth ? 'selected' : ''}>${n}</option>`;
            }).join('');
            $('#modalBody').innerHTML = `
                <label>Jahr<select id="mpYear" autocomplete="off">${yearOpts}</select></label>
                <label>Monat<select id="mpMonth" autocomplete="off">${monthOpts}</select></label>
            `;
            modal.classList.remove('hidden');
            const ok = $('#modalOk');
            const cancel = $('#modalCancel');
            const done = (v) => {
                modal.classList.add('hidden');
                ok.onclick = null;
                cancel.onclick = null;
                resolve(v);
            };
            ok.onclick = () => {
                const y = $('#mpYear').value;
                const m = $('#mpMonth').value;
                if (!y || !m) return done(null);
                done(`${y}-${m}`);
            };
            cancel.onclick = () => done(null);
        });
    }

    function promptModal(title, fields) {
        return new Promise(resolve => {
            const modal = $('#modal');
            $('#modalTitle').textContent = title;
            const html = fields.map((f, i) =>
                `<label>${f.label}<input type="${f.type || 'text'}" id="pm_${i}" value="${f.value ?? ''}" ${f.attr || ''}></label>`
            ).join('');
            $('#modalBody').innerHTML = html;
            modal.classList.remove('hidden');
            setTimeout(() => $('#pm_0')?.focus(), 50);
            const ok = $('#modalOk');
            const cancel = $('#modalCancel');
            const done = (v) => {
                modal.classList.add('hidden');
                ok.onclick = null;
                cancel.onclick = null;
                resolve(v);
            };
            ok.onclick = () => {
                const result = {};
                fields.forEach((f, i) => { result[f.key] = $(`#pm_${i}`).value; });
                done(result);
            };
            cancel.onclick = () => done(null);
        });
    }

    // ---------- Passwort-Regeln ----------

    // Erzwingt: min. 8 Zeichen, mind. 1 Buchstabe, 1 Ziffer, 1 Sonderzeichen
    function validatePasswordRules(pw) {
        if (typeof pw !== 'string') return 'Ungültiges Passwort.';
        if (pw.length < 8) return 'Passwort muss mindestens 8 Zeichen haben.';
        if (!/[A-Za-zÄÖÜäöüß]/.test(pw)) return 'Passwort muss mindestens einen Buchstaben enthalten.';
        if (!/[0-9]/.test(pw))            return 'Passwort muss mindestens eine Ziffer enthalten.';
        if (!/[^A-Za-z0-9ÄÖÜäöüß]/.test(pw)) return 'Passwort muss mindestens ein Sonderzeichen enthalten (z.B. ! ? @ # % & * + -).';
        return null;
    }

    // ---------- Passwort-Hashing (bcrypt) ----------

    function bcryptLib() {
        return window.bcrypt || (window.dcodeIO && window.dcodeIO.bcrypt) || null;
    }
    function isBcryptHash(s) {
        return typeof s === 'string' && /^\$2[abxy]\$\d{2}\$/.test(s);
    }
    function hashPassword(plain) {
        const lib = bcryptLib();
        if (!lib) throw new Error('bcrypt-Library noch nicht geladen.');
        return lib.hashSync(String(plain), 10);
    }
    // Wartet bis bcryptjs geladen ist (max. 6 Sekunden)
    async function ensureBcryptLoaded(maxMs = 6000) {
        if (bcryptLib()) return true;
        const start = Date.now();
        while (Date.now() - start < maxMs) {
            await new Promise(r => setTimeout(r, 80));
            if (bcryptLib()) return true;
        }
        return false;
    }

    // Batch-Migration: alle Klartext-Passwörter im Datensatz auf bcrypt umstellen
    function migratePlaintextPasswords() {
        if (!bcryptLib()) {
            console.warn('[Paralox] bcrypt nicht verfügbar — Migration übersprungen');
            return false;
        }
        if (!state.data || !Array.isArray(state.data.employees)) return false;
        let changed = 0;
        state.data.employees.forEach(e => {
            if (e.password && !isBcryptHash(e.password)) {
                try {
                    e.password = hashPassword(e.password);
                    changed++;
                } catch (err) {
                    console.warn('[Paralox] Hash für Mitarbeiter', e.name, 'fehlgeschlagen', err);
                }
            }
        });
        if (changed > 0) {
            saveData();
            console.log(`[Paralox] ${changed} Klartext-Passwort/Passwörter wurden auf bcrypt umgestellt.`);
        } else {
            console.log('[Paralox] Alle Passwörter sind bereits gehasht.');
        }
        return changed > 0;
    }

    function verifyPassword(plain, stored) {
        if (typeof stored !== 'string' || !stored) return false;
        if (isBcryptHash(stored)) {
            const lib = bcryptLib();
            if (!lib) return false;
            try { return lib.compareSync(String(plain), stored); }
            catch { return false; }
        }
        // Legacy: Klartext-Vergleich (wird beim ersten erfolgreichen Login aufgewertet)
        return String(plain) === String(stored);
    }

    // ---------- Storage-Zugriff ----------

    function loadData() {
        state.data = window.ParaloxStorage.load();
        return state.data;
    }
    function saveData() {
        window.ParaloxStorage.save(state.data);
    }
    function settings() { return state.data.settings; }
    function employees() { return state.data.employees; }
    function shifts()    { return state.data.shifts; }

    // Vollständiger Reload nach Drive-Sync von außen
    window.addEventListener('paralox:external-update', async () => {
        loadData();
        // Bei Daten aus Drive ggf. wieder Klartext drin → erneut migrieren und sofort hochladen
        await ensureBcryptLoaded();
        const migrated = migratePlaintextPasswords();
        if (migrated && window.ParaloxDrive && typeof window.ParaloxDrive.pushNow === 'function') {
            try {
                await window.ParaloxDrive.pushNow();
                console.log('[Paralox] Migrierte Daten (nach Drive-Pull) wurden in Drive hochgeladen.');
            } catch (e) {
                console.warn('[Paralox] Drive-Push nach Migration fehlgeschlagen', e);
            }
        }
        if (state.user) {
            // Prüfen ob eingeloggter User noch existiert und aktiv ist
            const u = employees().find(e => e.id === state.user.id);
            if (!u || !u.isActive) { doLogout(); return; }
            state.user = publicUser(u);
            if (state.activeTab === 'mine') renderMine();
            if (state.activeTab === 'shifts') renderAdminShifts();
            if (state.activeTab === 'employees') renderEmployees();
            if (state.activeTab === 'settings') renderSettings();
            if (state.activeTab === 'pinboard') renderPinboard();
        } else {
            initLogin();
        }
    });

    function publicUser(e) {
        return {
            id: e.id, name: e.name,
            isAdmin: !!e.isAdmin,
            isAccountant: !!e.isAccountant,
            assignedTo: e.assignedTo || 'owner1',
        };
    }

    // ---------- Berechnung ----------

    function wageFor(shift) {
        const s = settings();
        const rate = shift.isDouble ? s.wageDouble : s.wageSingle;
        const mins = minutesOf(shift.startTime, shift.endTime);
        return { minutes: mins, rate, amount: (mins / 60) * rate };
    }

    function splitCost(shift) {
        const { amount } = wageFor(shift);
        const rooms = settings().rooms || {};
        const fallback = { owner1: 50, owner2: 50 };
        const r1 = rooms[shift.room] || fallback;
        const factor = ABGABEN_PCT / 100;

        let baseOwner1, baseOwner2;
        if (!shift.isDouble) {
            baseOwner1   = amount * (r1.owner1   / 100);
            baseOwner2 = amount * (r1.owner2 / 100);
        } else {
            const r2code = shift.secondRoom || 'WS';
            const r2 = rooms[r2code] || fallback;
            baseOwner1   = amount * 0.5 * (r1.owner1   / 100) + amount * 0.5 * (r2.owner1   / 100);
            baseOwner2 = amount * 0.5 * (r1.owner2 / 100) + amount * 0.5 * (r2.owner2 / 100);
        }
        const sAbg = baseOwner1   * factor;
        const bAbg = baseOwner2 * factor;
        return {
            total: amount,
            abgabenPct: ABGABEN_PCT,
            owner1:   baseOwner1,
            owner2: baseOwner2,
            owner1Base:   baseOwner1,
            owner2Base: baseOwner2,
            owner1Abgaben:   sAbg,
            owner2Abgaben: bAbg,
            owner1Total:   baseOwner1   + sAbg,
            owner2Total: baseOwner2 + bAbg,
        };
    }

    function secondRoomOf(shift) {
        if (!shift.isDouble) return null;
        return shift.secondRoom || 'WS';
    }

    function roomsLabel(shift) {
        const primary = `<span class="badge">${shift.room}</span>`;
        if (!shift.isDouble) return primary;
        return `${primary} <span class="muted">+</span> <span class="badge">${secondRoomOf(shift)}</span>`;
    }

    // ---------- Auth ----------

    function doLogin(employeeId, password) {
        const emp = employees().find(e => e.id === +employeeId && e.isActive);
        if (!emp) return { ok: false, error: 'Name oder Passwort falsch.' };
        if (!verifyPassword(password, emp.password)) {
            return { ok: false, error: 'Name oder Passwort falsch.' };
        }
        // Migration: Klartext-Passwort beim ersten erfolgreichen Login aufwerten
        if (!isBcryptHash(emp.password)) {
            try {
                emp.password = hashPassword(password);
                saveData();
            } catch (e) {
                console.warn('Passwort-Hash konnte nicht erzeugt werden', e);
            }
        }
        window.ParaloxStorage.setSession(emp.id);
        state.user = publicUser(emp);
        return { ok: true };
    }

    function doLogout() {
        window.ParaloxStorage.clearSession();
        state.user = null;
        stopIdleTimer();
        location.reload();
    }

    function restoreSession() {
        const s = window.ParaloxStorage.getSession();
        if (!s) return false;
        const emp = employees().find(e => e.id === +s.uid && e.isActive);
        if (!emp) return false;
        state.user = publicUser(emp);
        return true;
    }

    // ---------- Auto-Logout ----------

    let idleTimer = null;
    function resetIdleTimer() {
        if (!state.user) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            toast('Automatisch abgemeldet nach 8 Minuten Inaktivität.', 'info');
            setTimeout(doLogout, 400);
        }, IDLE_TIMEOUT_MS);
    }
    function stopIdleTimer() {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    }
    function startIdleTimer() {
        resetIdleTimer();
        ['mousemove','keydown','touchstart','click','scroll','focus'].forEach(ev => {
            window.addEventListener(ev, resetIdleTimer, { passive: true });
        });
    }

    // ---------- Rendering: Tabs ----------

    function tab(name, label) {
        const b = document.createElement('button');
        b.textContent = label;
        b.dataset.tab = name;
        b.onclick = () => switchTab(name);
        return b;
    }

    function isAdmin()    { return !!state.user?.isAdmin; }
    function isViewer()   { return isAdmin() || !!state.user?.isAccountant; }

    function buildTabs() {
        const nav = $('#tabs');
        nav.innerHTML = '';
        // Eigene Schichten eintragen darf jeder eingeloggte User — Buchhaltungs-
        // Mitarbeiter arbeiten oft selbst mit und brauchen den Tab ebenfalls.
        nav.appendChild(tab('enter', 'Neue Schicht'));
        nav.appendChild(tab('mine',  'Meine Stunden'));
        if (isViewer()) {
            nav.appendChild(tab('shifts',    'Alle Schichten'));
            nav.appendChild(tab('employees', 'Mitarbeiter'));
            nav.appendChild(tab('settings',  'Einstellungen'));
        }
        if (isAdmin()) {
            nav.appendChild(tab('pinboard', 'Pinnwand'));
        }
        // Buchhalter (Viewer ohne Admin) landen weiterhin auf "Alle Schichten" —
        // ihr Hauptzweck ist die Auswertung; "Neue Schicht" ist nur Zusatz.
        const def = (!isViewer() || isAdmin()) ? 'enter' : 'shifts';
        const available = $$('.tabs button').some(b => b.dataset.tab === state.activeTab);
        switchTab(state.activeTab && available ? state.activeTab : def);
    }

    function switchTab(name) {
        state.activeTab = name;
        $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
        ['enter','mine','shifts','employees','settings','pinboard'].forEach(v => {
            $(`#view-${v}`).classList.toggle('hidden', v !== name);
        });
        if (name === 'mine')      renderMine();
        if (name === 'shifts')    renderAdminShifts();
        if (name === 'employees') renderEmployees();
        if (name === 'settings')  renderSettings();
        if (name === 'pinboard')  renderPinboard();
    }

    // ---------- Schicht-Formular ----------

    function fillRoomSelect(sel, exclude, withPlaceholder) {
        const rooms = settings().rooms || {};
        const prev = sel.value;
        sel.innerHTML = '';
        if (withPlaceholder) {
            const ph = document.createElement('option');
            ph.value = '';
            ph.textContent = '-- bitte wählen --';
            sel.appendChild(ph);
        }
        Object.keys(rooms).forEach(code => {
            if (exclude && code === exclude) return;
            const opt = document.createElement('option');
            opt.value = code;
            opt.textContent = `${code} - ${rooms[code].name}`;
            sel.appendChild(opt);
        });
        if (prev !== null && Array.from(sel.options).some(o => o.value === prev)) sel.value = prev;
        else if (withPlaceholder) sel.value = '';
    }

    function refreshShiftRoomSelects() {
        const isD = $('#sfDouble').checked;
        $('#sfRoom2Wrap').classList.toggle('hidden', !isD);
        // Beide Felder starten leer, bis der Nutzer wählt
        fillRoomSelect($('#sfRoom'),  isD ? $('#sfRoom2').value : null, true);
        if (isD) fillRoomSelect($('#sfRoom2'), $('#sfRoom').value, true);
        // Kollision nur dann auflösen, wenn BEIDE nicht-leer sind und gleich
        const v1 = $('#sfRoom').value;
        const v2 = $('#sfRoom2').value;
        if (isD && v1 && v2 && v1 === v2) {
            const other = Array.from($('#sfRoom2').options).find(o => o.value && o.value !== v1);
            if (other) $('#sfRoom2').value = other.value;
            fillRoomSelect($('#sfRoom'), $('#sfRoom2').value, true);
        }
    }

    function renderPreview() {
        const start = $('#sfStart').value;
        const end = $('#sfEnd').value;
        const isD = $('#sfDouble').checked;
        if (!start || !end) { $('#sfPreview').textContent = ''; return; }
        const mins = minutesOf(start, end);
        const rate = isD ? settings().wageDouble : settings().wageSingle;
        const amount = (mins / 60) * rate;
        $('#sfPreview').textContent = `${fmtHours(mins)} Std · ${fmtEUR(rate)} /h · ${fmtEUR(amount)}`;
    }

    function toMin(t) {
        const [h, m] = t.split(':').map(Number);
        return h * 60 + m;
    }
    function findOverlap(list, cand, ignoreId) {
        let cS = toMin(cand.startTime);
        let cE = toMin(cand.endTime);
        if (cE <= cS) cE += 1440;
        for (const s of list) {
            if (ignoreId != null && s.id === ignoreId) continue;
            if (s.employeeId !== cand.employeeId) continue;
            if (s.date !== cand.date) continue;
            let sS = toMin(s.startTime), sE = toMin(s.endTime);
            if (sE <= sS) sE += 1440;
            if (cS < sE && sS < cE) return s;
        }
        return null;
    }

    function isDuplicate(list, cand, ignoreId) {
        return list.some(s => {
            if (ignoreId != null && s.id === ignoreId) return false;
            return s.employeeId === cand.employeeId
                && s.date === cand.date
                && s.startTime === cand.startTime
                && s.endTime === cand.endTime
                && s.room === cand.room
                && !!s.isDouble === !!cand.isDouble
                && (s.secondRoom || null) === (cand.secondRoom || null);
        });
    }

    function validateShiftPayload(p) {
        if (!validDate(p.date))  return 'Ungültiges Datum.';
        if (!validTime(p.startTime) || !validTime(p.endTime)) return 'Ungültige Uhrzeit.';
        if (p.startTime === p.endTime) return 'Beginn und Ende dürfen nicht gleich sein.';
        const rooms = settings().rooms || {};
        if (!rooms[p.room]) return 'Bitte einen Raum wählen.';
        if (p.isDouble) {
            if (!p.secondRoom || !rooms[p.secondRoom]) return 'Zweiter Raum ungültig.';
            if (p.secondRoom === p.room) return 'Zweiter Raum muss anders sein.';
        }
        return null;
    }

    // Zusätzliche Regeln, die nur für Nicht-Admins gelten
    function validateNonAdminConstraints(p) {
        const today = todayISO();
        if (p.date < today) {
            return 'Schichten in der Vergangenheit können nur vom Admin erfasst werden.';
        }
        if (p.date > today) {
            return 'Schichten in der Zukunft können nur vom Admin erfasst werden.';
        }
        let sMin = toMin(p.startTime);
        let eMin = toMin(p.endTime);
        if (eMin <= sMin) eMin += 1440;
        if (eMin > MAX_END_MIN_NONADMIN) {
            return 'Schichten dürfen nicht später als 00:30 enden. Ausnahmen nur durch Admin.';
        }
        return null;
    }

    // ---------- Login-View ----------

    function initLogin() {
        $('#view-login').classList.remove('hidden');
        $('#topbar').classList.add('hidden');
        const sel = $('#loginName');
        const hint = $('#loginEmptyHint');
        const active = employees().filter(e => e.isActive)
            .sort((a, b) => a.name.localeCompare(b.name, 'de'));
        sel.innerHTML = '';
        if (!active.length) {
            sel.innerHTML = '<option value="">— keine Mitarbeiter —</option>';
            sel.disabled = true;
            if (hint) hint.classList.remove('hidden');
        } else {
            sel.disabled = false;
            if (hint) hint.classList.add('hidden');
            active.forEach(e => {
                const o = document.createElement('option');
                o.value = e.id;
                o.textContent = e.name;
                sel.appendChild(o);
            });
        }
        renderLoginPinboard();
    }

    function renderLoginPinboard() {
        const pb = state.data.pinboard;
        const box = $('#loginPinboard');
        if (!pb || !pb.text || !pb.text.trim()) {
            box.classList.add('hidden');
            box.innerHTML = '';
            return;
        }
        box.classList.remove('hidden');
        box.innerHTML = `
            <div class="pin-head">📌 Mitteilung</div>
            <div class="pin-text">${escapeHtml(pb.text)}</div>
        `;
    }

    $('#loginForm').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const err = $('#loginError');
        err.classList.add('hidden');
        const r = doLogin($('#loginName').value, $('#loginPassword').value);
        if (!r.ok) {
            err.textContent = r.error;
            err.classList.remove('hidden');
            return;
        }
        $('#loginPassword').value = '';
        enterApp();
    });

    // ---------- Enter App ----------

    function enterApp() {
        $('#view-login').classList.add('hidden');
        $('#topbar').classList.remove('hidden');
        const role = state.user.isAdmin ? ' (Admin)' : (state.user.isAccountant ? ' (Buchhaltung)' : '');
        $('#userName').textContent = state.user.name + role;

        const today = todayISO();
        const dateInput = $('#sfDate');
        dateInput.value = today;
        if (!isAdmin()) {
            dateInput.min = today;
            dateInput.max = today;
            dateInput.title = 'Nur für den heutigen Tag erfassbar';
        } else {
            dateInput.removeAttribute('min');
            dateInput.removeAttribute('max');
            dateInput.title = '';
        }
        fillRoomSelect($('#sfRoom'),  null, true);
        fillRoomSelect($('#sfRoom2'), null, true);
        refreshShiftRoomSelects();
        // Browser-Autocomplete / Form-Restore unterbinden
        $('#sfRoom').value  = '';
        $('#sfRoom2').value = '';
        renderPreview();
        buildTabs();
        startIdleTimer();
    }

    $('#btnLogout').addEventListener('click', doLogout);

    // ---------- Shift Form ----------

    ['sfStart','sfEnd','sfDouble'].forEach(id => {
        $('#' + id).addEventListener('change', renderPreview);
        $('#' + id).addEventListener('input', renderPreview);
    });
    $('#sfDouble').addEventListener('change', () => { refreshShiftRoomSelects(); renderPreview(); });
    $('#sfRoom').addEventListener('change',  () => { if ($('#sfDouble').checked) refreshShiftRoomSelects(); });
    $('#sfRoom2').addEventListener('change', () => { refreshShiftRoomSelects(); });

    $('#shiftForm').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const btn = ev.submitter || $('#shiftForm button[type="submit"]');
        if (btn && btn.disabled) return;
        const isD = $('#sfDouble').checked;
        const payload = {
            employeeId: state.user.id,
            date: $('#sfDate').value,
            startTime: $('#sfStart').value,
            endTime: $('#sfEnd').value,
            room: $('#sfRoom').value,
            isDouble: isD,
            secondRoom: isD ? $('#sfRoom2').value : null,
            note: $('#sfNote').value,
        };
        const err = validateShiftPayload(payload);
        if (err) { toast(err, 'error'); return; }
        if (!isAdmin()) {
            const ne = validateNonAdminConstraints(payload);
            if (ne) { toast(ne, 'error'); return; }
        }
        const overlap = findOverlap(shifts(), payload);
        if (overlap) {
            toast(`Zeit überschneidet sich mit bestehender Schicht (${overlap.startTime}–${overlap.endTime}, ${overlap.room}).`, 'error');
            return;
        }
        if (isDuplicate(shifts(), payload)) {
            toast('Diese Schicht existiert bereits.', 'error');
            return;
        }
        state.data.shifts.push({
            id: window.ParaloxStorage.nextId(shifts()),
            employeeId: payload.employeeId,
            date: payload.date,
            startTime: payload.startTime,
            endTime: payload.endTime,
            room: payload.room,
            secondRoom: payload.secondRoom,
            isDouble: payload.isDouble,
            note: (payload.note || '').trim(),
            createdAt: new Date().toISOString(),
        });
        saveData();
        toast('Schicht gespeichert', 'success');
        $('#sfDate').value = todayISO();
        $('#sfStart').value = '';
        $('#sfEnd').value = '';
        $('#sfNote').value = '';
        $('#sfDouble').checked = false;
        refreshShiftRoomSelects();
        // Beide Raum-Felder leeren, bis der Nutzer wieder wählt
        $('#sfRoom').value  = '';
        $('#sfRoom2').value = '';
        renderPreview();
        if (state.activeTab === 'mine') renderMine();
    });

    // ---------- Meine Stunden ----------

    function filterByMonth(list, monthStr) {
        if (!monthStr) return list;
        return list.filter(s => s.date.startsWith(monthStr));
    }

    // Kombiniert Jahr + Monat zu "YYYY-MM". Leer = keine Einschränkung.
    // Ein Jahr allein filtert auf dieses Jahr, ein Monat allein auf jedes Jahr.
    function readPeriodValue(yearSel, monthSel) {
        const y = $(yearSel).value;
        const m = $(monthSel).value;
        if (y && m) return `${y}-${m}`;
        return '';
    }
    function readPeriodYear(yearSel)   { return $(yearSel).value; }
    function readPeriodMonth(monthSel) { return $(monthSel).value; }

    function filterByPeriod(list, yearSel, monthSel) {
        const y = readPeriodYear(yearSel);
        const m = readPeriodMonth(monthSel);
        if (!y && !m) return list;
        return list.filter(s => {
            const [sy, sm] = s.date.split('-');
            if (y && sy !== y) return false;
            if (m && sm !== m) return false;
            return true;
        });
    }

    function fillYearMonthSelects(yearSelId, monthSelId) {
        const ySel = $(yearSelId);
        const mSel = $(monthSelId);
        const prevY = ySel.value;
        const prevM = mSel.value;

        // Jahre aus vorhandenen Schichten plus aktuelles Jahr
        const yearSet = new Set();
        const cur = new Date().getFullYear();
        yearSet.add(cur);
        yearSet.add(cur - 1);
        shifts().forEach(s => { const y = s.date.slice(0, 4); if (y) yearSet.add(Number(y)); });
        const years = [...yearSet].sort((a, b) => b - a);

        ySel.innerHTML = '<option value="">Alle Jahre</option>';
        years.forEach(y => {
            const o = document.createElement('option');
            o.value = String(y);
            o.textContent = String(y);
            ySel.appendChild(o);
        });
        if (prevY && years.includes(Number(prevY))) ySel.value = prevY;

        mSel.innerHTML = '<option value="">Alle Monate</option>';
        MONTH_NAMES.forEach((name, i) => {
            const o = document.createElement('option');
            o.value = pad(i + 1);
            o.textContent = name;
            mSel.appendChild(o);
        });
        if (prevM) mSel.value = prevM;
    }

    function mineShifts() {
        return shifts()
            .filter(s => s.employeeId === state.user.id)
            .sort((a, b) => b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime));
    }

    function renderLimits() {
        const list = mineShifts();
        const now = new Date();
        const year = now.getFullYear();
        const monthKey = `${year}-${pad(now.getMonth() + 1)}`;
        let yearAmt = 0, monthAmt = 0;
        list.forEach(s => {
            const a = wageFor(s).amount;
            if (s.date.startsWith(String(year) + '-')) yearAmt += a;
            if (s.date.startsWith(monthKey)) monthAmt += a;
        });

        const yStatus = yearAmt  > LIMIT_YEAR  ? 'danger' : (yearAmt  >= LIMIT_YEAR_WARN  ? 'warn' : 'ok');
        const mStatus = monthAmt > LIMIT_MONTH ? 'danger' : (monthAmt >= LIMIT_MONTH_WARN ? 'warn' : 'ok');
        const yPct = Math.min(100, (yearAmt  / LIMIT_YEAR)  * 100);
        const mPct = Math.min(100, (monthAmt / LIMIT_MONTH) * 100);
        const yRemain = LIMIT_YEAR  - yearAmt;
        const mRemain = LIMIT_MONTH - monthAmt;

        const yMsg = yStatus === 'danger'
            ? `⚠ Jahresgrenze von ${fmtEUR(LIMIT_YEAR)} überschritten um ${fmtEUR(-yRemain)}.`
            : yStatus === 'warn'
                ? `⚠ Nur noch ${fmtEUR(yRemain)} bis zur Jahresgrenze von ${fmtEUR(LIMIT_YEAR)}.`
                : `Noch ${fmtEUR(yRemain)} bis zur Jahresgrenze.`;
        const mMsg = mStatus === 'danger'
            ? `⚠ Monatsgrenze von ${fmtEUR(LIMIT_MONTH)} überschritten um ${fmtEUR(-mRemain)}.`
            : mStatus === 'warn'
                ? `⚠ Monatsgrenze rückt näher (${fmtEUR(LIMIT_MONTH_WARN)}+). Noch ${fmtEUR(mRemain)} bis ${fmtEUR(LIMIT_MONTH)}.`
                : `Monatsgrenze: ${fmtEUR(LIMIT_MONTH)} · noch ${fmtEUR(mRemain)}`;

        $('#mineLimits').innerHTML = `
            <div class="limit-card ${yStatus}">
                <div class="limit-header">
                    <span class="limit-label">Jahresverdienst ${year}</span>
                    <span class="limit-value">${fmtEUR(yearAmt)}</span>
                </div>
                <div class="limit-bar"><div class="limit-fill" style="width:${yPct.toFixed(1)}%"></div></div>
                <div class="limit-info">von ${fmtEUR(LIMIT_YEAR)}</div>
                <div class="limit-warn-msg">${yMsg}</div>
            </div>
            <div class="limit-card ${mStatus}">
                <div class="limit-header">
                    <span class="limit-label">${MONTH_NAMES[now.getMonth()]} ${year}</span>
                    <span class="limit-value">${fmtEUR(monthAmt)}</span>
                </div>
                <div class="limit-bar"><div class="limit-fill" style="width:${mPct.toFixed(1)}%"></div></div>
                <div class="limit-info">von ${fmtEUR(LIMIT_MONTH)}</div>
                <div class="limit-warn-msg">${mMsg}</div>
            </div>
        `;
    }

    function renderMine() {
        fillYearMonthSelects('#mineYear', '#mineMonth');
        renderLimits();
        const tbody = $('#mineTable tbody');
        const list = filterByPeriod(mineShifts(), '#mineYear', '#mineMonth');
        const today = todayISO();
        tbody.innerHTML = '';
        let totalMin = 0, totalAmt = 0;
        list.forEach(s => {
            const w = wageFor(s);
            totalMin += w.minutes;
            totalAmt += w.amount;
            const canDelete = s.date === today;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${fmtDateDE(s.date)}</td>
                <td>${s.startTime}</td>
                <td>${s.endTime}</td>
                <td class="num">${fmtHours(w.minutes)}</td>
                <td>${roomsLabel(s)}</td>
                <td>${s.isDouble ? '<span class="badge double">Doppel</span>' : '<span class="badge muted">Einfach</span>'}</td>
                <td class="num">${fmtEUR(w.amount)}</td>
                <td>${escapeHtml(s.note || '')}</td>
                <td>${canDelete
                    ? `<button class="btn small danger" data-del="${s.id}">Löschen</button>`
                    : `<span class="muted small" title="Nur am selben Tag möglich">–</span>`}</td>
            `;
            tbody.appendChild(tr);
        });
        if (!list.length) {
            tbody.innerHTML = `<tr><td colspan="9" class="muted" style="text-align:center;padding:2rem">Keine Einträge in diesem Zeitraum</td></tr>`;
        }
        $('#mineSummary').innerHTML = summaryHtml(list.length, totalMin, totalAmt);
        tbody.querySelectorAll('[data-del]').forEach(b => {
            b.onclick = async () => {
                if (!await confirmModal('Löschen?', `<p>Schicht wirklich löschen?</p>`)) return;
                const id = Number(b.dataset.del);
                state.data.shifts = shifts().filter(s => s.id !== id);
                saveData();
                renderMine();
                toast('Gelöscht', 'success');
            };
        });
    }

    function summaryHtml(count, minutes, amount) {
        return `
            <div class="stat"><div class="label">Einträge</div><div class="value">${count}</div></div>
            <div class="stat"><div class="label">Stunden</div><div class="value">${fmtHours(minutes)}</div></div>
            <div class="stat"><div class="label">Verdienst</div><div class="value">${fmtEUR(amount)}</div></div>
        `;
    }

    function adminSummaryHtml(count, minutes, amount, agg) {
        const pctStr = String(ABGABEN_PCT).replace('.', ',');
        return summaryHtml(count, minutes, amount) +
            `<div class="stat"><div class="label">Kosten Owner1</div><div class="value">${fmtEUR(agg.sBase)}</div></div>` +
            `<div class="stat"><div class="label">Abgaben Owner1 (${pctStr}%)</div><div class="value">${fmtEUR(agg.sAbg)}</div></div>` +
            `<div class="stat"><div class="label">Gesamt Owner1</div><div class="value">${fmtEUR(agg.sTotal)}</div></div>` +
            `<div class="stat"><div class="label">Kosten Owner2</div><div class="value">${fmtEUR(agg.bBase)}</div></div>` +
            `<div class="stat"><div class="label">Abgaben Owner2 (${pctStr}%)</div><div class="value">${fmtEUR(agg.bAbg)}</div></div>` +
            `<div class="stat"><div class="label">Gesamt Owner2</div><div class="value">${fmtEUR(agg.bTotal)}</div></div>`;
    }

    $('#mineYear').addEventListener('change', renderMine);
    $('#mineMonth').addEventListener('change', renderMine);
    $('#mineReset').addEventListener('click', () => {
        $('#mineYear').value = '';
        $('#mineMonth').value = '';
        renderMine();
    });

    // ---------- Admin: Alle Schichten ----------

    function adminSortedShifts() {
        return [...shifts()].sort((a, b) =>
            b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime));
    }

    function currentAdminFiltered() {
        let list = filterByPeriod(adminSortedShifts(), '#adminYear', '#adminMonth');
        const empId = $('#adminEmpFilter').value;
        if (empId) list = list.filter(s => s.employeeId === Number(empId));
        return list;
    }
    function currentAdminPeriodKey() {
        // nur für Exporte: kombiniertes "YYYY-MM" wenn Jahr+Monat gesetzt, sonst ''
        return readPeriodValue('#adminYear', '#adminMonth');
    }

    function empName(id) {
        const e = employees().find(x => x.id === id);
        return e ? e.name : `#${id}`;
    }
    function empAssignment(id) {
        const e = employees().find(x => x.id === id);
        return (e && e.assignedTo) || 'owner1';
    }

    function renderAdminShifts() {
        fillYearMonthSelects('#adminYear', '#adminMonth');
        const sel = $('#adminEmpFilter');
        const cur = sel.value;
        sel.innerHTML = '<option value="">Alle</option>';
        [...employees()].sort((a,b) => a.name.localeCompare(b.name, 'de')).forEach(emp => {
            const o = document.createElement('option');
            o.value = emp.id;
            o.textContent = emp.name + (emp.isActive ? '' : ' (inaktiv)');
            sel.appendChild(o);
        });
        sel.value = cur;

        const tbody = $('#adminTable tbody');
        const list = currentAdminFiltered();
        tbody.innerHTML = '';
        let totalMin = 0, totalAmt = 0;
        const agg = { sBase: 0, sAbg: 0, sTotal: 0, bBase: 0, bAbg: 0, bTotal: 0 };
        list.forEach(s => {
            const w = wageFor(s);
            const c = splitCost(s);
            totalMin += w.minutes;
            totalAmt += w.amount;
            agg.sBase  += c.owner1Base;
            agg.sAbg   += c.owner1Abgaben;
            agg.sTotal += c.owner1Total;
            agg.bBase  += c.owner2Base;
            agg.bAbg   += c.owner2Abgaben;
            agg.bTotal += c.owner2Total;
            const tr = document.createElement('tr');
            tr.dataset.id = s.id;
            tr.innerHTML = `
                <td>${fmtDateDE(s.date)}</td>
                <td>${escapeHtml(empName(s.employeeId))}</td>
                <td>${s.startTime}</td>
                <td>${s.endTime}</td>
                <td class="num">${fmtHours(w.minutes)}</td>
                <td>${roomsLabel(s)}</td>
                <td>${s.isDouble ? '<span class="badge double">Doppel</span>' : '<span class="badge muted">Einfach</span>'}</td>
                <td class="num">${fmtEUR(w.amount)}</td>
                <td class="num">${fmtEUR(c.owner1Base)}</td>
                <td class="num">${fmtEUR(c.owner2Base)}</td>
                <td>${escapeHtml(s.note || '')}</td>
                <td>${isAdmin() ? `
                    <button class="btn small" data-edit="${s.id}">Bearb.</button>
                    <button class="btn small danger" data-del="${s.id}">Lösch.</button>
                ` : '<span class="muted small">–</span>'}</td>
            `;
            tbody.appendChild(tr);
        });
        if (!list.length) {
            tbody.innerHTML = `<tr><td colspan="12" class="muted" style="text-align:center;padding:2rem">Keine Einträge</td></tr>`;
        }
        $('#adminSummary').innerHTML = adminSummaryHtml(list.length, totalMin, totalAmt, agg);

        tbody.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => startEditRow(Number(b.dataset.edit)));
        tbody.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
            if (!await confirmModal('Löschen?', `<p>Schicht wirklich löschen?</p>`)) return;
            const id = Number(b.dataset.del);
            state.data.shifts = shifts().filter(s => s.id !== id);
            saveData();
            renderAdminShifts();
            toast('Gelöscht', 'success');
        });
    }

    function startEditRow(id) {
        const shift = shifts().find(s => s.id === id);
        if (!shift) return;
        const tr = $(`#adminTable tbody tr[data-id="${id}"]`);
        if (!tr) return;
        tr.classList.add('editing');
        const sec = secondRoomOf(shift);
        const roomOptsFor = (selected, exclude) => Object.keys(settings().rooms)
            .filter(c => c !== exclude)
            .map(c => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c} - ${settings().rooms[c].name}</option>`).join('');
        const empOpts = employees().map(e =>
            `<option value="${e.id}" ${e.id === shift.employeeId ? 'selected' : ''}>${escapeHtml(e.name)}</option>`).join('');
        tr.innerHTML = `
            <td><input class="inline-input" type="date" id="eDate" value="${shift.date}"></td>
            <td><select class="inline-input" id="eEmp">${empOpts}</select></td>
            <td><input class="inline-input" type="time" id="eStart" value="${shift.startTime}"></td>
            <td><input class="inline-input" type="time" id="eEnd" value="${shift.endTime}"></td>
            <td class="muted small">-</td>
            <td>
                <select class="inline-input" id="eRoom">${roomOptsFor(shift.room, shift.isDouble ? sec : null)}</select>
                <select class="inline-input ${shift.isDouble ? '' : 'hidden'}" id="eRoom2">${roomOptsFor(sec, shift.room)}</select>
            </td>
            <td><label class="checkbox"><input type="checkbox" id="eDouble" ${shift.isDouble ? 'checked' : ''}><span>Doppel</span></label></td>
            <td colspan="3" class="muted small">wird nach Speichern neu berechnet</td>
            <td><input class="inline-input" type="text" id="eNote" value="${escapeHtml(shift.note || '')}"></td>
            <td>
                <button class="btn small primary" id="eSave">Speichern</button>
                <button class="btn small ghost" id="eCancel">X</button>
            </td>
        `;
        const toggleE2 = () => {
            const d = $('#eDouble').checked;
            $('#eRoom2').classList.toggle('hidden', !d);
            if (d && $('#eRoom').value === $('#eRoom2').value) {
                const other = Array.from($('#eRoom2').options).find(o => o.value !== $('#eRoom').value);
                if (other) $('#eRoom2').value = other.value;
            }
        };
        $('#eDouble').onchange = toggleE2;
        $('#eRoom').onchange = toggleE2;
        $('#eCancel').onclick = renderAdminShifts;
        $('#eSave').onclick = () => {
            const isD = $('#eDouble').checked;
            const room = $('#eRoom').value;
            const secondRoom = isD ? $('#eRoom2').value : null;
            const payload = {
                employeeId: Number($('#eEmp').value),
                date: $('#eDate').value,
                startTime: $('#eStart').value,
                endTime: $('#eEnd').value,
                room, secondRoom, isDouble: isD,
            };
            const err = validateShiftPayload(payload);
            if (err) { toast(err, 'error'); return; }
            const overlap = findOverlap(shifts(), payload, id);
            if (overlap) { toast(`Zeit überschneidet sich mit bestehender Schicht (${overlap.startTime}–${overlap.endTime}, ${overlap.room}).`, 'error'); return; }
            if (isDuplicate(shifts(), payload, id)) { toast('Diese Schicht existiert bereits.', 'error'); return; }
            const idx = shifts().findIndex(s => s.id === id);
            if (idx === -1) return;
            state.data.shifts[idx] = Object.assign({}, state.data.shifts[idx], payload, {
                note: $('#eNote').value.trim(),
            });
            saveData();
            toast('Gespeichert', 'success');
            renderAdminShifts();
        };
    }

    $('#adminYear').addEventListener('change',  renderAdminShifts);
    $('#adminMonth').addEventListener('change', renderAdminShifts);
    $('#adminEmpFilter').addEventListener('change', renderAdminShifts);
    $('#adminReset').addEventListener('click', () => {
        $('#adminYear').value = '';
        $('#adminMonth').value = '';
        $('#adminEmpFilter').value = '';
        renderAdminShifts();
    });

    // ---------- Export ----------

    function exportRows() {
        const list = currentAdminFiltered();
        const pctStr = String(ABGABEN_PCT).replace('.', ',');
        const rows = [[
            'Datum','Mitarbeiter','Beginn','Ende','Dauer (Std)',
            'Raum 1','Raum 2','Raumnamen',
            'Typ','Stundenlohn','Verdienst (EUR)',
            'Kosten Owner1','Kosten Owner2','Notiz'
        ]];
        const tot = { hours: 0, amount: 0, sBase: 0, bBase: 0 };
        list.forEach(s => {
            const w = wageFor(s);
            const c = splitCost(s);
            const hours = w.minutes / 60;
            tot.hours += hours;
            tot.amount += w.amount;
            tot.sBase += c.owner1Base;
            tot.bBase += c.owner2Base;
            const sec = secondRoomOf(s);
            const r1name = settings().rooms[s.room]?.name || '';
            const r2name = sec ? (settings().rooms[sec]?.name || '') : '';
            rows.push([
                s.date, empName(s.employeeId), s.startTime, s.endTime,
                hours.toFixed(2), s.room, sec || '',
                sec ? `${r1name} + ${r2name}` : r1name,
                s.isDouble ? 'Doppel' : 'Einfach',
                w.rate.toFixed(2), w.amount.toFixed(2),
                c.owner1Base.toFixed(2), c.owner2Base.toFixed(2),
                s.note || ''
            ]);
        });
        const factor = ABGABEN_PCT / 100;
        const sAbg = tot.sBase * factor, sTot = tot.sBase + sAbg;
        const bAbg = tot.bBase * factor, bTot = tot.bBase + bAbg;
        rows.push([]);
        rows.push(['ZUSAMMENFASSUNG']);
        rows.push(['Einträge', list.length]);
        rows.push(['Stunden gesamt', tot.hours.toFixed(2)]);
        rows.push(['Verdienst Mitarbeiter (EUR)', tot.amount.toFixed(2)]);
        rows.push([]);
        rows.push(['Kosten Owner1 (EUR)', tot.sBase.toFixed(2)]);
        rows.push([`Abgaben Owner1 (${pctStr}%)`, sAbg.toFixed(2)]);
        rows.push(['Gesamt Owner1 (EUR)', sTot.toFixed(2)]);
        rows.push([]);
        rows.push(['Kosten Owner2 (EUR)', tot.bBase.toFixed(2)]);
        rows.push([`Abgaben Owner2 (${pctStr}%)`, bAbg.toFixed(2)]);
        rows.push(['Gesamt Owner2 (EUR)', bTot.toFixed(2)]);
        return { rows, list };
    }

    function exportFilenameBase() {
        const y = readPeriodYear('#adminYear');
        const m = readPeriodMonth('#adminMonth');
        const e = $('#adminEmpFilter').value;
        const parts = ['paralox-stunden'];
        if (e) {
            const name = employees().find(x => x.id === Number(e))?.name || '';
            if (name) parts.push(name.replace(/\s+/g, '_'));
        }
        if (y && m) parts.push(`${y}-${m}`);
        else if (y)  parts.push(y);
        else if (m)  parts.push('monat-' + m);
        else         parts.push(new Date().toISOString().slice(0, 10));
        return parts.join('_');
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    }

    function exportCSV() {
        const { rows } = exportRows();
        const csv = rows.map(r => r.map(cell => {
            const s = String(cell ?? '');
            return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(';')).join('\r\n');
        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
        downloadBlob(blob, exportFilenameBase() + '.csv');
    }

    function exportODS() {
        if (typeof XLSX === 'undefined') { toast('Export-Library nicht geladen', 'error'); return; }
        const { rows } = exportRows();
        const ws = XLSX.utils.aoa_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Stunden');
        const out = XLSX.write(wb, { bookType: 'ods', type: 'array' });
        downloadBlob(new Blob([out], { type: 'application/vnd.oasis.opendocument.spreadsheet' }), exportFilenameBase() + '.ods');
    }

    function exportPDF() {
        if (typeof window.jspdf === 'undefined') { toast('PDF-Library nicht geladen', 'error'); return; }
        const { rows, list } = exportRows();
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
        const y = readPeriodYear('#adminYear');
        const m = readPeriodMonth('#adminMonth');
        const empId = $('#adminEmpFilter').value;
        const periodLabel = (y && m) ? `${MONTH_NAMES[Number(m) - 1]} ${y}`
            : y ? `Jahr ${y}`
            : m ? `${MONTH_NAMES[Number(m) - 1]} (alle Jahre)`
            : 'Alle Zeiträume';
        const title = 'Paralox Stundenübersicht';
        const subtitle = [
            empId ? `Mitarbeiter: ${empName(Number(empId))}` : 'Alle Mitarbeiter',
            `Zeitraum: ${periodLabel}`,
        ].join(' - ');
        doc.setFontSize(14); doc.text(title, 40, 40);
        doc.setFontSize(10); doc.setTextColor(120); doc.text(subtitle, 40, 58);
        doc.setTextColor(0);

        let totalAmt = 0, totalMin = 0;
        const agg = { sBase: 0, sAbg: 0, sTotal: 0, bBase: 0, bAbg: 0, bTotal: 0 };
        list.forEach(s => {
            const w = wageFor(s);
            const c = splitCost(s);
            totalAmt += w.amount;
            totalMin += w.minutes;
            agg.sBase += c.owner1Base; agg.sAbg += c.owner1Abgaben; agg.sTotal += c.owner1Total;
            agg.bBase += c.owner2Base; agg.bAbg += c.owner2Abgaben; agg.bTotal += c.owner2Total;
        });

        doc.autoTable({
            head: [rows[0]],
            body: rows.slice(1),
            startY: 74,
            styles: { fontSize: 8, cellPadding: 3 },
            headStyles: { fillColor: [124, 92, 255] },
            alternateRowStyles: { fillColor: [245, 243, 255] },
        });
        const yPos = doc.lastAutoTable.finalY + 20;
        const pctStr = String(ABGABEN_PCT).replace('.', ',');
        doc.setFontSize(10);
        doc.text(`Einträge: ${list.length}   Stunden: ${fmtHours(totalMin)}   Verdienst gesamt: ${fmtEUR(totalAmt)}`, 40, yPos);
        doc.text(`Owner1:   Kosten ${fmtEUR(agg.sBase)}  +  Abgaben (${pctStr}%) ${fmtEUR(agg.sAbg)}  =  Gesamt ${fmtEUR(agg.sTotal)}`, 40, yPos + 16);
        doc.text(`Owner2: Kosten ${fmtEUR(agg.bBase)}  +  Abgaben (${pctStr}%) ${fmtEUR(agg.bAbg)}  =  Gesamt ${fmtEUR(agg.bTotal)}`, 40, yPos + 32);
        doc.save(exportFilenameBase() + '.pdf');
    }

    // ---------- Minijob-PDF ----------

    async function exportMinijobPDF() {
        if (typeof window.jspdf === 'undefined') { toast('PDF-Library nicht geladen', 'error'); return; }

        const now = new Date();
        const curYear = now.getFullYear();
        const defY = readPeriodYear('#adminYear')  || String(curYear);
        const defM = readPeriodMonth('#adminMonth') || pad(now.getMonth() + 1);

        const month = await promptMonthModal('Minijob-PDF — Monat wählen', defY, defM);
        if (!month) return;

        const [yearStr, monthStr] = month.split('-');
        const monthLabel = `${MONTH_NAMES[Number(monthStr) - 1]} ${yearStr}`;
        const filterEmpId = $('#adminEmpFilter').value;

        let targetEmps = [...employees()];
        if (filterEmpId) targetEmps = targetEmps.filter(e => e.id === Number(filterEmpId));
        targetEmps = targetEmps
            .map(e => {
                const list = shifts()
                    .filter(s => s.employeeId === e.id && s.date.startsWith(month))
                    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
                return { emp: e, list };
            })
            .filter(x => x.list.length > 0)
            .sort((a, b) => a.emp.name.localeCompare(b.emp.name, 'de'));

        if (!targetEmps.length) {
            toast('Keine Schichten in diesem Monat.', 'error');
            return;
        }

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });

        targetEmps.forEach((entry, idx) => {
            if (idx > 0) doc.addPage();
            const { emp, list } = entry;
            const arbeitgeber = emp.assignedTo === 'owner2'
                ? 'Owner2 Schmid'
                : 'Beispiel GbR';

            doc.setFontSize(16); doc.setTextColor(0);
            doc.text('Stundenliste Minijob', 40, 50);
            doc.setFontSize(11); doc.setTextColor(80);
            doc.text(`Mitarbeiter:  ${emp.name}`, 40, 78);
            doc.text(`Zeitraum:     ${monthLabel}`, 40, 94);
            doc.text(`Arbeitgeber:  ${arbeitgeber}`, 40, 110);
            doc.setTextColor(0);

            const body = list.map(s => {
                const w = wageFor(s);
                return [
                    fmtDateDE(s.date),
                    s.startTime,
                    s.endTime,
                    (w.minutes / 60).toFixed(2).replace('.', ','),
                    w.rate.toFixed(2).replace('.', ',') + ' EUR',
                    w.amount.toFixed(2).replace('.', ',') + ' EUR',
                ];
            });

            let totalMin = 0, totalAmt = 0;
            list.forEach(s => { const w = wageFor(s); totalMin += w.minutes; totalAmt += w.amount; });

            doc.autoTable({
                head: [['Datum','Beginn','Ende','Stunden','Stundenlohn','Betrag']],
                body,
                startY: 130,
                styles: { fontSize: 10, cellPadding: 5 },
                headStyles: { fillColor: [124, 92, 255], textColor: 255 },
                alternateRowStyles: { fillColor: [245, 243, 255] },
                columnStyles: {
                    3: { halign: 'right' },
                    4: { halign: 'right' },
                    5: { halign: 'right' },
                },
            });

            const yAfter = doc.lastAutoTable.finalY + 20;
            doc.setFontSize(11);
            doc.setFont(undefined, 'bold');
            doc.text(`Summe:`, 40, yAfter);
            doc.text(`${(totalMin / 60).toFixed(2).replace('.', ',')} Std`, 300, yAfter, { align: 'right' });
            doc.text(`${fmtEUR(totalAmt)}`, 540, yAfter, { align: 'right' });
            doc.setFont(undefined, 'normal');

            doc.setFontSize(9); doc.setTextColor(120);
            doc.text(`Erstellt am ${fmtDateTimeDE(new Date().toISOString())}`, 40, 800);
            doc.text(`Seite ${idx + 1} von ${targetEmps.length}`, 540, 800, { align: 'right' });
            doc.setTextColor(0);
        });

        doc.save(`stundenlisten_minijob_${yearStr}_${monthStr}.pdf`);
    }

    $$('[data-export]').forEach(b => b.addEventListener('click', () => {
        const t = b.dataset.export;
        if (t === 'csv') exportCSV();
        if (t === 'ods') exportODS();
        if (t === 'pdf') exportPDF();
        if (t === 'minijob') exportMinijobPDF();
    }));

    // ---------- Mitarbeiter ----------

    function renderEmployees() {
        const tbody = $('#empTable tbody');
        const admin = isAdmin();
        $('#empForm').classList.toggle('hidden', !admin);
        $('#empCreateTitle').classList.toggle('hidden', !admin);
        tbody.innerHTML = '';
        [...employees()].sort((a,b)=>a.name.localeCompare(b.name,'de')).forEach(e => {
            const roleBadge = e.isAdmin
                ? '<span class="badge ok">Admin</span>'
                : e.isAccountant
                    ? '<span class="badge">Buchhaltung</span>'
                    : '<span class="badge muted">Mitarbeiter</span>';
            const arbeitgeberLabel = e.assignedTo === 'owner2'
                ? 'Owner2 Schmid'
                : 'Beispiel GbR';
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${escapeHtml(e.name)}</td>
                <td>${roleBadge}</td>
                <td><span class="badge">${escapeHtml(arbeitgeberLabel)}</span></td>
                <td>${e.isActive ? '<span class="badge ok">Aktiv</span>' : '<span class="badge muted">Inaktiv</span>'}</td>
                <td class="muted small">${e.createdAt ? fmtDateDE(e.createdAt.slice(0, 10)) : ''}</td>
                <td>${admin ? `
                    <button class="btn small" data-emp-rename="${e.id}">Umbenennen</button>
                    <button class="btn small" data-emp-pw="${e.id}">Passwort</button>
                    <button class="btn small" data-emp-assign="${e.id}">Arbeitgeber wechseln</button>
                    <button class="btn small" data-emp-admin="${e.id}">${e.isAdmin ? 'Admin entziehen' : 'Admin geben'}</button>
                    <button class="btn small" data-emp-acc="${e.id}">${e.isAccountant ? 'Buchhaltung entziehen' : 'Buchhaltung geben'}</button>
                    <button class="btn small ${e.isActive ? 'danger' : ''}" data-emp-active="${e.id}">${e.isActive ? 'Deaktivieren' : 'Aktivieren'}</button>
                    <button class="btn small danger" data-emp-delete="${e.id}" title="Löscht den Mitarbeiter dauerhaft. Nur möglich, wenn keine Schichten im laufenden Monat existieren.">Löschen</button>
                ` : '<span class="muted small">–</span>'}</td>
            `;
            tbody.appendChild(tr);
        });
        if (!admin) return;

        const ensureOneActiveAdmin = (exceptId, makingInactiveOrNoAdmin) => {
            if (!makingInactiveOrNoAdmin) return true;
            const others = employees().filter(x => x.id !== exceptId && x.isAdmin && x.isActive);
            if (!others.length) { toast('Mindestens ein aktiver Admin erforderlich.', 'error'); return false; }
            return true;
        };

        tbody.querySelectorAll('[data-emp-rename]').forEach(b => b.onclick = async () => {
            const emp = employees().find(x => x.id === Number(b.dataset.empRename));
            const r = await promptModal('Umbenennen', [{ key: 'name', label: 'Neuer Name', value: emp.name }]);
            if (!r || !r.name.trim()) return;
            const name = r.name.trim();
            if (employees().some(x => x.id !== emp.id && x.name.toLowerCase() === name.toLowerCase())) {
                toast('Name bereits vergeben.', 'error'); return;
            }
            emp.name = name;
            saveData();
            toast('Gespeichert', 'success');
            renderEmployees();
        });
        tbody.querySelectorAll('[data-emp-pw]').forEach(b => b.onclick = async () => {
            const emp = employees().find(x => x.id === Number(b.dataset.empPw));
            const r = await promptModal('Passwort setzen', [{ key: 'pw', label: 'Neues Passwort', type: 'password' }]);
            if (!r || !r.pw) return;
            const ruleErr = validatePasswordRules(r.pw);
            if (ruleErr) { toast(ruleErr, 'error'); return; }
            try {
                emp.password = hashPassword(r.pw);
                saveData();
                toast('Passwort gesetzt', 'success');
            } catch (e) {
                toast(e.message, 'error');
            }
        });
        tbody.querySelectorAll('[data-emp-assign]').forEach(b => b.onclick = () => {
            const emp = employees().find(x => x.id === Number(b.dataset.empAssign));
            emp.assignedTo = emp.assignedTo === 'owner2' ? 'owner1' : 'owner2';
            saveData();
            const label = emp.assignedTo === 'owner2' ? 'Owner2 Schmid' : 'Beispiel GbR';
            toast(`Arbeitgeber: ${label}`, 'success');
            renderEmployees();
        });
        tbody.querySelectorAll('[data-emp-admin]').forEach(b => b.onclick = () => {
            const emp = employees().find(x => x.id === Number(b.dataset.empAdmin));
            const makingNonAdmin = emp.isAdmin;
            if (makingNonAdmin && !ensureOneActiveAdmin(emp.id, true)) return;
            emp.isAdmin = !emp.isAdmin;
            saveData();
            renderEmployees();
            toast('Gespeichert', 'success');
        });
        tbody.querySelectorAll('[data-emp-acc]').forEach(b => b.onclick = () => {
            const emp = employees().find(x => x.id === Number(b.dataset.empAcc));
            emp.isAccountant = !emp.isAccountant;
            saveData();
            renderEmployees();
            toast('Gespeichert', 'success');
        });
        tbody.querySelectorAll('[data-emp-active]').forEach(b => b.onclick = async () => {
            const emp = employees().find(x => x.id === Number(b.dataset.empActive));
            if (emp.isActive) {
                if (emp.isAdmin && !ensureOneActiveAdmin(emp.id, true)) return;
                if (!await confirmModal('Deaktivieren?', `<p>${escapeHtml(emp.name)} deaktivieren? Schichten bleiben erhalten.</p>`)) return;
            }
            emp.isActive = !emp.isActive;
            saveData();
            renderEmployees();
            toast('Gespeichert', 'success');
        });

        tbody.querySelectorAll('[data-emp-delete]').forEach(b => b.onclick = async () => {
            const id = Number(b.dataset.empDelete);
            const emp = employees().find(x => x.id === id);
            if (!emp) return;
            if (state.user && state.user.id === id) {
                toast('Du kannst dich nicht selbst löschen.', 'error');
                return;
            }
            if (emp.isAdmin) {
                const others = employees().filter(x => x.id !== id && x.isAdmin && x.isActive);
                if (!others.length) {
                    toast('Mindestens ein aktiver Admin erforderlich.', 'error');
                    return;
                }
            }
            // Schichten im laufenden Monat sperren das Löschen
            const now = new Date();
            const monthKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
            const monthCount = shifts().filter(s => s.employeeId === id && s.date.startsWith(monthKey)).length;
            if (monthCount > 0) {
                toast(`${emp.name} hat ${monthCount} Schicht(en) im laufenden Monat — Löschen erst nach Monatsende möglich. Stattdessen "Deaktivieren" nutzen.`, 'error');
                return;
            }
            const totalCount = shifts().filter(s => s.employeeId === id).length;
            const detail = totalCount > 0
                ? `<p>${escapeHtml(emp.name)} wirklich dauerhaft löschen?</p><p class="muted small">Es gibt noch ${totalCount} Schicht(en) aus früheren Monaten. Diese bleiben in der Datenbank gespeichert, werden in der Übersicht aber nur noch mit der ID #${id} angezeigt.</p>`
                : `<p>${escapeHtml(emp.name)} wirklich dauerhaft löschen?</p>`;
            if (!await confirmModal('Mitarbeiter löschen?', detail)) return;
            state.data.employees = employees().filter(x => x.id !== id);
            saveData();
            renderEmployees();
            toast('Gelöscht', 'success');
        });
    }

    $('#empForm').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const name = $('#empName').value.trim();
        const pw = $('#empPw').value;
        if (!name) { toast('Name erforderlich.', 'error'); return; }
        const ruleErr = validatePasswordRules(pw);
        if (ruleErr) { toast(ruleErr, 'error'); return; }
        if (employees().some(x => x.name.toLowerCase() === name.toLowerCase())) {
            toast('Name bereits vergeben.', 'error'); return;
        }
        let hashed;
        try { hashed = hashPassword(pw); }
        catch (e) { toast(e.message, 'error'); return; }
        state.data.employees.push({
            id: window.ParaloxStorage.nextId(employees()),
            name,
            password: hashed,
            isAdmin: $('#empAdmin').checked,
            isAccountant: $('#empAccountant').checked,
            isActive: true,
            assignedTo: $('#empAssigned').value,
            createdAt: new Date().toISOString(),
        });
        saveData();
        $('#empName').value = '';
        $('#empPw').value = '';
        $('#empAdmin').checked = false;
        $('#empAccountant').checked = false;
        $('#empAssigned').value = 'owner1';
        toast('Mitarbeiter angelegt', 'success');
        renderEmployees();
    });

    // ---------- Einstellungen ----------

    function renderSettings() {
        $('#setSingle').value = settings().wageSingle;
        $('#setDouble').value = settings().wageDouble;
        const admin = isAdmin();
        $$('#settingsForm input, #settingsForm button').forEach(el => el.disabled = !admin);
        $('#settingsForm').title = admin ? '' : 'Nur Admins können Einstellungen ändern.';
        const tbody = $('#roomsTable tbody');
        tbody.innerHTML = '';
        Object.entries(settings().rooms).forEach(([code, r]) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><span class="badge">${code}</span></td>
                <td>${escapeHtml(r.name)}</td>
                <td class="num">${r.owner1}%</td>
                <td class="num">${r.owner2}%</td>
            `;
            tbody.appendChild(tr);
        });
    }

    $('#settingsForm').addEventListener('submit', (ev) => {
        ev.preventDefault();
        settings().wageSingle = Math.max(0, Number($('#setSingle').value) || 0);
        settings().wageDouble = Math.max(0, Number($('#setDouble').value) || 0);
        saveData();
        renderPreview();
        toast('Einstellungen gespeichert', 'success');
    });

    // ---------- Pinnwand ----------

    function renderPinboard() {
        const pb = state.data.pinboard;
        $('#pinText').value = pb.text || '';
        const meta = pb.updatedAt
            ? `Zuletzt aktualisiert: ${fmtDateTimeDE(pb.updatedAt)}${pb.updatedBy ? ' · ' + pb.updatedBy : ''}`
            : 'Noch keine Mitteilung hinterlegt.';
        $('#pinMeta').textContent = meta;
    }

    $('#pinSave').addEventListener('click', () => {
        const txt = $('#pinText').value;
        state.data.pinboard = {
            text: txt,
            updatedAt: new Date().toISOString(),
            updatedBy: state.user.name,
        };
        saveData();
        toast('Mitteilung gespeichert', 'success');
        renderPinboard();
    });
    $('#pinClear').addEventListener('click', async () => {
        if (!await confirmModal('Mitteilung löschen?', '<p>Mitteilung wirklich entfernen? Sie verschwindet dann von der Login-Seite.</p>')) return;
        state.data.pinboard = { text: '', updatedAt: new Date().toISOString(), updatedBy: state.user.name };
        saveData();
        $('#pinText').value = '';
        toast('Gelöscht', 'success');
        renderPinboard();
    });

    // ---------- Helpers ----------

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c =>
            ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    // ---------- Init ----------

    async function init() {
        loadData();
        // Drive-Sync versuchen (unkritisch wenn nicht konfiguriert)
        if (window.ParaloxDrive) {
            try { await window.ParaloxDrive.init(); } catch (e) { console.warn('Drive-Init fehlgeschlagen', e); }
        }
        // Auf bcryptjs warten und dann ALLE Klartext-Passwörter migrieren
        const bcryptReady = await ensureBcryptLoaded();
        let migrated = false;
        if (!bcryptReady) {
            toast('Passwort-Verschlüsselung konnte nicht geladen werden — bitte Internetverbindung prüfen und neu laden.', 'error');
        } else {
            migrated = migratePlaintextPasswords();
        }
        // Wurden Klartext-Passwörter ersetzt, sofort nach Drive hochladen
        // (statt auf den 2s-Debounce zu warten — sicherer falls die App kurz danach geschlossen wird)
        if (migrated && window.ParaloxDrive && typeof window.ParaloxDrive.pushNow === 'function') {
            try {
                await window.ParaloxDrive.pushNow();
                console.log('[Paralox] Migrierte Daten wurden in Drive hochgeladen.');
            } catch (e) {
                console.warn('[Paralox] Drive-Push nach Migration fehlgeschlagen', e);
            }
        }
        if (restoreSession()) {
            enterApp();
        } else {
            initLogin();
        }
    }

    init();
})();
