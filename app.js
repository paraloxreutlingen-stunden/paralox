/* Paralox Stundenverwaltung - Frontend (localStorage + Google Drive) */
(() => {
    'use strict';

    /* Pauschalabgaben für gewerbliche Minijobs an die Minijob-Zentrale,
     * Stand 2026 (Quelle: minijob-zentrale.de). Wenn sich ein Einzelposten
     * gesetzlich ändert, hier den Wert anpassen — ABGABEN_PCT addiert sich
     * automatisch neu auf. */
    const ABGABEN_PARTS = {
        kv:        13.00,  // Pauschalbeitrag Krankenversicherung
        rv:        15.00,  // Pauschalbeitrag Rentenversicherung (AG-Anteil)
        u1:         0.80,  // Umlage U1 Krankheit  (zum 01.01.2026 von 1,10 auf 0,80 gesenkt)
        u2:         0.22,  // Umlage U2 Mutterschaft  (zum 01.01.2026 von 0,24 auf 0,22 gesenkt)
        insolvenz:  0.15,  // Insolvenzgeldumlage
        steuer:     2.00,  // Pauschsteuer
    };
    // Math.round verhindert Floating-Point-Drift bei der Summe (sonst 31.169999…).
    const ABGABEN_PCT = Math.round(
        Object.values(ABGABEN_PARTS).reduce((sum, x) => sum + x, 0) * 100
    ) / 100;  // = 31,17
    const LIMIT_YEAR       = 7236;
    const LIMIT_YEAR_WARN  = 5736;
    const LIMIT_MONTH      = 603;
    const LIMIT_MONTH_WARN = 550;
    /* Auto-Logout nach Inaktivität. Das Tablet steht im Betrieb offen herum —
     * eine kurze Frist verhindert, dass der nächste Mitarbeiter die Sitzung
     * seines Vorgängers vorfindet. Jede Maus-, Tasten-, Touch- oder Scroll-
     * Aktion setzt die Frist zurück, sie greift also nur bei echtem Stillstand. */
    const IDLE_TIMEOUT_MS  = 90 * 1000; // 90 Sekunden Auto-Logout
    const MAX_END_MIN_NONADMIN = 24 * 60 + 30; // 00:30 am Folgetag (Schichtende darf nicht später liegen)
    const MONTH_NAMES = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
    /* Buchhaltungs-Konten dürfen in der Gesamt-Stundenliste und den Exporten
     * nur die letzten N Tage sehen — alles davor wird ausgeblendet, da es für
     * die laufende Lohnabrechnung nicht mehr nötig ist. „Meine Stunden" für
     * eigene Schichten bleibt unbegrenzt. */
    const VIEW_DAYS_LIMIT_ACCOUNTANT = 90;

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
            // Felder mit options[] werden zum <select> — .value liest sich gleich,
            // daher bleibt die Auswertung unten unverändert.
            const html = fields.map((f, i) => {
                if (Array.isArray(f.options)) {
                    const opts = f.options.map(o =>
                        `<option value="${o.value}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${o.label}</option>`
                    ).join('');
                    return `<label>${f.label}<select id="pm_${i}">${opts}</select></label>`;
                }
                return `<label>${f.label}<input type="${f.type || 'text'}" id="pm_${i}" value="${f.value ?? ''}" ${f.attr || ''}></label>`;
            }).join('');
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

    // Datierte Lohnhistorie (chronologisch sortiert, von normalize() garantiert
    // nicht leer). Quelle der Wahrheit für alle Verdienstberechnungen.
    function wageHistory() {
        const h = settings().wageHistory;
        return Array.isArray(h) ? h : [];
    }
    // Die Stundensätze, die an einem bestimmten Datum (YYYY-MM-DD) galten.
    // Liefert den jüngsten Eintrag mit gueltigAb <= date. Für Daten vor dem
    // ersten Eintrag fällt es auf den frühesten Satz zurück, damit nie ein
    // Verdienst von 0 entsteht (Sicherheitsnetz, falls der Migrationseintrag
    // mal gelöscht würde).
    function wageRatesFor(date) {
        const hist = wageHistory();
        if (hist.length === 0) return { single: 0, double: 0 };
        let chosen = hist[0];
        for (const h of hist) {
            if (h.gueltigAb <= date) chosen = h;
            else break;
        }
        return { single: chosen.single, double: chosen.double };
    }

    // Urlaubstag statt gearbeiteter Schicht.
    const isVacation = s => !!(s && s.isVacation);

    /* ---------- Urlaubsentgelt ----------
     *
     * § 11 BUrlG: Das Urlaubsentgelt bemisst sich nach dem durchschnittlichen
     * Arbeitsverdienst der letzten 13 Wochen vor Urlaubsbeginn. Bei
     * unregelmäßiger Beschäftigung — der Regelfall hier — wird durch die
     * tatsächlich GEARBEITETEN Tage geteilt, nicht durch Kalender- oder
     * Fünf-Tage-Wochen: Wer zwei Tage pro Woche arbeitet, soll für einen
     * Urlaubstag das bekommen, was ein normaler Arbeitstag einbringt.
     *
     * Frühere Urlaubstage zählen NICHT in die Bemessung — sonst würde sich
     * Urlaub aus Urlaub speisen und der Satz mit jedem Urlaubstag driften. */
    const URLAUB_REF_WOCHEN = 13;

    // Datum minus N Tage als ISO YYYY-MM-DD (rein kalendarisch, ohne Zeitzone).
    function isoMinusDays(iso, days) {
        const [y, m, d] = iso.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        dt.setUTCDate(dt.getUTCDate() - days);
        return dt.toISOString().slice(0, 10);
    }

    /* Durchschnittlicher Tagesverdienst eines Mitarbeiters für einen Urlaubstag
     * am Stichtag `datum`. Liefert zusätzlich die Bemessungsgrundlage, damit die
     * Oberfläche nachvollziehbar machen kann, wie der Betrag zustande kommt.
     * Ohne gearbeitete Tage im Bezugszeitraum ist kein Durchschnitt bildbar —
     * dann 0 und tage = 0; der Aufrufer muss das dem Admin sagen. */
    /* Erster Tag des zusammenhängenden Urlaubsblocks, in den `datum` fällt.
     * § 9 der Rahmenvereinbarung bemisst nach den 13 Wochen vor dem
     * URLAUBSANTRITT — bei einem durchgehenden Urlaub gilt also für alle Tage
     * derselbe Satz. Ohne das bekäme jeder Tag ein leicht verschobenes Fenster
     * und ein zusammenhängender Urlaub stünde mit mehreren Beträgen im PDF. */
    function urlaubsAntritt(empId, datum) {
        let antritt = datum;
        for (;;) {
            const davor = isoMinusDays(antritt, 1);
            const belegt = shifts().some(s =>
                isVacation(s) && s.employeeId === empId && s.date === davor);
            if (!belegt) return antritt;
            antritt = davor;
        }
    }

    function urlaubsTagessatz(empId, datum) {
        // Nicht vom einzelnen Tag aus rechnen, sondern vom Urlaubsantritt.
        datum = urlaubsAntritt(empId, datum);
        const von = isoMinusDays(datum, URLAUB_REF_WOCHEN * 7);
        const relevant = shifts().filter(s =>
            s.employeeId === empId &&
            !isVacation(s) &&
            s.date >= von && s.date < datum);
        let summe = 0;
        const tage = new Set();
        relevant.forEach(s => {
            summe += shiftPayAmount(s);
            tage.add(s.date);
        });
        const anzahl = tage.size;
        return {
            betrag: anzahl > 0 ? roundHalfUp(summe / anzahl) : 0,
            summe: roundHalfUp(summe),
            tage: anzahl,
            von,
            bis: isoMinusDays(datum, 1),
        };
    }

    /* Urlaubs-Dialog eines Mitarbeiters: Restkonto, bereits eingetragene Tage
     * und das Formular zum Nachtragen. Der Betrag wird beim Eintragen einmal
     * berechnet und fest im Datensatz abgelegt; die Vorschau darunter zeigt,
     * woraus er entsteht, damit der Admin ihn prüfen kann, bevor er ihn setzt. */
    function openUrlaubModal(empId) {
        const emp = employees().find(x => x.id === empId);
        if (!emp) return;
        const modal = $('#modal');
        const jahr = new Date().getFullYear();

        const zeichne = () => {
            const k = urlaubsKonto(empId, jahr);
            const heute = todayISO();
            const vorschau = urlaubsTagessatz(empId, heute);
            const liste = k.tage.length
                ? k.tage.map(d => {
                    const s = shifts().find(x => isVacation(x) && x.employeeId === empId && x.date === d);
                    return `<li>${escapeHtml(fmtDateDE(d))} <span class="muted">— ${fmtEUR(Number(s?.urlaubsBetrag) || 0)}</span>
                        <button class="btn small danger" data-urlaub-del="${s?.id}">Löschen</button></li>`;
                }).join('')
                : '<li class="muted">Noch keine Urlaubstage in diesem Jahr.</li>';

            const uebertragStat = k.uebertragBrutto > 0
                ? `<div class="stat"><div class="label">Übertrag aus ${jahr - 1}</div><div class="value">${
                    k.uebertragVerfallen
                        ? `<span class="muted">${fmtTage(k.uebertragBrutto)} verfallen</span>`
                        : `${fmtTage(k.uebertrag)} Tage`}</div></div>`
                : '';
            $('#modalBody').innerHTML = `
                <div class="stats">
                    <div class="stat"><div class="label">Anspruch ${jahr}</div><div class="value">${fmtTage(k.anspruch)} Tage</div></div>
                    ${uebertragStat}
                    <div class="stat"><div class="label">Genommen</div><div class="value">${k.genommen} Tage</div></div>
                    <div class="stat"><div class="label">Übrig</div><div class="value">${fmtTage(k.rest)} Tage</div></div>
                </div>
                <p class="muted small">Anspruch = ${k.arbeitstage} Arbeitstage ÷ ${URLAUB_TEILER} (§ 9 Rahmenvereinbarung).
                   Er wächst mit jeder erfassten Schicht und ist erst zum Jahresende endgültig.${
                    k.uebertragBrutto > 0
                        ? k.uebertragVerfallen
                            ? ` Der Übertrag aus ${jahr - 1} ist zum 30. Juni ${jahr} verfallen.`
                            : ` Der Übertrag aus ${jahr - 1} verfällt zum 30. Juni ${jahr}.`
                        : ''}</p>
                <label>Urlaubstag eintragen
                    <input type="date" id="urlaubDatum" value="${heute}" autocomplete="off">
                </label>
                <p class="muted small" id="urlaubVorschau"></p>
                <h4>Urlaubstage ${jahr}</h4>
                <ul class="urlaub-liste">${liste}</ul>
            `;

            // Vorschau des Tagessatzes, sobald das Datum wechselt.
            const feld = $('#urlaubDatum');
            const zeigeVorschau = () => {
                const d = feld.value;
                const t = d ? urlaubsTagessatz(empId, d) : vorschau;
                $('#urlaubVorschau').innerHTML = t.tage > 0
                    ? `Betrag: <strong>${fmtEUR(t.betrag)}</strong> — Durchschnitt aus ${fmtEUR(t.summe)} an ` +
                      `${t.tage} Arbeitstag${t.tage === 1 ? '' : 'en'} (${fmtDateDE(t.von)} bis ${fmtDateDE(t.bis)}).`
                    : `<span class="warn-text">Keine Arbeitstage in den ${URLAUB_REF_WOCHEN} Wochen davor — ` +
                      `der Urlaubstag würde mit 0,00 EUR eingetragen.</span>`;
            };
            feld.oninput = zeigeVorschau;
            feld.onchange = zeigeVorschau;
            zeigeVorschau();

            $('#modalBody').querySelectorAll('[data-urlaub-del]').forEach(btn => btn.onclick = () => {
                const id = Number(btn.dataset.urlaubDel);
                const i = shifts().findIndex(x => x.id === id);
                if (i === -1) return;
                state.data.shifts.splice(i, 1);
                saveData();
                zeichne();
                renderEmployees();
                if (state.activeTab === 'shifts') renderAdminShifts();
                toast('Urlaubstag gelöscht', 'success');
            });
        };

        $('#modalTitle').textContent = `Urlaub — ${emp.name}`;
        zeichne();
        modal.classList.remove('hidden');

        const ok = $('#modalOk');
        const cancel = $('#modalCancel');
        const schliessen = () => {
            modal.classList.add('hidden');
            ok.onclick = null;
            cancel.onclick = null;
            ok.textContent = 'OK';
        };
        ok.textContent = 'Urlaubstag eintragen';
        ok.onclick = () => {
            const datum = $('#urlaubDatum').value;
            if (!validDate(datum)) { toast('Bitte ein gültiges Datum wählen.', 'error'); return; }
            // Ein Tag kann nur einmal Urlaub sein.
            if (shifts().some(s => isVacation(s) && s.employeeId === empId && s.date === datum)) {
                toast('Für diesen Tag ist bereits Urlaub eingetragen.', 'error');
                return;
            }
            // An einem Tag mit Schicht ist Urlaub widersprüchlich.
            if (shifts().some(s => !isVacation(s) && s.employeeId === empId && s.date === datum)) {
                toast('An diesem Tag ist bereits eine Schicht erfasst.', 'error');
                return;
            }
            const t = urlaubsTagessatz(empId, datum);
            state.data.shifts.push({
                id: window.ParaloxStorage.nextId(shifts()),
                employeeId: empId,
                date: datum,
                startTime: '',
                endTime: '',
                room: null,
                secondRoom: null,
                isDouble: false,
                isVacation: true,
                // Eingefroren: siehe wageFor(). Der Schnitt wandert mit neuen
                // Schichten, der gemeldete Betrag darf das nicht.
                urlaubsBetrag: t.betrag,
                note: '',
                createdAt: new Date().toISOString(),
            });
            saveData();
            toast(t.tage > 0
                ? `Urlaubstag eingetragen: ${fmtEUR(t.betrag)}`
                : 'Urlaubstag eingetragen — ohne Arbeitstage im Bezugszeitraum mit 0,00 EUR', t.tage > 0 ? 'success' : 'info');
            zeichne();
            renderEmployees();
            if (state.activeTab === 'shifts') renderAdminShifts();
            if (state.activeTab === 'mine') renderMine();
        };
        cancel.onclick = schliessen;
    }

    /* Teiler der Urlaubsformel aus § 9 der Rahmenvereinbarung:
     * geleistete Arbeitstage im Kalenderjahr ÷ 13 = Urlaubstage.
     *
     * Deckt sich mit dem gesetzlichen Mindesturlaub: § 3 BUrlG nennt 24
     * Werktage bei Sechs-Tage-Woche, das Jahr hat 313 Werktage, und
     * 313 / 24 = 13,04. Zwei Arbeitstage pro Woche (104 im Jahr) ergeben
     * damit 8,0 Tage, fünf (261) ergeben 20,1 — genau die gesetzlichen Werte. */
    const URLAUB_TEILER = 13;

    /* Resturlaub aus dem Vorjahr verfällt zum 30. Juni des Folgejahres
     * (§ 9 Rahmenvereinbarung, abweichend von der sonst üblichen Frist zum
     * 31. März). Gleicher Stichtag wie das Ende des Erinnerungsfensters. */
    const URLAUB_VERFALL_MMDD = '06-30';

    /* Urlaubskonto eines Mitarbeiters für ein Kalenderjahr.
     *
     * Der Anspruch wird NICHT gepflegt, sondern aus den erfassten Schichten
     * abgeleitet: Arbeitstage im Jahr ÷ 365 × 24 Werktage. Als Arbeitstag zählt
     * jedes Datum mit mindestens einer Schicht — zwei Schichten am selben Tag
     * sind ein Arbeitstag. Urlaubstage selbst zählen nicht als Arbeitstage,
     * sonst würde genommener Urlaub den Anspruch erhöhen.
     *
     * Weil die Grundlage mitwächst, steigt der Anspruch im laufenden Jahr mit
     * jeder erfassten Schicht — unterjährig ist er also naturgemäß ein
     * Zwischenstand und erst zum Jahresende endgültig. */
    /* Anspruch und genommene Tage EINES Kalenderjahres, ohne Übertrag.
     * Basis für urlaubsKonto() und für die Übertragsrechnung des Folgejahres. */
    function urlaubsJahr(empId, jahr) {
        const j = String(jahr);
        const eigene = shifts().filter(s => s.employeeId === empId && (s.date || '').slice(0, 4) === j);
        // Ein Arbeitstag ist jeder Kalendertag mit mindestens einem Einsatz —
        // unabhängig davon, wie viele Räume oder Schichten an dem Tag lagen
        // (§ 9 Rahmenvereinbarung). Deshalb ein Set über die Daten.
        const arbeitstage = new Set(eigene.filter(s => !isVacation(s)).map(s => s.date)).size;
        // EINMAL runden, auf die Stelle, in der Urlaubstage auch angezeigt
        // werden. Erst auf Cent und dann fürs Anzeigen nochmal zu runden würde
        // 0,8547 über 0,85 zu 0,8 verkürzen — der Rest ginge nicht mehr auf.
        const anspruch = roundTage(arbeitstage / URLAUB_TEILER);
        const tage = eigene.filter(isVacation).map(s => s.date).sort();
        return { anspruch, arbeitstage, genommen: tage.length, tage };
    }

    /* Urlaubskonto eines Mitarbeiters für ein Kalenderjahr, inklusive Übertrag
     * aus dem Vorjahr.
     *
     * Resturlaub des Vorjahres bleibt bis zum 30. Juni nutzbar und verfällt
     * danach. Genommene Tage zehren zuerst den Übertrag auf, weil er zuerst
     * verfällt — sonst verlöre der Mitarbeiter Tage, die er faktisch schon
     * genommen hat.
     *
     * Der Übertrag wird aus dem reinen Vorjahressaldo gebildet (Anspruch minus
     * genommen), nicht rekursiv über beliebig viele Jahre: ein Übertrag, der
     * selbst schon einmal verfallen ist, lebt nicht wieder auf.
     *
     * bezugsdatum steuert, ob der Übertrag noch gilt — normalerweise heute;
     * für Auswertungen vergangener Zeiträume kann der Aufrufer ein anderes
     * Datum setzen, damit ein altes PDF nicht plötzlich anders aussieht. */
    function urlaubsKonto(empId, jahr, bezugsdatum) {
        const j = Number(jahr);
        const heuer = urlaubsJahr(empId, j);
        const vorjahr = urlaubsJahr(empId, j - 1);
        const uebertragBrutto = Math.max(0, roundTage(vorjahr.anspruch - vorjahr.genommen));

        const stichtag = `${j}-${URLAUB_VERFALL_MMDD}`;
        const heute = bezugsdatum || todayISO();
        // Verfallen ist der Übertrag erst NACH dem Stichtag; am 30. Juni selbst
        // kann noch genommen werden.
        const uebertragVerfallen = heute > stichtag;
        const uebertrag = uebertragVerfallen ? 0 : uebertragBrutto;

        const rest = roundTage(heuer.anspruch + uebertrag - heuer.genommen);
        return {
            ...heuer,
            uebertrag,
            uebertragBrutto,
            uebertragVerfallen,
            verfallStichtag: stichtag,
            rest,
        };
    }

    /* Urlaubstage auf eine Nachkommastelle, kaufmännisch gerundet. Eigene
     * Funktion statt roundHalfUp, weil Tage nicht in Cent gemessen werden. */
    function roundTage(n) {
        return Math.round((n + Number.EPSILON) * 10) / 10;
    }

    /* Tage-Anzeige mit Komma. Nicht über toFixed(1) auf einen bereits
     * gerundeten Wert, weil 0,85 dort zu "0.8" wird. */
    function fmtTage(n) {
        return roundTage(n).toString().replace('.', ',');
    }

    function wageFor(shift) {
        /* Urlaubstage tragen keine Arbeitszeit. Ihr Betrag steht fest im
         * Datensatz (beim Eintragen aus dem 13-Wochen-Schnitt berechnet) und
         * wird NICHT neu gerechnet — sonst würde sich ein bereits gemeldeter
         * Urlaubstag rückwirkend ändern, sobald neue Schichten dazukommen. */
        if (isVacation(shift)) {
            return { minutes: 0, rate: 0, amount: Math.max(0, Number(shift.urlaubsBetrag) || 0) };
        }
        const rates = wageRatesFor(shift.date);
        const rate = shift.isDouble ? rates.double : rates.single;
        const mins = minutesOf(shift.startTime, shift.endTime);
        return { minutes: mins, rate, amount: (mins / 60) * rate };
    }

    function splitCost(shift) {
        const { amount } = wageFor(shift);
        const factorV = ABGABEN_PCT / 100;
        /* Urlaubstage hängen an keinem Raum, also greift die Raum-Aufteilung
         * nicht. Sie werden 50/50 auf die Eigentümer verteilt — dieselbe Regel
         * wie bei der Monatspauschale, die ebenfalls raumlos ist. */
        if (isVacation(shift)) {
            const half = amount / 2;
            return {
                total: amount,
                abgabenPct: ABGABEN_PCT,
                owner1: half, owner2: half,
                owner1Base: half, owner2Base: half,
                owner1Abgaben: half * factorV, owner2Abgaben: half * factorV,
                owner1Total: half * (1 + factorV), owner2Total: half * (1 + factorV),
            };
        }
        const rooms = settings().rooms || {};
        const fallback = { owner1: 50, owner2: 50 };
        const r1 = rooms[shift.room] || fallback;
        const factor = ABGABEN_PCT / 100;

        let base1, base2;
        if (!shift.isDouble) {
            base1 = amount * (r1.owner1 / 100);
            base2 = amount * (r1.owner2 / 100);
        } else {
            const r2code = shift.secondRoom || 'WS';
            const r2 = rooms[r2code] || fallback;
            base1 = amount * 0.5 * (r1.owner1 / 100) + amount * 0.5 * (r2.owner1 / 100);
            base2 = amount * 0.5 * (r1.owner2 / 100) + amount * 0.5 * (r2.owner2 / 100);
        }
        const abg1 = base1 * factor;
        const abg2 = base2 * factor;
        return {
            total: amount,
            abgabenPct: ABGABEN_PCT,
            owner1: base1,
            owner2: base2,
            owner1Base: base1,
            owner2Base: base2,
            owner1Abgaben: abg1,
            owner2Abgaben: abg2,
            owner1Total: base1 + abg1,
            owner2Total: base2 + abg2,
        };
    }

    function secondRoomOf(shift) {
        if (!shift.isDouble) return null;
        return shift.secondRoom || 'WS';
    }

    function roomsLabel(shift) {
        // Urlaubstage hängen an keinem Raum — an dieser Stelle steht das Kennwort.
        if (isVacation(shift)) return '<span class="badge urlaub">Urlaub</span>';
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

    /* Beschreibt IDLE_TIMEOUT_MS in Worten für den Abmelde-Hinweis. Wird aus der
     * Konstante abgeleitet, damit Text und tatsächliche Frist nicht auseinander-
     * laufen, wenn der Wert später angepasst wird. */
    function idleTimeoutLabel() {
        const sec = Math.round(IDLE_TIMEOUT_MS / 1000);
        if (sec % 60 !== 0) return `${sec} Sekunden`;
        const min = sec / 60;
        return min === 1 ? 'einer Minute' : `${min} Minuten`;
    }

    function resetIdleTimer() {
        if (!state.user) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            toast(`Automatisch abgemeldet nach ${idleTimeoutLabel()} Inaktivität.`, 'info');
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
        if (name === 'enter')     { refreshShiftEmpSelect(); renderShiftFormMode(); }
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
        // Satz, der am gewählten Schicht-Datum gilt (nicht der aktuellste).
        const rates = wageRatesFor($('#sfDate').value || todayISO());
        const rate = isD ? rates.double : rates.single;
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
            // Urlaubstage haben keine Uhrzeiten — sie können sich mit nichts
            // zeitlich überschneiden. Der Konflikt „Schicht am Urlaubstag" wird
            // separat beim Speichern geprüft, nicht hier über Minuten.
            if (isVacation(s)) continue;
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
        /* An einem Urlaubstag kann nicht zusätzlich gearbeitet werden — sonst
         * stünden Urlaubsentgelt und Schichtlohn für denselben Tag nebeneinander
         * und das Brutto wäre doppelt belegt. Hier statt an den Aufrufstellen,
         * damit alle Wege (Komplett-Speichern, Bearbeiten, Schicht starten)
         * dieselbe Regel bekommen. */
        if (shifts().some(s => isVacation(s) && s.employeeId === p.employeeId && s.date === p.date)) {
            return 'Für diesen Tag ist Urlaub eingetragen — bitte erst den Urlaubstag entfernen.';
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
        // Popup wird NICHT mehr im Login-View gezeigt — der Marker liegt
        // jetzt pro Mitarbeiter und kann erst nach erfolgreichem Login
        // ausgewertet werden (siehe maybeShowDsgvoConsent in enterApp).
    }

    /* DSGVO-Hinweis als Pflicht-Modal beim ersten Login JEDES Mitarbeiters.
     * Marker pro User-ID — die Bestätigung eines Nutzers entlässt nicht automatisch
     * andere Mitarbeiter. Inhalt wird dynamisch passend zu den aktiven
     * Sicherungen befüllt. */
    function maybeShowDsgvoConsent() {
        if (!state.user) return false;
        const modal = $('#dsgvoConsentModal');
        if (!modal) return false;
        if (window.ParaloxStorage.getDsgvoAccepted(state.user.id)) {
            modal.classList.add('hidden');
            return false;
        }
        renderDsgvoNotice();
        // Bestätigungs-Modus: nur "Verstanden, weiter" sichtbar.
        $('#dsgvoConsentBtn').classList.remove('hidden');
        $('#dsgvoCloseBtn').classList.add('hidden');
        modal.classList.remove('hidden');
        return true;
    }

    /* Jährliche Resturlaubs-Erinnerung.
     *
     * Fenster: ab dem 30. März bis zum 30. Juni desselben Jahres. Bewusst ein
     * Zeitraum statt genau des 30. März — wer an dem Tag nicht arbeitet, würde
     * die Erinnerung sonst nie zu sehen bekommen. Gezeigt wird sie trotzdem nur
     * EINMAL pro Mitarbeiter und Jahr: der erste Login ab dem 30. März.
     *
     * Gilt für JEDEN eingeloggten User — auch Buchhaltung und Admins. Die
     * Buchhaltungs-Rolle ist keine reine Fremdrolle: diese Leute arbeiten selbst
     * mit und erfassen eigene Schichten, haben also ebenso Urlaubsanspruch. */
    const VACATION_REMINDER_FROM  = '03-30';
    const VACATION_REMINDER_UNTIL = '06-30';

    function vacationReminderDue() {
        if (!state.user) return false;
        const today = todayISO();               // YYYY-MM-DD
        const year = today.slice(0, 4);
        const monthDay = today.slice(5);
        if (monthDay < VACATION_REMINDER_FROM || monthDay > VACATION_REMINDER_UNTIL) return false;
        // Quittierung zählt nur für das Jahr, in dem sie erfolgt ist.
        const ack = window.ParaloxStorage.getVacationReminderAck(state.user.id);
        if (ack && ack.slice(0, 4) === year) return false;
        /* Nur wer wirklich noch etwas zu verlieren hat. Vor der Urlaubsführung
         * konnte die App das nicht wissen und hat pauschal alle erinnert; jetzt
         * kennt sie den Übertrag und behelligt niemanden ohne offene Tage. */
        return offenerUebertrag(state.user.id) > 0;
    }

    /* Noch offener Urlaub aus dem VORJAHR — das ist der Teil, der zum 30. Juni
     * verfällt. Der Anspruch des laufenden Jahres bleibt davon unberührt und
     * ist deshalb kein Grund für die Erinnerung. */
    function offenerUebertrag(empId) {
        const jahr = Number(todayISO().slice(0, 4));
        return urlaubsKonto(empId, jahr).uebertrag;
    }

    function maybeShowVacationReminder() {
        const modal = $('#vacationReminderModal');
        if (!modal) return false;
        if (!vacationReminderDue()) {
            modal.classList.add('hidden');
            return false;
        }
        const year = Number(todayISO().slice(0, 4));
        const k = urlaubsKonto(state.user.id, year);
        const tage = fmtTage(k.uebertrag);
        const wort = k.uebertrag === 1 ? 'Urlaubstag' : 'Urlaubstage';
        $('#vacationReminderText').innerHTML =
            `<p>Hallo ${escapeHtml(state.user.name)},</p>` +
            `<p>aus ${year - 1} hast du noch <strong>${tage} ${wort}</strong> offen. ` +
            `Diese musst du <strong>bis zum 30. Juni ${year}</strong> nehmen — danach <strong>verfallen</strong> sie.</p>` +
            `<p>Dein Anspruch für ${year} wächst davon unabhängig weiter und verfällt erst zum 30. Juni ${year + 1}.</p>` +
            '<p>Bitte sprich deine Urlaubsplanung rechtzeitig mit der Betriebsleitung ab.</p>';
        modal.classList.remove('hidden');
        return true;
    }

    /* Read-only-Variante: zeigt den aktuellen Datenschutz-Hinweis-Text,
     * ohne Marker zu setzen. Aufgerufen aus dem Settings-Knopf — gedacht
     * fürs Nachschlagen, ohne dass irgendwer (du oder Mitarbeiter) erneut
     * bestätigen muss. */
    function showDsgvoNoticeReadOnly() {
        const modal = $('#dsgvoConsentModal');
        if (!modal) return;
        renderDsgvoNotice();
        $('#dsgvoConsentBtn').classList.add('hidden');
        $('#dsgvoCloseBtn').classList.remove('hidden');
        modal.classList.remove('hidden');
    }

    /* Befüllt #dsgvoNotice (im Consent-Modal) mit dem auf die aktuellen
     * Sicherungs-Einstellungen abgestimmten Text. Verantwortliche Stelle
     * kommt aus settings.dataController — wird vom Admin in Settings
     * gepflegt, damit der Quellcode keine Adressen leakt. Wenn leer:
     * "Verantwortlich"-Zeile wird ausgelassen statt Müll anzuzeigen. */
    function renderDsgvoNotice() {
        const el = $('#dsgvoNotice');
        if (!el) return;
        const cfg = settings()?.dailyBackup || {};
        const mcfg = settings()?.monthlyArchive || {};
        const dataController = (settings()?.dataController || '').trim();
        const verantwortlichLine = dataController
            ? `<p>Verantwortlich: ${escapeHtml(dataController)}</p>`
            : '';
        const dailyOn = !!cfg.enabled;
        const monthlyOn = !!mcfg.enabled;

        if (!dailyOn && !monthlyOn) {
            el.innerHTML =
                '<p>Die erfassten Arbeitszeiten werden ausschließlich lokal auf diesem Gerät gespeichert. Es findet keine Übertragung an externe Dienste statt. Die Daten werden ausschließlich zur internen Lohnabrechnung verwendet und nicht an Dritte weitergegeben.</p>' +
                verantwortlichLine;
            return;
        }

        const recipient = (cfg.recipient || '').trim();
        const mrecipient = (mcfg.recipient || '').trim();
        const sameRecipient = recipient && mrecipient && recipient === mrecipient;

        let html = '<p>Die erfassten Arbeitszeiten werden lokal auf diesem Gerät gespeichert.</p>';
        if (dailyOn) {
            html += '<p><strong>Tagessicherung per E-Mail (aktiv):</strong> Einmal pro Tag wird beim ersten Login eine Backup-Datei (JSON + CSV) mit allen erfassten Daten (Mitarbeiternamen, Arbeitszeiten, Lohn-Einstellungen) als Anhang einer E-Mail an ' +
                `<strong>${escapeHtml(recipient || '— nicht konfiguriert —')}</strong>` +
                ' versendet.</p>';
        }
        if (monthlyOn) {
            html += '<p><strong>Monatsabschluss per E-Mail (aktiv):</strong> Einmal pro Monat wird beim ersten Login eines neuen Monats eine Mail mit Minijob-PDF (Lohnabrechnungs-Übersicht pro Mitarbeiter), CSV-Auswertung des Vormonats und Backup-JSON ' +
                (sameRecipient ? 'an dieselbe Adresse versendet' :
                    `an <strong>${escapeHtml(mrecipient || '— nicht konfiguriert —')}</strong> versendet`) +
                '. Diese Mail dient der Aufbewahrungspflicht für Lohnunterlagen (10 Jahre, § 147 AO).</p>';
        }
        html += '<p>Die Backup-Anhänge werden vor dem Versand clientseitig mit AES-256 verschlüsselt — der Mail-Anbieter (1&amp;1 Mail &amp; Media GmbH / GMX, Deutschland) hat keinen Klartext-Zugriff. Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an der Datensicherung gegen Geräteverlust und an der gesetzlichen Aufbewahrungspflicht). Die Daten werden ausschließlich zur internen Lohnabrechnung verwendet und nicht an Dritte weitergegeben.</p>';
        html += verantwortlichLine;
        el.innerHTML = html;
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

    /* Passwort-Feld beim Namens-Wechsel leeren — sonst füllt der Browser
     * blindlings das zuletzt gespeicherte Passwort ein, egal welcher User
     * im Dropdown gewählt wurde. So muss man bei einem anderen Mitarbeiter
     * aktiv das richtige Passwort eintippen. Auch sichtbare Fehlermeldung
     * vom letzten Versuch wird ausgeblendet. */
    $('#loginName').addEventListener('change', () => {
        $('#loginPassword').value = '';
        $('#loginError').classList.add('hidden');
    });

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
        // Sicherungen beim ersten Login eines neuen Tages bzw. Monats:
        // Tagessicherung zuerst, danach Monatsabschluss (sequentiell, sonst
        // würden zwei Share-Dialoge konkurrieren). Web Share braucht User
        // Activation — der Login-Submit liefert sie. Asynchron, damit das
        // Form schon umgeschaltet hat.
        (async () => {
            await runDailyBackup({ force: false });
            await runMonthlyArchive({ force: false });
        })();
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

        refreshShiftEmpSelect();
        renderShiftFormMode();
        // Nach renderShiftFormMode(), damit eine laufende Schicht Vorrang behält
        // und ihre Felder nicht vom Entwurf überschrieben werden.
        if (restoreShiftDraft()) {
            toast('Angefangene Eingabe wiederhergestellt.', 'info');
        }

        renderPreview();
        buildTabs();
        startIdleTimer();
        // DSGVO-Pflicht-Popup für diesen Mitarbeiter, falls noch nicht
        // bestätigt. Ohne Bestätigung ist die App zwar geöffnet, aber das
        // Modal liegt darüber und blockiert die Bedienung.
        // Beide Pflicht-Modals würden sich überlagern — deshalb kommt die
        // Resturlaubs-Erinnerung erst, wenn kein DSGVO-Consent offen ist
        // (sonst zeigt sie der DSGVO-Button nach seiner Bestätigung).
        if (!maybeShowDsgvoConsent()) maybeShowVacationReminder();
    }

    /* Stellt das "Neue Schicht"-Formular auf "Beenden"-Modus um, falls der
     * eingeloggte User eine offene Schicht hat — sonst zurück auf den
     * normalen "Starten / Komplett speichern"-Modus. Aktualisiert auch den
     * pulsierenden Indikator in der Topbar. Aufgerufen aus enterApp(), beim
     * Tab-Wechsel auf 'enter' und nach Start/Beenden einer Schicht. */
    function renderShiftFormMode() {
        const open = state.user
            ? window.ParaloxStorage.getRunningShift(state.user.id)
            : null;
        const banner = $('#runningShiftBanner');
        const indicator = $('#topRunningIndicator');
        const startBtn = $('#sfStartBtn');
        const saveBtn = $('#sfSaveBtn');
        const endBtn = $('#sfEndBtn');
        const empWrap = $('#sfEmpWrap');
        const dateIn = $('#sfDate');
        const startIn = $('#sfStart');
        const endIn = $('#sfEnd');
        const roomIn = $('#sfRoom');
        const room2In = $('#sfRoom2');
        const doubleIn = $('#sfDouble');
        const noteIn = $('#sfNote');

        if (open) {
            // Beenden-Modus: vorhandene Felder aus der laufenden Schicht setzen,
            // Beginn/Datum/Raum read-only. Doppelüberwachung darf der Mitarbeiter
            // beim Beenden noch ändern (zweiter Raum kann später dazugekommen sein).
            const roomLabel = (settings().rooms?.[open.room]?.name) || open.room;
            banner.innerHTML =
                '<strong>🟢 Deine Schicht läuft</strong> seit ' +
                `${escapeHtml(fmtDateDE(open.date))} um ${escapeHtml(open.startTime)} ` +
                `in Raum <strong>${escapeHtml(roomLabel)}</strong>.` +
                `<div class="running-meta">Gestartet ${fmtDateTimeDE(open.startedAt)}. ` +
                'Trage unten die Endezeit ein und tippe „Schicht beenden".</div>';
            banner.classList.remove('hidden');
            dateIn.value = open.date;
            startIn.value = open.startTime;
            roomIn.value = open.room;
            doubleIn.checked = !!open.isDouble;
            refreshShiftRoomSelects();
            if (open.isDouble && open.secondRoom) room2In.value = open.secondRoom;
            noteIn.value = open.note || '';
            // Einsperren der Start-Felder, Ende soll der einzige aktiv editierbare
            // Pflicht-Eintrag sein.
            dateIn.disabled = true;
            startIn.disabled = true;
            roomIn.disabled = true;
            endIn.required = true;
            // Mitarbeiter-Dropdown ausblenden — Beenden gilt immer für sich selbst
            empWrap.classList.add('hidden');
            startBtn.classList.add('hidden');
            saveBtn.classList.add('hidden');
            endBtn.classList.remove('hidden');

            indicator.textContent = `Schicht läuft seit ${open.startTime}`;
            indicator.title = `Seit ${fmtDateDE(open.date)} ${open.startTime} in ${roomLabel} — klicken um zu beenden`;
            indicator.classList.remove('hidden');
        } else {
            // Normalmodus: zwei Buttons, Start- und Komplett-Speichern.
            banner.classList.add('hidden');
            banner.innerHTML = '';
            dateIn.disabled = false;
            startIn.disabled = false;
            roomIn.disabled = false;
            endIn.required = false;
            // Datum nur für Admin frei wählbar (heutige Mitarbeiter dürfen
            // nur den heutigen Tag erfassen — wird in enterApp() gesetzt).
            startBtn.classList.remove('hidden');
            saveBtn.classList.remove('hidden');
            endBtn.classList.add('hidden');
            // Admin-Mitarbeiter-Dropdown im Normalmodus wieder anzeigen
            refreshShiftEmpSelect();

            indicator.classList.add('hidden');
            indicator.textContent = '';
        }
        renderPreview();
    }

    /* ---------- Formular-Entwurf ----------
     *
     * Mitarbeiter tragen den Beginn oft zu Schichtbeginn ein und die Endezeit
     * erst Stunden später. Dazwischen greift der Auto-Logout und lädt die Seite
     * neu — ohne Sicherung wäre die angefangene Eingabe weg. Der Entwurf wird
     * deshalb bei jeder Änderung gerätelokal abgelegt und beim nächsten Login
     * zurückgeholt. Er ist ausdrücklich KEINE erfasste Schicht: er taucht in
     * keiner Auswertung, keinem Export und keinem Backup auf.
     *
     * Der saubere Weg für diesen Ablauf bleibt "Schicht starten" — der Entwurf
     * ist nur das Netz für alle, die stattdessen direkt ins Formular tippen. */

    /* Liest den aktuellen Formularstand. Der Entwurf gehört immer dem
     * eingeloggten User, nicht dem im Admin-Dropdown gewählten Mitarbeiter:
     * sonst bekäme beim nächsten Login der Falsche die Eingabe vorgesetzt. */
    function currentShiftDraft() {
        return {
            date: $('#sfDate').value,
            startTime: $('#sfStart').value,
            endTime: $('#sfEnd').value,
            room: $('#sfRoom').value,
            isDouble: $('#sfDouble').checked,
            secondRoom: $('#sfRoom2').value,
            note: $('#sfNote').value,
            savedAt: new Date().toISOString(),
        };
    }

    /* Ein Entwurf lohnt sich nur, wenn wirklich etwas eingetippt wurde. Das
     * Datum zählt dabei nicht: es steht nach dem Login ohnehin auf heute und
     * würde sonst jeden leeren Formularstand als Entwurf sichern. */
    function draftHasContent(d) {
        return !!(d.startTime || d.endTime || d.room || d.note || d.isDouble);
    }

    function saveShiftDraft() {
        if (!state.user) return;
        // Im Beenden-Modus führt die laufende Schicht — die ist bereits
        // dauerhaft gespeichert und braucht keinen zusätzlichen Entwurf.
        if (window.ParaloxStorage.getRunningShift(state.user.id)) return;
        const d = currentShiftDraft();
        window.ParaloxStorage.setShiftDraft(state.user.id, draftHasContent(d) ? d : null);
    }

    function dropShiftDraft() {
        if (!state.user) return;
        window.ParaloxStorage.clearShiftDraft(state.user.id);
    }

    /* Holt einen gesicherten Entwurf ins Formular zurück. Läuft nur im
     * Normalmodus — bei laufender Schicht hat renderShiftFormMode() die Felder
     * bereits aus der offenen Schicht belegt und darf nicht überschrieben
     * werden. Ein Entwurf von einem früheren Tag wird verworfen: die Schicht
     * von gestern nachträglich zu speichern wäre fast immer falsch, und
     * Nicht-Admins dürfen ohnehin nur den heutigen Tag erfassen. */
    function restoreShiftDraft() {
        if (!state.user) return false;
        if (window.ParaloxStorage.getRunningShift(state.user.id)) return false;
        const d = window.ParaloxStorage.getShiftDraft(state.user.id);
        if (!d) return false;
        if (d.date && d.date !== todayISO()) { dropShiftDraft(); return false; }

        if (d.date) $('#sfDate').value = d.date;
        $('#sfStart').value = d.startTime || '';
        $('#sfEnd').value = d.endTime || '';
        $('#sfNote').value = d.note || '';
        $('#sfDouble').checked = !!d.isDouble;
        // Erst den 1. Raum setzen, dann die Auswahllisten auffrischen — sonst
        // filtert refreshShiftRoomSelects() den 2. Raum gegen einen leeren
        // ersten. Gleiche Reihenfolge wie im Beenden-Modus.
        if (d.room) $('#sfRoom').value = d.room;
        refreshShiftRoomSelects();
        if (d.isDouble && d.secondRoom) $('#sfRoom2').value = d.secondRoom;
        renderPreview();
        return true;
    }

    /* Befüllt das Mitarbeiter-Dropdown im "Neue Schicht"-Formular für Admins.
     * Muss nach JEDER Änderung an der Mitarbeiter-Liste neu laufen — nicht
     * nur einmal beim Login —, sonst fehlen frisch angelegte Mitarbeiter im
     * Dropdown bis zum nächsten Login. Aktuell aufgerufen aus enterApp(),
     * beim Tab-Wechsel auf 'enter' und nach jedem Mitarbeiter-Anlegen.
     * Default-Auswahl: der eingeloggte Admin selbst, damit nicht
     * versehentlich auf einen falschen Mitarbeiter verbucht wird. */
    function refreshShiftEmpSelect() {
        const empWrap = $('#sfEmpWrap');
        const empSel = $('#sfEmp');
        if (!empWrap || !empSel) return;
        if (!isAdmin()) {
            empWrap.classList.add('hidden');
            return;
        }
        const prev = empSel.value;
        empSel.innerHTML = '';
        [...employees()]
            .filter(e => e.isActive)
            .sort((a, b) => a.name.localeCompare(b.name, 'de'))
            .forEach(e => {
                const o = document.createElement('option');
                o.value = e.id;
                o.textContent = e.name;
                empSel.appendChild(o);
            });
        const stillExists = [...empSel.options].some(o => o.value === prev);
        empSel.value = stillExists && prev ? prev : String(state.user.id);
        empWrap.classList.remove('hidden');
    }

    $('#btnLogout').addEventListener('click', doLogout);

    // DSGVO-Consent-Modal: einmal pro Mitarbeiter bestätigen, dann Marker
    // für diese User-ID setzen und schließen.
    $('#dsgvoConsentBtn')?.addEventListener('click', () => {
        if (state.user) {
            window.ParaloxStorage.setDsgvoAccepted(state.user.id, new Date().toISOString());
        }
        $('#dsgvoConsentModal').classList.add('hidden');
        // Erst jetzt ist die Sicht frei für die Resturlaubs-Erinnerung.
        maybeShowVacationReminder();
    });

    /* "Gelesen und verstanden" — Kenntnisnahme für dieses Jahr festhalten.
     * Der Zeitstempel ist zugleich der Nachweis, wann der Mitarbeiter auf den
     * Verfall hingewiesen wurde. */
    $('#vacationReminderBtn')?.addEventListener('click', () => {
        if (state.user) {
            window.ParaloxStorage.setVacationReminderAck(state.user.id, new Date().toISOString());
        }
        $('#vacationReminderModal').classList.add('hidden');
    });

    // Read-only "Schließen": setzt nichts, blendet das Modal nur weg.
    $('#dsgvoCloseBtn')?.addEventListener('click', () => {
        $('#dsgvoConsentModal').classList.add('hidden');
        // Default-Modus für nächsten Aufruf wiederherstellen
        $('#dsgvoConsentBtn').classList.remove('hidden');
        $('#dsgvoCloseBtn').classList.add('hidden');
    });
    // Settings-Knopf "Datenschutz-Hinweis ansehen" — read-only-Anzeige
    $('#settingsShowDsgvo')?.addEventListener('click', () => {
        showDsgvoNoticeReadOnly();
    });

    // ---------- Shift Form ----------

    // sfDate ist mit dabei, weil der gültige Stundensatz jetzt vom Schicht-Datum
    // abhängt (Lohnhistorie) — die Vorschau muss bei Datumswechsel neu rechnen.
    ['sfStart','sfEnd','sfDouble','sfDate'].forEach(id => {
        $('#' + id).addEventListener('change', renderPreview);
        $('#' + id).addEventListener('input', renderPreview);
    });
    $('#sfDouble').addEventListener('change', () => { refreshShiftRoomSelects(); renderPreview(); });
    $('#sfRoom').addEventListener('change',  () => { if ($('#sfDouble').checked) refreshShiftRoomSelects(); });
    $('#sfRoom2').addEventListener('change', () => { refreshShiftRoomSelects(); });

    // Jede Eingabe sichert den Entwurf — nur so überlebt eine halbfertige
    // Schicht den Auto-Logout, der genau in diese Lücke fällt.
    ['sfDate','sfStart','sfEnd','sfRoom','sfRoom2','sfDouble','sfNote'].forEach(id => {
        $('#' + id).addEventListener('change', saveShiftDraft);
        $('#' + id).addEventListener('input', saveShiftDraft);
    });

    $('#shiftForm').addEventListener('submit', (ev) => {
        ev.preventDefault();
        // Wenn der eingeloggte User eine offene Schicht hat, ist das Form
        // im Beenden-Modus — der Submit darf NICHT als Komplett-Speichern
        // durchgehen. Submit-Verhalten wird vom "Schicht beenden"-Button
        // gehandhabt (eigener Click-Listener weiter unten).
        if (state.user && window.ParaloxStorage.getRunningShift(state.user.id)) {
            return;
        }
        const btn = ev.submitter || $('#shiftForm button[type="submit"]');
        if (btn && btn.disabled) return;
        const isD = $('#sfDouble').checked;
        // Admins dürfen Schichten für beliebige Mitarbeiter erfassen
        // (sfEmp-Dropdown). Sonst gilt immer der eingeloggte User.
        const targetEmpId = isAdmin() && $('#sfEmp').value
            ? Number($('#sfEmp').value)
            : state.user.id;
        const payload = {
            employeeId: targetEmpId,
            date: $('#sfDate').value,
            startTime: $('#sfStart').value,
            endTime: $('#sfEnd').value,
            room: $('#sfRoom').value,
            isDouble: isD,
            secondRoom: isD ? $('#sfRoom2').value : null,
            note: $('#sfNote').value,
        };
        if (!payload.endTime) {
            toast('Bitte ein Ende eintragen — oder „Schicht starten" für eine offene Schicht.', 'error');
            return;
        }
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
        // Schicht ist erfasst — der Entwurf hat seinen Zweck erfüllt.
        dropShiftDraft();
        const savedForOther = isAdmin() && targetEmpId !== state.user.id;
        toast(savedForOther
            ? `Schicht für ${empName(targetEmpId)} gespeichert`
            : 'Schicht gespeichert', 'success');
        $('#sfDate').value = todayISO();
        $('#sfStart').value = '';
        $('#sfEnd').value = '';
        $('#sfNote').value = '';
        $('#sfDouble').checked = false;
        // Mitarbeiter-Dropdown wieder auf den eingeloggten Admin zurücksetzen,
        // damit nicht versehentlich die nächste Schicht für jemand anderen läuft.
        if (isAdmin()) $('#sfEmp').value = state.user.id;
        refreshShiftRoomSelects();
        // Beide Raum-Felder leeren, bis der Nutzer wieder wählt
        $('#sfRoom').value  = '';
        $('#sfRoom2').value = '';
        renderPreview();
        if (state.activeTab === 'mine') renderMine();
    });

    /* "Schicht starten" — speichert Datum + Beginn + Raum als laufende
     * Schicht im localStorage. Funktioniert nur für den eingeloggten User
     * (kein Starten für andere via Mitarbeiter-Dropdown). Voraussetzung:
     * für diesen User darf noch keine andere offene Schicht existieren.
     * Heute, Beginn und Raum sind Pflicht; Doppelüberwachung optional. */
    $('#sfStartBtn').addEventListener('click', () => {
        if (!state.user) return;
        if (window.ParaloxStorage.getRunningShift(state.user.id)) {
            toast('Du hast bereits eine offene Schicht — bitte erst beenden.', 'error');
            renderShiftFormMode();
            return;
        }
        const isD = $('#sfDouble').checked;
        const data = {
            date: $('#sfDate').value,
            startTime: $('#sfStart').value,
            room: $('#sfRoom').value,
            isDouble: isD,
            secondRoom: isD ? $('#sfRoom2').value : null,
            note: $('#sfNote').value,
            startedAt: new Date().toISOString(),
        };
        if (!validDate(data.date)) { toast('Ungültiges Datum.', 'error'); return; }
        if (!validTime(data.startTime)) { toast('Bitte einen gültigen Beginn eintragen.', 'error'); return; }
        const rooms = settings().rooms || {};
        if (!rooms[data.room]) { toast('Bitte einen Raum wählen.', 'error'); return; }
        if (isD && (!rooms[data.secondRoom] || data.secondRoom === data.room)) {
            toast('Zweiter Raum ungültig.', 'error');
            return;
        }
        if (!isAdmin()) {
            const today = todayISO();
            if (data.date !== today) {
                toast('Schicht darf nur am heutigen Tag gestartet werden.', 'error');
                return;
            }
        }
        window.ParaloxStorage.setRunningShift(state.user.id, data);
        // Ab jetzt führt die laufende Schicht; ein Entwurf daneben wäre
        // doppelt gehalten und könnte beim Beenden dazwischenfunken.
        dropShiftDraft();
        toast('Schicht gestartet — viel Erfolg!', 'success');
        renderShiftFormMode();
    });

    /* "Schicht beenden" — übernimmt Beginn/Datum/Raum aus der laufenden
     * Schicht, ergänzt um die jetzt eingegebene End-Zeit (und ggf. später
     * gewählte Doppelüberwachung), schreibt eine fertige Schicht in die
     * Datenbank und löscht den Running-Marker. */
    $('#sfEndBtn').addEventListener('click', () => {
        if (!state.user) return;
        const open = window.ParaloxStorage.getRunningShift(state.user.id);
        if (!open) { renderShiftFormMode(); return; }
        const isD = $('#sfDouble').checked;
        const payload = {
            employeeId: state.user.id,
            date: open.date,
            startTime: open.startTime,
            endTime: $('#sfEnd').value,
            room: open.room,
            isDouble: isD,
            // Beim Beenden darf der zweite Raum noch nachgetragen werden
            secondRoom: isD ? $('#sfRoom2').value : null,
            note: $('#sfNote').value,
        };
        if (!payload.endTime) { toast('Bitte ein Ende eintragen.', 'error'); return; }
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
        window.ParaloxStorage.clearRunningShift(state.user.id);
        dropShiftDraft();
        toast('Schicht beendet und gespeichert', 'success');
        // Form leeren + zurück in den Normal-Modus
        $('#sfDate').value = todayISO();
        $('#sfStart').value = '';
        $('#sfEnd').value = '';
        $('#sfNote').value = '';
        $('#sfDouble').checked = false;
        $('#sfRoom').value  = '';
        $('#sfRoom2').value = '';
        refreshShiftRoomSelects();
        renderShiftFormMode();
        if (state.activeTab === 'mine') renderMine();
    });

    /* Klick auf den pulsierenden "Schicht läuft"-Indikator in der Topbar
     * → wechselt zum Schicht-Tab, damit der Mitarbeiter direkt das Ende
     * eintragen kann. */
    $('#topRunningIndicator').addEventListener('click', () => {
        switchTab('enter');
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

    function fillYearMonthSelects(yearSelId, monthSelId, sourceFn = shifts) {
        const ySel = $(yearSelId);
        const mSel = $(monthSelId);
        const prevY = ySel.value;
        const prevM = mSel.value;

        // Jahre aus den für den Aufrufer relevanten Schichten plus aktuelles Jahr
        const yearSet = new Set();
        const cur = new Date().getFullYear();
        yearSet.add(cur);
        yearSet.add(cur - 1);
        sourceFn().forEach(s => { const y = s.date.slice(0, 4); if (y) yearSet.add(Number(y)); });
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
        const myId = state.user?.id;
        let yearAmt = 0, monthAmt = 0;
        // Monate des laufenden Jahres mit ≥1 Schicht sammeln — nur dort besteht
        // ein Pauschalenanspruch (analog Admin/„Meine Stunden": keine Pauschale
        // ohne Schicht, die App führt keine Urlaub/Krankheit-Listen).
        const yearMonths = new Set();
        list.forEach(s => {
            const a = wageFor(s).amount;
            if (s.date.startsWith(String(year) + '-')) { yearAmt += a; yearMonths.add(s.date.slice(0, 7)); }
            if (s.date.startsWith(monthKey)) monthAmt += a;
        });
        // Monatspauschale gehört zum Brutto und zählt damit zur Minijob-Grenze —
        // deshalb hier in Monats- und Jahresbetrag einrechnen. monatspauschaleForMonth
        // berücksichtigt den Stichtag pauschaleAb (Monate davor tragen 0 bei).
        yearMonths.forEach(m => { yearAmt += monatspauschaleForMonth(myId, m); });
        if (yearMonths.has(monthKey)) monthAmt += monatspauschaleForMonth(myId, monthKey);

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
        // Jahresliste nur aus eigenen Schichten — auch für Buchhaltungs-Konten
        // bleibt „Meine Stunden" unbegrenzt sichtbar (kein 90-Tage-Cap).
        fillYearMonthSelects('#mineYear', '#mineMonth', mineShifts);
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
            tr.dataset.id = s.id;
            tr.innerHTML = `
                <td>${fmtDateDE(s.date)}</td>
                <td>${isVacation(s) ? '<span class="muted">–</span>' : s.startTime}</td>
                <td>${isVacation(s) ? '<span class="muted">–</span>' : s.endTime}</td>
                <td class="num">${isVacation(s) ? '<span class="muted">–</span>' : fmtHours(w.minutes)}</td>
                <td>${roomsLabel(s)}</td>
                <td>${isVacation(s)
                        ? '<span class="badge urlaub">Urlaub</span>'
                        : (s.isDouble ? '<span class="badge double">Doppel</span>' : '<span class="badge muted">Einfach</span>')}</td>
                <td class="num">${fmtEUR(w.amount)}</td>
                <td>${escapeHtml(s.note || '')}</td>
                <td>${canDelete && !isVacation(s)
                    ? `<button class="btn small danger" data-del="${s.id}">Löschen</button>`
                    : `<span class="muted small" title="${isVacation(s) ? 'Urlaub trägt der Admin ein' : 'Nur am selben Tag möglich'}">–</span>`}</td>
            `;
            tbody.appendChild(tr);
        });
        if (!list.length) {
            tbody.innerHTML = `<tr><td colspan="9" class="muted" style="text-align:center;padding:2rem">Keine Einträge in diesem Zeitraum</td></tr>`;
        }
        // Monatspauschale: nur wenn beim eigenen User > 0 hinterlegt UND es im
        // gefilterten Zeitraum tatsächlich Schichten gab (sonst kein Lohnanspruch
        // aus Pauschale). Krankheitstage führt die App weiterhin nicht.
        const myId = state.user?.id;
        let summaryOut = summaryHtml(list.length, totalMin, totalAmt);
        if (list.length) {
            // Pro Monat einzeln aufsummieren, damit der Stichtag (pauschaleAb)
            // greift und Monate vor dem Stichtag keine Pauschale beitragen.
            const monthsWithShifts = [...new Set(list.map(s => (s.date || '').slice(0, 7)))];
            let pauschaleTotal = 0, pauschaleMonate = 0;
            monthsWithShifts.forEach(m => {
                const ps = monatspauschaleForMonth(myId, m);
                if (ps > 0) { pauschaleTotal += ps; pauschaleMonate += 1; }
            });
            if (pauschaleTotal > 0) {
                const bruttoMitPauschale = totalAmt + pauschaleTotal;
                summaryOut +=
                    `<div class="stat"><div class="label">Pauschale (${pauschaleMonate} ${pauschaleMonate === 1 ? 'Monat' : 'Monate'})</div><div class="value">${fmtEUR(pauschaleTotal)}</div></div>` +
                    `<div class="stat"><div class="label">Brutto inkl. Pauschale</div><div class="value">${fmtEUR(bruttoMitPauschale)}</div></div>`;
            }
        }
        /* Urlaubs-Restkonto des angezeigten Jahres. Bezugsjahr ist das gefilterte
         * Jahr, sonst das laufende — das Konto ist eine Jahresgröße und hat mit
         * dem Monatsfilter nichts zu tun. */
        const uJahr = Number(readPeriodYear('#mineYear')) || new Date().getFullYear();
        const uKonto = urlaubsKonto(myId, uJahr);
        if (uKonto.anspruch > 0 || uKonto.genommen > 0 || uKonto.uebertragBrutto > 0) {
            summaryOut +=
                `<div class="stat"><div class="label">Urlaub ${uJahr} genommen</div>` +
                `<div class="value">${uKonto.genommen} von ${fmtTage(uKonto.anspruch)}</div></div>`;
            if (uKonto.uebertrag > 0) {
                summaryOut +=
                    `<div class="stat"><div class="label">Übertrag aus ${uJahr - 1}` +
                    `<br><span class="small">verfällt 30.06.</span></div>` +
                    `<div class="value">${fmtTage(uKonto.uebertrag)} Tage</div></div>`;
            }
            summaryOut +=
                `<div class="stat"><div class="label">Urlaub übrig</div>` +
                `<div class="value">${fmtTage(uKonto.rest)} Tage</div></div>`;
        }
        $('#mineSummary').innerHTML = summaryOut;
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
        const o1 = owner1Label(), o2 = owner2Label();
        return summaryHtml(count, minutes, amount) +
            `<div class="stat"><div class="label">Kosten ${escapeHtml(o1)}</div><div class="value">${fmtEUR(agg.sBase)}</div></div>` +
            `<div class="stat"><div class="label">Abgaben ${escapeHtml(o1)} (${pctStr}%)</div><div class="value">${fmtEUR(agg.sAbg)}</div></div>` +
            `<div class="stat"><div class="label">Gesamt ${escapeHtml(o1)}</div><div class="value">${fmtEUR(agg.sTotal)}</div></div>` +
            `<div class="stat"><div class="label">Kosten ${escapeHtml(o2)}</div><div class="value">${fmtEUR(agg.bBase)}</div></div>` +
            `<div class="stat"><div class="label">Abgaben ${escapeHtml(o2)} (${pctStr}%)</div><div class="value">${fmtEUR(agg.bAbg)}</div></div>` +
            `<div class="stat"><div class="label">Gesamt ${escapeHtml(o2)}</div><div class="value">${fmtEUR(agg.bTotal)}</div></div>`;
    }

    $('#mineYear').addEventListener('change', renderMine);
    $('#mineMonth').addEventListener('change', renderMine);
    $('#mineReset').addEventListener('click', () => {
        $('#mineYear').value = '';
        $('#mineMonth').value = '';
        renderMine();
    });

    // ---------- Admin: Alle Schichten ----------

    /* Schichten, die der eingeloggte User in der Stundenliste/den Exporten
     * sehen darf. Admin = alles, Buchhaltung = letzte 90 Tage, sonst nur
     * eigene (wird in der UI bereits durch fehlenden Tab abgesichert,
     * dient hier zusätzlich als Defense-in-Depth). */
    function viewableShifts() {
        if (isAdmin()) return shifts();
        if (state.user?.isAccountant) {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - VIEW_DAYS_LIMIT_ACCOUNTANT);
            const cutoffISO = cutoff.toISOString().slice(0, 10);
            return shifts().filter(s => s.date >= cutoffISO);
        }
        return shifts().filter(s => s.employeeId === state.user?.id);
    }

    function adminSortedShifts() {
        return [...viewableShifts()].sort((a, b) =>
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
    /* Anzeige-Label für den Arbeitgeber/Eigentümer eines Mitarbeiters.
     * Wird in der Mitarbeiter-Liste, im Minijob-PDF und in Toasts verwendet.
     * Texte stehen in settings.labels und werden vom Admin in Settings
     * gepflegt — der Code enthält nur generische Defaults. */
    function ownerLabel(assignedTo) {
        const labels = settings()?.labels || {};
        return assignedTo === 'owner2'
            ? (labels.owner2 || 'Eigentümer 2')
            : (labels.owner1 || 'Eigentümer 1');
    }
    // Kurzformen für die beiden Eigentümer — überall dort, wo früher die
    // Vornamen fest in Überschriften und Exportspalten standen.
    const owner1Label = () => ownerLabel('owner1');
    const owner2Label = () => ownerLabel('owner2');

    /* Setzt die Spaltenköpfe, die im HTML nur generisch vorbelegt sind, auf die
     * konfigurierten Eigentümer-Labels. Muss bei jedem Rendern laufen, nicht
     * einmalig beim Login — sonst zeigen die Tabellen nach einer Label-Änderung
     * in den Einstellungen bis zum nächsten Login noch die alte Beschriftung. */
    function applyOwnerLabelsToHeaders() {
        const o1 = owner1Label(), o2 = owner2Label();
        const set = (id, text) => { const el = $('#' + id); if (el) el.textContent = text; };
        set('thKostenOwner1', `Kosten ${o1}`);
        set('thKostenOwner2', `Kosten ${o2}`);
        set('thRoomOwner1', o1);
        set('thRoomOwner2', o2);
    }

    function empAssignment(id) {
        const e = employees().find(x => x.id === id);
        return (e && e.assignedTo) || 'owner1';
    }
    /* AKTUELLER RV-Status eines Mitarbeiters (Spiegel des jüngsten Historien-
     * Eintrags). Nur für die Anzeige gedacht — Badge in der Mitarbeiterliste,
     * Vorbelegung von Dialogen. Für JEDE Berechnung ist rvBefreitForMonth zu
     * verwenden, sonst wirkt ein Statuswechsel wieder rückwirkend. */
    function empRvBefreit(id) {
        const e = employees().find(x => x.id === id);
        return !!(e && e.rvBefreit);
    }

    /* Datierte RV-Historie eines Mitarbeiters (chronologisch sortiert, von
     * normalize() garantiert nicht leer). Quelle der Wahrheit für den RV-Status. */
    function rvHistorieFor(empId) {
        const e = employees().find(x => x.id === empId);
        return Array.isArray(e?.rvHistorie) ? e.rvHistorie : [];
    }

    /* RV-Status, der in einem bestimmten MONAT (YYYY-MM) galt. Liefert den
     * jüngsten Eintrag mit gueltigAb <= month; ein Eintrag gilt also ab seinem
     * Stichtag (inklusive) bis zum nächsten Eintrag (exklusive) — dieselbe
     * Konvention wie bei wageRatesFor. Für Monate vor dem ersten Eintrag fällt
     * es auf den frühesten Status zurück (Sicherheitsnetz, falls der
     * Migrationseintrag mal gelöscht würde). Monatsgenau, weil die RV in
     * Beitragsmonaten rechnet — auch die 175-EUR-Schwelle ist eine Monatsgrenze. */
    function rvBefreitForMonth(empId, month) {
        const hist = rvHistorieFor(empId);
        if (hist.length === 0) return empRvBefreit(empId);
        let chosen = hist[0];
        for (const h of hist) {
            if (h.gueltigAb <= month) chosen = h;
            else break;
        }
        return !!chosen.befreit;
    }

    /* Trägt einen RV-Statuswechsel in die Historie eines Mitarbeiters ein:
     * dedupliziert nach Stichtag (neuer Eintrag gewinnt), sortiert chronologisch
     * und spiegelt rvBefreit auf den jüngsten Eintrag. Muss hier passieren, weil
     * save() im Gegensatz zu load() NICHT normalisiert — sonst bliebe die Historie
     * bis zum nächsten Laden unsortiert und das Badge zeigte den alten Status. */
    function setRvEintrag(emp, gueltigAb, befreit) {
        const hist = Array.isArray(emp.rvHistorie) ? emp.rvHistorie : [];
        const merged = [
            ...hist.filter(h => h.gueltigAb !== gueltigAb),
            { gueltigAb, befreit: !!befreit },
        ].sort((a, b) => a.gueltigAb.localeCompare(b.gueltigAb));
        emp.rvHistorie = merged;
        emp.rvBefreit = merged[merged.length - 1].befreit;
    }

    /* Minijob-RV-Konstanten (Stand Minijob-Zentrale 2026, gewerbliche Anstellung).
     * Mindestbeitragsbemessungsgrundlage gilt PRO MONAT — payoutInfo erwartet
     * daher monatsweisen Bruttolohn. Für Aggregate über mehrere Monate ist
     * payoutInfoForShifts zu verwenden (gruppiert vorher monatsweise). */
    const MIN_BEITRAGSBEMESSUNG_EUR = 175;
    const RV_BEITRAG_GESAMT_PCT     = 18.6;
    const AG_PAUSCHALE_GEWERBE_PCT  = 15;
    // 32,55 EUR — direkt gerundet, weil 175 * 18.6 / 100 in JS 32.550000000000004 ergibt
    const MIN_BEITRAG_GESAMT_EUR    = Math.round(MIN_BEITRAGSBEMESSUNG_EUR * RV_BEITRAG_GESAMT_PCT) / 100;

    /* Kaufmännische Rundung (round half up) auf 2 Nachkommastellen. Math.round
     * driftet bei manchen Floats (z.B. 1.005 → 1.00 statt 1.01), weil 1.005
     * intern minimal kleiner als 1.005 dargestellt wird. +Number.EPSILON
     * verschiebt knapp-unter-.5-Werte zuverlässig über die Schwelle. */
    function roundHalfUp(n) {
        return Math.round((n + Number.EPSILON) * 100) / 100;
    }

    /* Stichtag für die verfeinerte Berechnung: Erst ab diesem Monat (YYYY-MM)
     * wird jeder Schicht-Betrag EINMAL auf Cent gerundet und alle Summen (Brutto,
     * Kosten, Auszahlung) aus diesen gerundeten Cent-Beträgen gebildet. Dadurch
     * zeigt jede Schicht überall — Stundenliste, CSV, Minijob-PDF — denselben
     * Betrag, und die Zeilen summieren sich exakt zum ausgewiesenen Gesamtwert
     * (kaufmännisches „pro Zeile runden, dann summieren"). Frühere Monate rechnen
     * bit-genau wie zuvor (Rohwerte summieren, erst der Gesamtwert wird gerundet)
     * — damit bereits ausgezahlte und an die Minijob-Zentrale gemeldete
     * Abrechnungen unverändert reproduzierbar bleiben. Bei einer erneuten
     * Umstellung hier den Stichtag hochsetzen. */
    const CALC_V2_FROM_MONTH = '2026-08';
    const isCalcV2Month = month => (month || '') >= CALC_V2_FROM_MONTH;
    const isCalcV2Date  = date  => (date  || '').slice(0, 7) >= CALC_V2_FROM_MONTH;

    /* Der für Anzeige UND Summierung maßgebliche Schicht-Betrag: ab dem Stichtag
     * auf Cent gerundet (so ist die Schicht überall gleich und die Summen gehen
     * auf), davor der ungerundete Rohwert (alte Logik, Rundung erst beim Gesamt). */
    function shiftPayAmount(shift) {
        const a = wageFor(shift).amount;
        return isCalcV2Date(shift.date) ? roundHalfUp(a) : a;
    }

    /* Kostenaufteilung einer Schicht für Anzeige UND Summierung. Ab dem Stichtag
     * werden Betrag und Anteil von Eigentümer 1 auf Cent gerundet und
     * Eigentümer 2 als Rest zum (gerundeten) Betrag gebildet — so gilt pro
     * Zeile Eigentümer 1 + Eigentümer 2 = Betrag und die Spalten summieren sich
     * stimmig zum jeweiligen Gesamt.
     * Vor dem Stichtag die ungerundeten Rohwerte (alte Logik). */
    function shiftCostShow(shift) {
        const c = splitCost(shift);
        if (!isCalcV2Date(shift.date)) {
            return { amount: c.total, owner1: c.owner1Base, owner2: c.owner2Base };
        }
        const amount = roundHalfUp(c.total);
        const owner1 = roundHalfUp(c.owner1Base);
        return { amount, owner1, owner2: amount - owner1 };
    }

    /* Berechnet Brutto, RV-Eigenanteil und Auszahlung für EIN MONATSBRUTTO.
     * - rvBefreit: rvAnteil = 0, Auszahlung = Brutto
     * - Brutto < 175 EUR: Mindestbeitragsbemessung greift,
     *     AN-Anteil = 32,55 EUR (Gesamt-Mindestbeitrag) − 15 % AG-Pauschale vom Brutto
     * - Brutto ≥ 175 EUR: regulär settings.rvAnteilProzent vom Brutto
     * mindestGreift = true wenn die Mindestlogik aktiv war (für Hinweis im PDF/Export).
     * Alle Beträge werden auf Cent gerundet — der RV-Eigenanteil und die
     * Auszahlung sind real gezahlte/gemeldete Cent-Beträge. Das Monatsbrutto
     * bekommt der Aufrufer bereits stichtaggerecht (ab Stichtag = Summe der auf
     * Cent gerundeten Schicht-Beträge, davor Summe der Rohwerte). */
    function payoutInfo(monatsBrutto, rvBefreit) {
        const brutto = roundHalfUp(monatsBrutto);
        if (rvBefreit) {
            return { brutto, rvAnteil: 0, auszahlung: brutto, mindestGreift: false };
        }
        if (brutto < MIN_BEITRAGSBEMESSUNG_EUR) {
            const agAnteil = roundHalfUp(brutto * AG_PAUSCHALE_GEWERBE_PCT / 100);
            const rvAnteil = roundHalfUp(MIN_BEITRAG_GESAMT_EUR - agAnteil);
            return { brutto, rvAnteil, auszahlung: roundHalfUp(brutto - rvAnteil), mindestGreift: true };
        }
        const pct = Number(settings().rvAnteilProzent) || 0;
        const rvAnteil = roundHalfUp(brutto * pct / 100);
        return { brutto, rvAnteil, auszahlung: roundHalfUp(brutto - rvAnteil), mindestGreift: false };
    }

    /* Aggregiert payoutInfo MONATSWEISE über eine Schicht-Liste und summiert
     * die Ergebnisse. Pauschal über mehrere Monate gerechnet würde die
     * Mindestbeitrags-Schwelle (175 EUR) systematisch falsch greifen — daher
     * vorher pro Monat aufteilen. mindestMonths listet die YYYY-MM, in denen
     * die Mindestlogik aktiv war (für Hinweis-Anzeige im Output).
     * empId: Mitarbeiter, dessen Monatspauschale berücksichtigt wird; sie wird
     * nur in Monaten ab dem Stichtag (pauschaleAb) zum Brutto addiert (so wirkt
     * sie auch auf die 175-EUR-Schwelle und Pauschalabgaben). monthCount zählt
     * die Monate, in denen die Pauschale tatsächlich griff; pauschaleTotal ist
     * die effektiv addierte Summe (für Anzeige).
     * Der RV-Status wird PRO MONAT aus der Historie gelesen (rvBefreitForMonth),
     * nicht einmal pauschal für den ganzen Zeitraum — über einen Statuswechsel
     * hinweg können in derselben Auswertung befreite und pflichtige Monate
     * liegen. befreitMonths listet die befreiten YYYY-MM; alleBefreit/
     * teilweiseBefreit sind daraus abgeleitete Flags für ehrliche Labels. */
    function payoutInfoForShifts(shiftList, empId) {
        const byMonth = new Map();
        shiftList.forEach(s => {
            const month = (s.date || '').slice(0, 7);
            const cur = byMonth.get(month) || 0;
            // Monatsbrutto = Summe der stichtaggerechten Schicht-Beträge (ab
            // Stichtag auf Cent gerundet, davor roh) — identisch zu dem, was in
            // Stundenliste/PDF pro Schicht angezeigt wird.
            byMonth.set(month, cur + shiftPayAmount(s));
        });
        let brutto = 0, rvAnteil = 0, auszahlung = 0;
        let pauschaleTotal = 0, pauschaleMonths = 0;
        const mindestMonths = [];
        const befreitMonths = [];
        [...byMonth.entries()].forEach(([month, schichtBrutto]) => {
            const befreit = rvBefreitForMonth(empId, month);
            if (befreit) befreitMonths.push(month);
            const pauschale = monatspauschaleForMonth(empId, month);
            const monatsBrutto = schichtBrutto + pauschale;
            if (pauschale > 0) { pauschaleTotal += pauschale; pauschaleMonths += 1; }
            const p = payoutInfo(monatsBrutto, befreit);
            brutto += p.brutto;
            rvAnteil += p.rvAnteil;
            auszahlung += p.auszahlung;
            if (p.mindestGreift) mindestMonths.push(month);
        });
        const monatsZahl = byMonth.size;
        // Die Monatswerte sind bereits Cent-Beträge; die Zeitraum-Summe ist ihre
        // Summe (roundHalfUp glättet nur Float-Rauschen).
        return {
            brutto: roundHalfUp(brutto),
            rvAnteil: roundHalfUp(rvAnteil),
            auszahlung: roundHalfUp(auszahlung),
            mindestMonths: mindestMonths.sort(),
            monthCount: pauschaleMonths,
            pauschaleTotal: roundHalfUp(pauschaleTotal),
            befreitMonths: befreitMonths.sort(),
            alleBefreit: monatsZahl > 0 && befreitMonths.length === monatsZahl,
            teilweiseBefreit: befreitMonths.length > 0 && befreitMonths.length < monatsZahl,
        };
    }

    /* Hilfs-Lookup: Monatspauschale eines Mitarbeiters (0 wenn nicht gesetzt).
     * Dies ist der reine Betrag OHNE Stichtag-Prüfung — nur für Anzeige (z. B.
     * Badge in der Mitarbeiterliste). Für die Lohnberechnung immer
     * monatspauschaleForMonth() verwenden, damit der Stichtag greift. */
    function monatspauschaleFor(empId) {
        const e = employees().find(x => x.id === empId);
        return Math.max(0, Number(e?.monatspauschale) || 0);
    }

    /* Stichtag (YYYY-MM), ab dem die Monatspauschale eines Mitarbeiters gilt.
     * Leerer String = keine Beschränkung (Pauschale gilt in allen Monaten). */
    function pauschaleAbFor(empId) {
        const e = employees().find(x => x.id === empId);
        const v = e?.pauschaleAb;
        return (typeof v === 'string' && /^\d{4}-\d{2}$/.test(v)) ? v : '';
    }

    /* Monatspauschale eines Mitarbeiters FÜR EINEN BESTIMMTEN MONAT (YYYY-MM).
     * Liefert 0, wenn keine Pauschale gesetzt ist ODER der Monat vor dem
     * Stichtag pauschaleAb liegt. So gilt die Pauschale erst ab dem Stichtag
     * und wird nicht rückwirkend in ältere Monate eingerechnet. */
    function monatspauschaleForMonth(empId, month) {
        const ps = monatspauschaleFor(empId);
        if (ps <= 0) return 0;
        const ab = pauschaleAbFor(empId);
        if (ab && month < ab) return 0;
        return ps;
    }

    /* Schicht-für-Schicht-Aufschlüsselung des RV-Anteils für den Export:
     * pro Monat wird der korrekte Monats-RV-Anteil berechnet und anteilig auf
     * die einzelnen Schichten verteilt (Schicht-Brutto / Monats-Brutto). Cent-
     * Differenz aus Rundung wird in der letzten Schicht jedes Monats ausgeglichen,
     * sodass die Schicht-Summe exakt dem Monats-RV-Anteil entspricht.
     * Liefert eine Map shiftId → { rvAnteil, auszahlung }. */
    function perShiftPayoutMap(shiftList) {
        const result = new Map();
        const byEmp = new Map();
        shiftList.forEach(s => {
            if (!byEmp.has(s.employeeId)) byEmp.set(s.employeeId, []);
            byEmp.get(s.employeeId).push(s);
        });
        byEmp.forEach((empShifts, empId) => {
            const byMonth = new Map();
            empShifts.forEach(s => {
                const month = (s.date || '').slice(0, 7);
                if (!byMonth.has(month)) byMonth.set(month, []);
                byMonth.get(month).push(s);
            });
            byMonth.forEach((monthShifts, month) => {
                // RV-Status gilt PRO MONAT — der Lookup muss innerhalb dieser
                // Schleife stehen, sonst würde ein Statuswechsel auf alle Monate
                // des Zeitraums durchschlagen.
                const befreit = rvBefreitForMonth(empId, month);
                // Pauschale dieses Monats — 0, wenn der Monat vor dem Stichtag liegt.
                const pauschale = monatspauschaleForMonth(empId, month);
                // Stichtaggerechte Schicht-Beträge (ab Stichtag auf Cent) — so
                // sind Brutto/Auszahlung pro Schicht deckungsgleich mit der
                // Stundenliste und die Summen gehen exakt auf.
                const bruttoPerShift = monthShifts.map(s => shiftPayAmount(s));
                const schichtBrutto = bruttoPerShift.reduce((a, b) => a + b, 0);
                // Monats-Brutto inkl. Pauschale ist die Basis für RV; verteilt
                // wird der RV-Anteil aber nur auf die Schicht-Brutto-Anteile.
                // Der auf die Pauschale entfallende RV-Anteil ist Monats-RV
                // minus Summe der Schicht-Anteile und wird im Summary separat
                // ausgewiesen (über payoutInfoForShifts), NICHT auf Schichten.
                const monatsBruttoTotal = schichtBrutto + pauschale;
                const monthInfo = payoutInfo(monatsBruttoTotal, befreit);
                if (befreit || monatsBruttoTotal === 0) {
                    monthShifts.forEach((s, i) => result.set(s.id, {
                        rvAnteil: 0,
                        auszahlung: roundHalfUp(bruttoPerShift[i]),
                    }));
                    return;
                }
                // Anteilig: jede Schicht trägt schichtBrutto_i / monatsBruttoTotal
                // des Monats-RV. Die Pauschale trägt den Rest — wird hier nicht
                // pro Schicht verteilt.
                let rvSoFar = 0;
                monthShifts.forEach((s, i) => {
                    const b = bruttoPerShift[i];
                    const isLast = i === monthShifts.length - 1;
                    let rv;
                    if (isLast && pauschale === 0) {
                        // Cent-Drift in der letzten Schicht ausgleichen, wenn
                        // keine Pauschale separat verbleibt.
                        rv = roundHalfUp(monthInfo.rvAnteil - rvSoFar);
                    } else {
                        rv = roundHalfUp(monthInfo.rvAnteil * b / monatsBruttoTotal);
                        rvSoFar += rv;
                    }
                    result.set(s.id, { rvAnteil: rv, auszahlung: roundHalfUp(b - rv) });
                });
            });
        });
        return result;
    }

    function renderAdminShifts() {
        applyOwnerLabelsToHeaders();
        fillYearMonthSelects('#adminYear', '#adminMonth', viewableShifts);
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
        let totalMin = 0;
        // Pro Schicht wird DERSELBE Betrag angezeigt UND summiert (ab Stichtag auf
        // Cent gerundet mit Eigentümer 1 + Eigentümer 2 = Betrag; davor Rohwerte). Dadurch
        // ergeben die Spalten exakt die Gesamtwerte und jede Schicht zeigt überall
        // — Stundenliste, CSV, PDF — denselben Betrag.
        const hasV2 = list.some(s => isCalcV2Date(s.date));
        const shows = list.map(shiftCostShow);
        let amtSum = 0, sSum = 0, bSum = 0;
        list.forEach((s, i) => {
            const w = wageFor(s);
            const show = shows[i];
            totalMin += w.minutes;
            amtSum += show.amount; sSum += show.owner1; bSum += show.owner2;
            const tr = document.createElement('tr');
            tr.dataset.id = s.id;
            tr.innerHTML = `
                <td>${fmtDateDE(s.date)}</td>
                <td>${escapeHtml(empName(s.employeeId))}</td>
                <td>${isVacation(s) ? '<span class="muted">–</span>' : s.startTime}</td>
                <td>${isVacation(s) ? '<span class="muted">–</span>' : s.endTime}</td>
                <td class="num">${isVacation(s) ? '<span class="muted">–</span>' : fmtHours(w.minutes)}</td>
                <td>${roomsLabel(s)}</td>
                <td>${isVacation(s)
                        ? '<span class="badge urlaub">Urlaub</span>'
                        : (s.isDouble ? '<span class="badge double">Doppel</span>' : '<span class="badge muted">Einfach</span>')}</td>
                <td class="num">${fmtEUR(show.amount)}</td>
                <td class="num">${fmtEUR(show.owner1)}</td>
                <td class="num">${fmtEUR(show.owner2)}</td>
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
        // Monatspauschalen aufschlagen: pro Mitarbeiter wird die Pauschale in
        // jedem Monat mit ≥1 Schicht zu Brutto + Eigentümer-1/Eigentümer-2-Kosten addiert.
        // Aufteilung der Pauschale konstant 50/50 (NICHT raum-/anteilsbasiert).
        const factor = ABGABEN_PCT / 100;
        const empMonthsMap = new Map();
        list.forEach(s => {
            const month = (s.date || '').slice(0, 7);
            if (!empMonthsMap.has(s.employeeId)) empMonthsMap.set(s.employeeId, new Set());
            empMonthsMap.get(s.employeeId).add(month);
        });
        let pauschaleSum = 0;
        empMonthsMap.forEach((months, empId) => {
            // Pro Monat einzeln, damit der Stichtag (pauschaleAb) greift und
            // Monate vor dem Stichtag keine Pauschale beitragen.
            months.forEach(month => { pauschaleSum += monatspauschaleForMonth(empId, month); });
        });
        // Pauschale ebenfalls stichtaggerecht auf Cent: Hälfte von Eigentümer 1 gerundet,
        // Eigentümer 2 als Rest zum gerundeten Gesamt — so gilt auch inkl. Pauschale
        // Eigentümer 1 + Eigentümer 2 = Brutto.
        const pauschaleAmtDisp = hasV2 ? roundHalfUp(pauschaleSum)     : pauschaleSum;
        const pauschaleSDisp   = hasV2 ? roundHalfUp(pauschaleSum / 2) : pauschaleSum / 2;
        const pauschaleBDisp   = pauschaleAmtDisp - pauschaleSDisp;
        // Gesamtwerte. Ab Stichtag alles aus den (cent-gerundeten) Anzeigebeträgen:
        // Abgaben = 31,17 % der Kosten, Gesamt = Kosten + Abgaben — die Zusammen-
        // fassung ist in sich stimmig und Eigentümer 1 + Eigentümer 2 = Verdienst. Davor die
        // alte Rechnung (Rohsummen, Rundung erst in der Anzeige) — unverändert.
        const agg = { sBase: sSum + pauschaleSDisp, bBase: bSum + pauschaleBDisp };
        if (hasV2) {
            agg.sAbg = roundHalfUp(agg.sBase * factor);
            agg.bAbg = roundHalfUp(agg.bBase * factor);
            agg.sTotal = agg.sBase + agg.sAbg;
            agg.bTotal = agg.bBase + agg.bAbg;
        } else {
            agg.sAbg = agg.sBase * factor;
            agg.bAbg = agg.bBase * factor;
            agg.sTotal = agg.sBase * (1 + factor);
            agg.bTotal = agg.bBase * (1 + factor);
        }
        const totalAmt = amtSum + pauschaleAmtDisp;
        let summaryHtmlOut = adminSummaryHtml(list.length, totalMin, totalAmt, agg);
        if (pauschaleSum > 0) {
            summaryHtmlOut += `<div class="stat"><div class="label">davon Monatspauschalen</div><div class="value">${fmtEUR(pauschaleSum)}</div></div>`;
        }
        // Wenn ein einzelner Mitarbeiter gefiltert ist: Brutto / RV-Anteil /
        // Auszahlung anzeigen — wichtig für die Lohnabrechnung. Pauschale wird
        // hier in den Monaten mit Schichten ins Brutto eingerechnet.
        const filteredEmpId = $('#adminEmpFilter').value;
        let mindestNoteHtml = '';
        if (filteredEmpId && list.length) {
            const empId = Number(filteredEmpId);
            const p = payoutInfoForShifts(list, empId);
            const pctStr = String(Number(settings().rvAnteilProzent) || 0).replace('.', ',');
            // Über einen Statuswechsel hinweg kann der Zeitraum befreite UND
            // pflichtige Monate enthalten — dann wäre "(befreit)" gelogen. Das
            // Label sagt daher genau, was gilt, und der Betrag wird ausgewiesen.
            const rvLabel = p.alleBefreit
                ? `RV-Anteil (befreit)`
                : p.teilweiseBefreit
                    ? `RV-Anteil (teilw. befreit†)`
                    : p.mindestMonths.length
                        ? `RV-Anteil (Mindestbeitrag*)`
                        : `RV-Anteil (${pctStr}%)`;
            summaryHtmlOut +=
                `<div class="stat"><div class="label">Brutto ${escapeHtml(empName(empId))}</div><div class="value">${fmtEUR(p.brutto)}</div></div>` +
                `<div class="stat"><div class="label">${rvLabel}</div><div class="value">${p.alleBefreit ? '–' : '− ' + fmtEUR(p.rvAnteil)}</div></div>` +
                `<div class="stat"><div class="label">Auszahlung an ${escapeHtml(empName(empId))}</div><div class="value">${fmtEUR(p.auszahlung)}</div></div>`;
            if (p.pauschaleTotal > 0) {
                summaryHtmlOut +=
                    `<div class="stat"><div class="label">davon Pauschale (${p.monthCount} ${p.monthCount === 1 ? 'Monat' : 'Monate'})</div><div class="value">${fmtEUR(p.pauschaleTotal)}</div></div>`;
            }
            if (p.teilweiseBefreit) {
                mindestNoteHtml +=
                    `<p class="muted small" style="margin-top:.75rem">` +
                    `† Der RV-Status hat sich im Zeitraum geändert: in ${escapeHtml(p.befreitMonths.join(', '))} ` +
                    `war ${escapeHtml(empName(empId))} von der RV-Pflicht befreit, in den übrigen Monaten nicht. ` +
                    `Der RV-Anteil wurde monatsweise berechnet.` +
                    `</p>`;
            }
            if (p.mindestMonths.length) {
                mindestNoteHtml +=
                    `<p class="muted small" style="margin-top:.75rem">` +
                    `* In ${escapeHtml(p.mindestMonths.join(', '))} lag der Bruttolohn unter ${fmtEUR(MIN_BEITRAGSBEMESSUNG_EUR)}. ` +
                    `Der RV-Eigenanteil wurde aus der Mindestbeitragsbemessungsgrundlage berechnet und liegt daher höher als ${pctStr} %.` +
                    `</p>`;
            }
        }
        $('#adminSummary').innerHTML = summaryHtmlOut + mindestNoteHtml;

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

    /* Pure: nimmt eine Schicht-Liste, baut die Rows für CSV/ODS/PDF.
     * Wird vom UI-Export (mit currentAdminFiltered) UND von der automatischen
     * Tagessicherung / Monatsabschluss-Mail (mit eigener Filter-Liste)
     * benutzt. */
    function exportRowsFromList(list) {
        /* Export-Sortierung: pro Monat (absteigend, neueste zuerst) alle
         * Schichten eines Mitarbeiters zusammen — alphabetisch nach Name,
         * innerhalb chronologisch aufsteigend. So liest man im Export einen
         * Monat als Block durch und kann Lohn-Auszahlungen pro Person prüfen.
         * Die Tabellen-Ansicht in "Alle Schichten" bleibt unverändert nach
         * Datum absteigend sortiert (siehe adminSortedShifts). */
        list = [...list].sort((a, b) => {
            const aMonth = (a.date || '').slice(0, 7);
            const bMonth = (b.date || '').slice(0, 7);
            if (aMonth !== bMonth) return bMonth.localeCompare(aMonth);
            const cmp = empName(a.employeeId).localeCompare(empName(b.employeeId), 'de');
            if (cmp !== 0) return cmp;
            if (a.date !== b.date) return a.date.localeCompare(b.date);
            return (a.startTime || '').localeCompare(b.startTime || '');
        });
        const pctStr = String(ABGABEN_PCT).replace('.', ',');
        const rvPctStr = String(Number(settings().rvAnteilProzent) || 0).replace('.', ',');
        const rows = [[
            'Datum','Mitarbeiter','Beginn','Ende','Dauer (Std)',
            'Raum 1','Raum 2','Raumnamen',
            'Typ','Stundenlohn','Brutto (EUR)',
            `RV-Anteil AN (${rvPctStr}%, EUR)`,
            'Auszahlung (EUR)',
            `Kosten ${owner1Label()}`, `Kosten ${owner2Label()}`, 'Notiz'
        ]];
        // Pro Schicht DERSELBE Betrag für Anzeige UND Summe (ab Stichtag auf Cent,
        // Eigentümer 1 + Eigentümer 2 = Betrag; davor Rohwerte). RV/Auszahlung kommen aus
        // perShiftPayoutMap — ebenfalls stichtaggerecht, sodass sie sich exakt zur
        // Auszahlung pro Mitarbeiter aufsummieren.
        const tot = { hours: 0, amt: 0, sBase: 0, bBase: 0 };
        const hasV2 = list.some(s => isCalcV2Date(s.date));
        const shows = list.map(shiftCostShow);
        // Schicht-RV/Auszahlung wird monatsweise vor-berechnet — sonst würde
        // pro-Schicht-Multiplikation mit 3,6 % den Mindestbeitrag bei Brutto
        // < 175 EUR/Monat systematisch unterschätzen.
        const perShift = perShiftPayoutMap(list);
        list.forEach((s, i) => {
            const w = wageFor(s);
            const show = shows[i];
            const hours = w.minutes / 60;
            tot.hours += hours;
            tot.amt += show.amount; tot.sBase += show.owner1; tot.bBase += show.owner2;
            // Urlaubstage haben keinen Raum; in den Raum-Spalten steht das
            // Kennwort, damit die Zeile in der Auswertung eindeutig ist.
            const urlaub = isVacation(s);
            const sec = urlaub ? null : secondRoomOf(s);
            const r1name = urlaub ? 'Urlaub' : (settings().rooms[s.room]?.name || '');
            const r2name = sec ? (settings().rooms[sec]?.name || '') : '';
            // Status des MONATS dieser Schicht, nicht der aktuelle Status des
            // Mitarbeiters — sonst würde ein Statuswechsel alte Zeilen umschreiben.
            const befreit = rvBefreitForMonth(s.employeeId, (s.date || '').slice(0, 7));
            const shiftPay = perShift.get(s.id) || { rvAnteil: 0, auszahlung: show.amount };
            rows.push([
                s.date, empName(s.employeeId), s.startTime, s.endTime,
                hours.toFixed(2), urlaub ? 'URLAUB' : s.room, sec || '',
                sec ? `${r1name} + ${r2name}` : r1name,
                urlaub ? 'Urlaub' : (s.isDouble ? 'Doppel' : 'Einfach'),
                w.rate.toFixed(2), show.amount.toFixed(2),
                befreit ? '0,00' : shiftPay.rvAnteil.toFixed(2),
                shiftPay.auszahlung.toFixed(2),
                show.owner1.toFixed(2), show.owner2.toFixed(2),
                s.note || ''
            ]);
        });
        // Mitarbeiter-Aggregat ebenfalls monatsweise (für die korrekte Mindest-
        // beitragslogik). Pro Mitarbeiter eine payoutInfoForShifts-Aufstellung,
        // inkl. Monatspauschale wenn hinterlegt.
        const empIds = [...new Set(list.map(s => s.employeeId))];
        const byEmp = new Map();
        let pauschaleSum = 0;
        empIds.forEach(empId => {
            const empShifts = list.filter(s => s.employeeId === empId);
            const p = payoutInfoForShifts(empShifts, empId);
            // befreit = durchgehend befreit im Zeitraum; bei einem Statuswechsel
            // ist das false und der tatsächliche RV-Anteil steht in p.rvAnteil.
            byEmp.set(empId, { ...p, befreit: p.alleBefreit });
            pauschaleSum += p.pauschaleTotal;
        });
        // Monatspauschalen erhöhen Brutto und werden 50/50 zwischen Eigentümer 1 und
        // Eigentümer 2 aufgeteilt (NICHT raumbasiert). Die Pauschalabgaben (31,17 %)
        // fallen darauf wie auf jedes andere Brutto an.
        const factor = ABGABEN_PCT / 100;
        // Pauschale stichtaggerecht 50/50 (Hälfte von Eigentümer 1 gerundet, Eigentümer 2 als
        // Rest). Ab Stichtag Kosten/Abgaben/Gesamt aus den (cent-gerundeten)
        // Anzeige-Summen (Abgaben = 31,17 % der Kosten, Gesamt = Kosten + Abgaben,
        // Eigentümer 1 + Eigentümer 2 = Brutto); davor die alte Rechnung aus den Rohwerten.
        const pauschaleAmtDisp = hasV2 ? roundHalfUp(pauschaleSum)     : pauschaleSum;
        const pauschaleSDisp   = hasV2 ? roundHalfUp(pauschaleSum / 2) : pauschaleSum / 2;
        const pauschaleBDisp   = pauschaleAmtDisp - pauschaleSDisp;
        const sBase = tot.sBase + pauschaleSDisp;
        const bBase = tot.bBase + pauschaleBDisp;
        const bruttoGesamt = tot.amt + pauschaleAmtDisp;
        let sAbg, sTot, bAbg, bTot;
        if (hasV2) {
            sAbg = roundHalfUp(sBase * factor); sTot = sBase + sAbg;
            bAbg = roundHalfUp(bBase * factor); bTot = bBase + bAbg;
        } else {
            sAbg = sBase * factor; sTot = sBase * (1 + factor);
            bAbg = bBase * factor; bTot = bBase * (1 + factor);
        }
        rows.push([]);
        rows.push(['ZUSAMMENFASSUNG']);
        rows.push(['Einträge', list.length]);
        rows.push(['Stunden gesamt', tot.hours.toFixed(2)]);
        rows.push(['Brutto Mitarbeiter gesamt (EUR)', bruttoGesamt.toFixed(2)]);
        if (pauschaleSum > 0) {
            rows.push(['  davon Monatspauschalen (EUR)', pauschaleSum.toFixed(2)]);
        }
        if (byEmp.size > 0) {
            rows.push([]);
            rows.push(['LOHN-AUSZAHLUNG PRO MITARBEITER']);
            const hasAnyPauschale = [...byEmp.values()].some(a => a.pauschaleTotal > 0);
            if (hasAnyPauschale) {
                rows.push(['Mitarbeiter', 'Brutto (EUR)', 'davon Pauschale (EUR)', `RV-Anteil AN (EUR)`, 'Auszahlung (EUR)']);
            } else {
                rows.push(['Mitarbeiter', 'Brutto (EUR)', `RV-Anteil AN (EUR)`, 'Auszahlung (EUR)']);
            }
            [...byEmp.entries()]
                .sort((a, b) => empName(a[0]).localeCompare(empName(b[0]), 'de'))
                .forEach(([empId, a]) => {
                    // Bei einem RV-Statuswechsel im Zeitraum ist weder "befreit"
                    // noch "pflichtig" allein korrekt — das wird ausgewiesen.
                    const flag = a.befreit ? ' (RV-befreit)'
                               : a.teilweiseBefreit ? ' (RV teilw. befreit)'
                               : a.mindestMonths.length ? ' (*)' : '';
                    // a.* wird intern auf 4 Stellen geführt — hier für die
                    // Anzeige kaufmännisch auf Cent runden.
                    const row = [
                        empName(empId) + flag,
                        roundHalfUp(a.brutto).toFixed(2),
                    ];
                    if (hasAnyPauschale) row.push(roundHalfUp(a.pauschaleTotal).toFixed(2));
                    row.push(a.befreit ? '0,00' : roundHalfUp(a.rvAnteil).toFixed(2));
                    row.push(roundHalfUp(a.auszahlung).toFixed(2));
                    rows.push(row);
                });
        }
        // Sammelhinweis: alle Monate, in denen mindestens ein Mitarbeiter
        // unter die 175-EUR-Schwelle gefallen ist (inkl. Pauschale gerechnet).
        const allMindest = new Set();
        byEmp.forEach(a => a.mindestMonths.forEach(m => allMindest.add(m)));
        if (allMindest.size > 0) {
            rows.push([]);
            rows.push([`(*) Hinweis Mindestbeitragsbemessungsgrundlage`]);
            rows.push([`In folgenden Monaten lag der Bruttolohn (inkl. Monatspauschale) unter ${MIN_BEITRAGSBEMESSUNG_EUR.toFixed(2)} EUR:`]);
            rows.push([[...allMindest].sort().join(', ')]);
            rows.push([`Der RV-Eigenanteil wurde dort aus der Mindestbeitragsbemessungsgrundlage berechnet (Gesamtbeitrag ${MIN_BEITRAG_GESAMT_EUR.toFixed(2)} EUR abzüglich AG-Pauschale ${AG_PAUSCHALE_GEWERBE_PCT} % vom Brutto) und liegt daher höher als ${rvPctStr} %.`]);
        }
        rows.push([]);
        const o1 = owner1Label(), o2 = owner2Label();
        rows.push([`Kosten ${o1} (EUR)`, sBase.toFixed(2)]);
        if (pauschaleSum > 0) {
            rows.push(['  davon Pauschale-Anteil 50% (EUR)', pauschaleSDisp.toFixed(2)]);
        }
        rows.push([`Abgaben ${o1} (${pctStr}%)`, sAbg.toFixed(2)]);
        rows.push([`Gesamt ${o1} (EUR)`, sTot.toFixed(2)]);
        rows.push([]);
        rows.push([`Kosten ${o2} (EUR)`, bBase.toFixed(2)]);
        if (pauschaleSum > 0) {
            rows.push(['  davon Pauschale-Anteil 50% (EUR)', pauschaleBDisp.toFixed(2)]);
        }
        rows.push([`Abgaben ${o2} (${pctStr}%)`, bAbg.toFixed(2)]);
        rows.push([`Gesamt ${o2} (EUR)`, bTot.toFixed(2)]);
        // summary = exakt die Werte der ZUSAMMENFASSUNG oben, damit andere
        // Ausgaben (z. B. die PDF-Fußzeile) dieselben Zahlen zeigen und nichts
        // abweicht.
        const summary = { bruttoGesamt, sBase, sAbg, sTot, bBase, bAbg, bTot, pauschaleSum };
        return { rows, list, summary };
    }

    function exportRows() {
        return exportRowsFromList(currentAdminFiltered());
    }

    /* CSV-Blob aus rows-Array. Plain text, keine Lib nötig — funktioniert
     * auch in der automatischen Tagessicherung sofort beim Login. */
    function rowsToCsvBlob(rows) {
        const csv = rows.map(r => r.map(cell => {
            const s = String(cell ?? '');
            return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(';')).join('\r\n');
        // BOM, damit Excel UTF-8 erkennt
        return new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
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
        downloadBlob(rowsToCsvBlob(rows), exportFilenameBase() + '.csv');
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
        const { rows, list, summary } = exportRows();
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

        // Nur Minuten hier selbst summieren (keine Rundung nötig); alle Geld-
        // Beträge kommen aus summary — denselben Werten wie die ZUSAMMENFASSUNG in
        // der Tabelle, damit auf dem PDF nirgends abweichende Zahlen stehen.
        let totalMin = 0;
        list.forEach(s => { totalMin += wageFor(s).minutes; });

        doc.autoTable({
            head: [rows[0]],
            body: rows.slice(1),
            startY: 74,
            styles: { fontSize: 8, cellPadding: 3 },
            headStyles: { fillColor: [187, 206, 0], textColor: 0 },
            alternateRowStyles: { fillColor: [240, 248, 200] },
        });
        const yPos = doc.lastAutoTable.finalY + 20;
        const pctStr = String(ABGABEN_PCT).replace('.', ',');
        doc.setFontSize(10);
        doc.text(`Einträge: ${list.length}   Stunden: ${fmtHours(totalMin)}   Verdienst gesamt: ${fmtEUR(summary.bruttoGesamt)}`, 40, yPos);
        // Beide Zeilen auf gleiche Label-Breite auffüllen, damit die Spalten
        // untereinander stehen — die Labels sind frei konfigurierbar und
        // dadurch unterschiedlich lang.
        const o1 = owner1Label(), o2 = owner2Label();
        const padTo = Math.max(o1.length, o2.length) + 2;
        const lbl = n => (n + ':').padEnd(padTo);
        doc.text(`${lbl(o1)}Kosten ${fmtEUR(summary.sBase)}  +  Abgaben (${pctStr}%) ${fmtEUR(summary.sAbg)}  =  Gesamt ${fmtEUR(summary.sTot)}`, 40, yPos + 16);
        doc.text(`${lbl(o2)}Kosten ${fmtEUR(summary.bBase)}  +  Abgaben (${pctStr}%) ${fmtEUR(summary.bAbg)}  =  Gesamt ${fmtEUR(summary.bTot)}`, 40, yPos + 32);
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

        const blob = buildMinijobPdfBlob(targetEmps, monthLabel, month);
        if (!blob) {
            toast('PDF konnte nicht erzeugt werden.', 'error');
            return;
        }
        downloadBlob(blob, `stundenlisten_minijob_${yearStr}_${monthStr}.pdf`);
    }

    /* Pure: erzeugt Minijob-PDF aus einer vorbereiteten Mitarbeiter-Liste mit
     * Schicht-Stand. targetEmps = [{ emp, list }, …]. Wird vom UI-Export und
     * von der automatischen Monatsabschluss-Mail benutzt. Returns Blob, oder
     * null wenn jspdf nicht geladen ist.
     * month (YYYY-MM) ist der abgerechnete Monat — nötig, weil der RV-Status aus
     * der Historie für GENAU diesen Monat gelesen wird. Ein späterer Statuswechsel
     * darf ein früheres Monats-PDF nicht nachträglich verändern. */
    function buildMinijobPdfBlob(targetEmps, monthLabel, month) {
        if (typeof window.jspdf === 'undefined') return null;
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
        targetEmps.forEach((entry, idx) => {
            if (idx > 0) doc.addPage();
            const { emp, list } = entry;
            const arbeitgeber = ownerLabel(emp.assignedTo);

            doc.setFontSize(16); doc.setTextColor(0);
            doc.text('Stundenliste Minijob', 40, 50);
            doc.setFontSize(11); doc.setTextColor(80);
            doc.text(`Mitarbeiter:  ${emp.name}`, 40, 78);
            doc.text(`Zeitraum:     ${monthLabel}`, 40, 94);
            doc.text(`Arbeitgeber:  ${arbeitgeber}`, 40, 110);
            doc.setTextColor(0);

            // Jede Schicht zeigt ihren stichtaggerechten Betrag (ab Stichtag auf
            // Cent gerundet, davor roh). Der „Lohn aus Schichten" ist die Summe
            // GENAU dieser angezeigten Beträge — so gehen die Zeilen exakt auf und
            // die Schicht zeigt hier denselben Betrag wie in Stundenliste/CSV.
            const wages = list.map(s => wageFor(s));
            const shownAmounts = list.map(s => shiftPayAmount(s));
            const body = list.map((s, i) => {
                const w = wages[i];
                // Urlaubstage sind eigene Zeilen: keine Uhrzeiten, keine Stunden,
                // kein Stundenlohn — nur Datum, Kennwort und Betrag.
                if (isVacation(s)) {
                    return [fmtDateDE(s.date), 'Urlaub', '', '', '',
                            shownAmounts[i].toFixed(2).replace('.', ',') + ' EUR'];
                }
                return [
                    fmtDateDE(s.date),
                    s.startTime,
                    s.endTime,
                    (w.minutes / 60).toFixed(2).replace('.', ','),
                    w.rate.toFixed(2).replace('.', ',') + ' EUR',
                    shownAmounts[i].toFixed(2).replace('.', ',') + ' EUR',
                ];
            });

            let totalMin = 0, totalAmt = 0;
            wages.forEach(w => { totalMin += w.minutes; });
            shownAmounts.forEach(a => { totalAmt += a; });

            doc.autoTable({
                head: [['Datum','Beginn','Ende','Stunden','Stundenlohn','Betrag']],
                body,
                startY: 130,
                styles: { fontSize: 10, cellPadding: 5 },
                headStyles: { fillColor: [187, 206, 0], textColor: 0 },
                alternateRowStyles: { fillColor: [240, 248, 200] },
                columnStyles: {
                    3: { halign: 'right' },
                    4: { halign: 'right' },
                    5: { halign: 'right' },
                },
            });

            // Monatspauschale (falls hinterlegt) wird wie ein zusätzlicher Lohn-
            // Bestandteil behandelt: erscheint als eigene Zeile, fließt ins
            // Brutto und damit in die RV-/Mindestbeitrag-Berechnung ein. Greift
            // nur ab dem Stichtag — das PDF betrifft genau einen Monat, der sich
            // aus den Schichten ableiten lässt.
            const pdfMonth = (list[0]?.date || '').slice(0, 7);
            const pauschale = monatspauschaleForMonth(emp.id, pdfMonth);
            const bruttoGesamt = totalAmt + pauschale;

            // Urlaubsentgelt getrennt ausweisen, damit die Lohnabrechnung zeigt,
            // welcher Teil des Brutto nicht aus geleisteter Arbeit stammt.
            let urlaubAmt = 0, urlaubTage = 0;
            list.forEach((s, i) => { if (isVacation(s)) { urlaubAmt += shownAmounts[i]; urlaubTage += 1; } });
            const schichtAmt = roundHalfUp(totalAmt - urlaubAmt);

            let yAfter = doc.lastAutoTable.finalY + 20;
            doc.setFontSize(11);
            if (pauschale > 0 || urlaubTage > 0) {
                doc.text(`Lohn aus Schichten:`, 40, yAfter);
                doc.text(`${(totalMin / 60).toFixed(2).replace('.', ',')} Std`, 300, yAfter, { align: 'right' });
                doc.text(`${fmtEUR(schichtAmt)}`, 540, yAfter, { align: 'right' });
                yAfter += 16;
                if (urlaubTage > 0) {
                    doc.text(`+ Urlaubsentgelt (${urlaubTage} Tag${urlaubTage === 1 ? '' : 'e'}):`, 40, yAfter);
                    doc.text(`${fmtEUR(roundHalfUp(urlaubAmt))}`, 540, yAfter, { align: 'right' });
                    yAfter += 16;
                }
                if (pauschale > 0) {
                    doc.text(`+ Monatspauschale:`, 40, yAfter);
                    doc.text(`${fmtEUR(pauschale)}`, 540, yAfter, { align: 'right' });
                    yAfter += 16;
                }
            }
            doc.setFont(undefined, 'bold');
            doc.text(`Brutto-Lohn:`, 40, yAfter);
            if (pauschale === 0 && urlaubTage === 0) {
                doc.text(`${(totalMin / 60).toFixed(2).replace('.', ',')} Std`, 300, yAfter, { align: 'right' });
            }
            doc.text(`${fmtEUR(bruttoGesamt)}`, 540, yAfter, { align: 'right' });
            doc.setFont(undefined, 'normal');

            // RV-Anteil Arbeitnehmer + Auszahlung anzeigen. payoutInfo erwartet
            // ein Monatsbrutto (inkl. Pauschale) und wendet bei Brutto < 175 EUR
            // automatisch die Mindestbeitragsbemessung an.
            // Der RV-Status kommt aus der Historie für den ABGERECHNETEN Monat,
            // nicht aus emp.rvBefreit (= aktueller Status). Fallback auf den Monat
            // der ersten Schicht, falls der Aufrufer keinen Monat mitgibt — alle
            // Schichten der Liste liegen konstruktionsbedingt im selben Monat.
            const abrechnungsMonat = month || (list[0]?.date || '').slice(0, 7);
            const befreit = rvBefreitForMonth(emp.id, abrechnungsMonat);
            const p = payoutInfo(bruttoGesamt, befreit);
            const rvPctStr = String(Number(settings().rvAnteilProzent) || 0).replace('.', ',');
            doc.setFontSize(11);
            const rvLabel = befreit
                ? `RV-Anteil AN (von der RV-Pflicht befreit):`
                : p.mindestGreift
                    ? `RV-Anteil AN (Mindestbeitrag, Brutto < ${fmtEUR(MIN_BEITRAGSBEMESSUNG_EUR)}):`
                    : `RV-Anteil AN (${rvPctStr}%):`;
            doc.text(rvLabel, 40, yAfter + 18);
            doc.text(befreit ? '–' : `− ${fmtEUR(p.rvAnteil)}`, 540, yAfter + 18, { align: 'right' });

            doc.setFont(undefined, 'bold');
            doc.text(`Auszahlung an Mitarbeiter:`, 40, yAfter + 38);
            doc.text(fmtEUR(p.auszahlung), 540, yAfter + 38, { align: 'right' });
            doc.setFont(undefined, 'normal');

            /* Urlaubs-Restkonto des Kalenderjahres, zu dem der abgerechnete
             * Monat gehört. Steht auf jeder Seite, damit Mitarbeiter und
             * Buchhaltung den Stand ohne Rückfrage sehen. */
            const kJahr = Number((month || (list[0]?.date || '')).slice(0, 4));
            const konto = urlaubsKonto(emp.id, kJahr);
            doc.setFontSize(10); doc.setTextColor(90);
            const uebertragTxt = konto.uebertrag > 0
                ? ` + ${fmtTage(konto.uebertrag)} Übertrag aus ${kJahr - 1} (verfällt 30.06.${kJahr})`
                : '';
            doc.text(
                `Urlaub ${kJahr}: ${konto.genommen} von ${fmtTage(konto.anspruch)} Tagen genommen${uebertragTxt}, ` +
                `${fmtTage(konto.rest)} übrig ` +
                `(Anspruch: ${konto.arbeitstage} Arbeitstage ÷ ${URLAUB_TEILER}).`,
                40, yAfter + 58
            );
            doc.setTextColor(0);

            // Erläuterung zur Mindestbeitragsbemessung, wenn aktiv.
            let infoY = yAfter + 80;
            if (!befreit && p.mindestGreift) {
                doc.setFontSize(9); doc.setTextColor(120);
                doc.text(
                    `Hinweis: Monatsbrutto unter ${fmtEUR(MIN_BEITRAGSBEMESSUNG_EUR)}. ` +
                    `RV-Eigenanteil = Gesamtbeitrag ${fmtEUR(MIN_BEITRAG_GESAMT_EUR)} ` +
                    `(${RV_BEITRAG_GESAMT_PCT.toString().replace('.', ',')} % aus ${fmtEUR(MIN_BEITRAGSBEMESSUNG_EUR)})`,
                    40, infoY
                );
                doc.text(
                    `abzüglich AG-Pauschale ${AG_PAUSCHALE_GEWERBE_PCT} % vom tatsächlichen Bruttolohn ` +
                    `(${fmtEUR(roundHalfUp(bruttoGesamt * AG_PAUSCHALE_GEWERBE_PCT / 100))}).`,
                    40, infoY + 12
                );
                doc.setTextColor(0);
            }

            doc.setFontSize(9); doc.setTextColor(120);
            doc.text(`Erstellt am ${fmtDateTimeDE(new Date().toISOString())}`, 40, 800);
            doc.text(`Seite ${idx + 1} von ${targetEmps.length}`, 540, 800, { align: 'right' });
            doc.setTextColor(0);
        });
        return doc.output('blob');
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
        // Eigentümer-Auswahl mit den Labels aus Settings befüllen, damit
        // im Form die echten Bezeichnungen aus dem Tablet erscheinen,
        // nicht die generischen Defaults aus dem öffentlichen Code.
        const labels = settings()?.labels || {};
        const sel = $('#empAssigned');
        if (sel) {
            const prev = sel.value;
            sel.innerHTML =
                `<option value="owner1">${escapeHtml(labels.owner1 || 'Eigentümer 1')}</option>` +
                `<option value="owner2">${escapeHtml(labels.owner2 || 'Eigentümer 2')}</option>`;
            if (prev) sel.value = prev;
        }
        tbody.innerHTML = '';
        [...employees()].sort((a,b)=>a.name.localeCompare(b.name,'de')).forEach(e => {
            const roleBadge = e.isAdmin
                ? '<span class="badge ok">Admin</span>'
                : e.isAccountant
                    ? '<span class="badge">Buchhaltung</span>'
                    : '<span class="badge muted">Mitarbeiter</span>';
            const arbeitgeberLabel = ownerLabel(e.assignedTo);
            // Badge zeigt den AKTUELLEN Status (jüngster Historien-Eintrag). Gab es
            // einen Wechsel, wird sein Stichtag mit angezeigt — analog zur Pauschale.
            const rvHist = Array.isArray(e.rvHistorie) ? e.rvHistorie : [];
            const rvLatest = rvHist.length ? rvHist[rvHist.length - 1] : null;
            const rvAbHint = rvHist.length > 1 && rvLatest
                ? ` <span class="muted small">ab ${escapeHtml(rvLatest.gueltigAb)}</span>`
                : '';
            const rvBadge = (e.rvBefreit
                ? '<span class="badge muted" title="Befreit — kein RV-Anteil-Abzug">RV-befreit</span>'
                : '<span class="badge" title="RV-pflichtig — AN-Anteil wird vom Lohn abgezogen">RV-pflichtig</span>'
            ) + rvAbHint;
            const pauschaleVal = Number(e.monatspauschale) || 0;
            const pauschaleAbVal = (typeof e.pauschaleAb === 'string' && /^\d{4}-\d{2}$/.test(e.pauschaleAb)) ? e.pauschaleAb : '';
            const pauschaleCell = pauschaleVal > 0
                ? `<span class="badge">${fmtEUR(pauschaleVal)}</span>${pauschaleAbVal ? ` <span class="muted small">ab ${escapeHtml(pauschaleAbVal)}</span>` : ''}`
                : '<span class="muted small">–</span>';
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${escapeHtml(e.name)}</td>
                <td>${roleBadge}</td>
                <td><span class="badge">${escapeHtml(arbeitgeberLabel)}</span></td>
                <td>${rvBadge}</td>
                <td>${pauschaleCell}</td>
                <td>${e.isActive ? '<span class="badge ok">Aktiv</span>' : '<span class="badge muted">Inaktiv</span>'}</td>
                <td class="muted small">${e.createdAt ? fmtDateDE(e.createdAt.slice(0, 10)) : ''}</td>
                <td>${admin ? `
                    <button class="btn small" data-emp-rename="${e.id}">Umbenennen</button>
                    <button class="btn small" data-emp-pw="${e.id}">Passwort</button>
                    <button class="btn small" data-emp-assign="${e.id}">Arbeitgeber wechseln</button>
                    <button class="btn small" data-emp-pauschale="${e.id}">Pauschale ändern</button>
                    <button class="btn small" data-emp-urlaub="${e.id}">Urlaub</button>
                    <button class="btn small" data-emp-admin="${e.id}">${e.isAdmin ? 'Admin entziehen' : 'Admin geben'}</button>
                    <button class="btn small" data-emp-acc="${e.id}">${e.isAccountant ? 'Buchhaltung entziehen' : 'Buchhaltung geben'}</button>
                    <button class="btn small" data-emp-rv="${e.id}">RV-Status ändern</button>
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
            const label = ownerLabel(emp.assignedTo);
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
        tbody.querySelectorAll('[data-emp-rv]').forEach(b => b.onclick = async () => {
            const emp = employees().find(x => x.id === Number(b.dataset.empRv));
            const hist = Array.isArray(emp.rvHistorie) ? emp.rvHistorie : [];
            // Bisherige Historie im Dialog zeigen, damit der Admin sieht, was er
            // fortschreibt — ein Wechsel ändert nur Monate AB dem Stichtag.
            const histTxt = hist
                .map(h => `${h.gueltigAb}: ${h.befreit ? 'befreit' : 'pflichtig'}`)
                .join(' · ');
            const r = await promptModal(`RV-Status ändern — ${emp.name}`, [
                {
                    key: 'status',
                    label: `Neuer Status${histTxt ? ` (bisher — ${histTxt})` : ''}`,
                    options: [
                        { value: 'pflichtig', label: 'RV-pflichtig (Anteil wird vom Lohn abgezogen)' },
                        { value: 'befreit',   label: 'Von der RV-Pflicht befreit' },
                    ],
                    value: emp.rvBefreit ? 'befreit' : 'pflichtig',
                },
                {
                    key: 'ab',
                    label: 'Gilt ab Monat (frühere Monate bleiben unverändert)',
                    type: 'month',
                    value: todayLocalISO().slice(0, 7),
                },
            ]);
            if (!r) return;
            const ab = String(r.ab || '').trim();
            if (!/^\d{4}-\d{2}$/.test(ab)) {
                toast('Bitte einen Stichtags-Monat angeben (Format YYYY-MM).', 'error');
                return;
            }
            const befreit = r.status === 'befreit';
            setRvEintrag(emp, ab, befreit);
            saveData();
            renderEmployees();
            toast(`Ab ${ab}: ${befreit ? 'RV-befreit' : 'RV-pflichtig'}`, 'success');
        });
        tbody.querySelectorAll('[data-emp-urlaub]').forEach(b => b.onclick = () => {
            openUrlaubModal(Number(b.dataset.empUrlaub));
        });
        tbody.querySelectorAll('[data-emp-pauschale]').forEach(b => b.onclick = async () => {
            const emp = employees().find(x => x.id === Number(b.dataset.empPauschale));
            const curAb = (typeof emp.pauschaleAb === 'string' && /^\d{4}-\d{2}$/.test(emp.pauschaleAb)) ? emp.pauschaleAb : '';
            const r = await promptModal('Monatspauschale ändern', [
                {
                    key: 'eur',
                    label: 'Pauschale in EUR (0 = keine)',
                    value: String(Number(emp.monatspauschale) || 0),
                },
                {
                    key: 'ab',
                    label: 'Gilt ab Monat (leer = alle Monate)',
                    type: 'month',
                    value: curAb,
                },
            ]);
            if (!r) return;
            const v = Number(String(r.eur).replace(',', '.'));
            if (!isFinite(v) || v < 0) { toast('Bitte einen Betrag ≥ 0 eingeben.', 'error'); return; }
            const ab = String(r.ab || '').trim();
            if (ab && !/^\d{4}-\d{2}$/.test(ab)) { toast('Ungültiger Monat (Format YYYY-MM).', 'error'); return; }
            emp.monatspauschale = Math.round(v * 100) / 100;
            // Stichtag nur sinnvoll, wenn es eine Pauschale gibt; sonst leeren.
            emp.pauschaleAb = emp.monatspauschale > 0 ? ab : '';
            saveData();
            renderEmployees();
            const abMsg = (emp.monatspauschale > 0 && ab) ? ` ab ${ab}` : '';
            toast(`Pauschale: ${fmtEUR(emp.monatspauschale)}${abMsg}`, 'success');
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
        const pauschaleRaw = Number($('#empPauschale').value);
        const pauschale = isFinite(pauschaleRaw) && pauschaleRaw >= 0 ? pauschaleRaw : 0;
        // Stichtag nur übernehmen, wenn er das Format YYYY-MM hat und es eine
        // Pauschale gibt; ansonsten leer (gilt dann ohne Beschränkung).
        const pauschaleAbRaw = String($('#empPauschaleAb').value || '').trim();
        const pauschaleAb = (pauschale > 0 && /^\d{4}-\d{2}$/.test(pauschaleAbRaw)) ? pauschaleAbRaw : '';
        // Der Anfangsstatus gilt ab dem laufenden Monat. Ein neuer Mitarbeiter hat
        // keine älteren Schichten, daher deckt dieser eine Eintrag alles ab.
        const rvBefreitInit = $('#empRvBefreit').checked;
        state.data.employees.push({
            id: window.ParaloxStorage.nextId(employees()),
            name,
            password: hashed,
            isAdmin: $('#empAdmin').checked,
            isAccountant: $('#empAccountant').checked,
            rvBefreit: rvBefreitInit,
            rvHistorie: [{ gueltigAb: todayLocalISO().slice(0, 7), befreit: rvBefreitInit }],
            isActive: true,
            assignedTo: $('#empAssigned').value,
            monatspauschale: pauschale,
            pauschaleAb,
            createdAt: new Date().toISOString(),
        });
        saveData();
        $('#empName').value = '';
        $('#empPw').value = '';
        $('#empAdmin').checked = false;
        $('#empAccountant').checked = false;
        $('#empRvBefreit').checked = false;
        $('#empAssigned').value = 'owner1';
        $('#empPauschale').value = '0';
        $('#empPauschaleAb').value = '';
        toast('Mitarbeiter angelegt', 'success');
        renderEmployees();
        // Frisch angelegter Mitarbeiter sofort im Schicht-Dropdown verfügbar.
        refreshShiftEmpSelect();
    });

    // ---------- Einstellungen ----------

    function renderSettings() {
        $('#setRvAnteil').value = settings().rvAnteilProzent;
        const labels = settings().labels || {};
        $('#setLabelOwner1').value = labels.owner1 || '';
        $('#setLabelOwner2').value = labels.owner2 || '';
        $('#setDataController').value = settings().dataController || '';
        const cfg = settings().dailyBackup || {};
        $('#setBackupEnabled').checked = !!cfg.enabled;
        $('#setBackupRecipient').value = cfg.recipient || '';
        const mcfg = settings().monthlyArchive || {};
        $('#setMonthlyEnabled').checked = !!mcfg.enabled;
        $('#setMonthlyRecipient').value = mcfg.recipient || '';
        const pwSet = !!window.ParaloxStorage.getBackupPassword();
        $('#setBackupPassword').value = '';
        $('#setBackupPassword').placeholder = pwSet ? '•••••••• (gespeichert)' : 'mindestens 8 Zeichen';
        $('#backupPasswordHint').textContent = pwSet
            ? 'Backup-Passwort ist gesetzt. Neues Passwort eingeben + speichern überschreibt das bisherige (alte .enc-Dateien bleiben dann nur mit dem alten Passwort entschlüsselbar).'
            : 'Noch nicht gesetzt — automatische Sicherungen pausieren, bis ein Passwort hinterlegt ist.';
        renderBackupStatus();
        const admin = isAdmin();
        $$('#settingsForm input, #settingsForm button').forEach(el => el.disabled = !admin);
        $$('#wageAddForm input, #wageAddForm button').forEach(el => el.disabled = !admin);
        $$('#backupPasswordForm input, #backupPasswordForm button').forEach(el => el.disabled = !admin);
        $('#settingsForm').title = admin ? '' : 'Nur Admins können Einstellungen ändern.';
        renderWageHistory();
        applyOwnerLabelsToHeaders();
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

    // Lohnhistorie-Tabelle rendern. Neueste zuerst, damit der aktuell gültige
    // Satz oben steht. Pro Zeile ein Löschen-Button (nur Admin) — der älteste
    // Eintrag bleibt geschützt, weil er die Untergrenze für alte Schichten ist.
    function renderWageHistory() {
        const tbody = $('#wageHistoryTable tbody');
        if (!tbody) return;
        const hist = wageHistory();
        const admin = isAdmin();
        tbody.innerHTML = '';
        // Kopie absteigend sortieren, ohne das Original anzufassen.
        const rows = hist.slice().sort((a, b) => b.gueltigAb.localeCompare(a.gueltigAb));
        rows.forEach((h) => {
            const isOldest = hist.length > 1 && h.gueltigAb === hist[0].gueltigAb;
            const tr = document.createElement('tr');
            const delCell = (admin && !isOldest)
                ? `<button class="btn small danger" data-del-wage="${escapeHtml(h.gueltigAb)}">Löschen</button>`
                : (isOldest ? '<span class="muted small">Basis</span>' : '');
            tr.innerHTML = `
                <td>${escapeHtml(fmtDateDE(h.gueltigAb))}</td>
                <td class="num">${fmtEUR(h.single)}</td>
                <td class="num">${fmtEUR(h.double)}</td>
                <td>${delCell}</td>
            `;
            tbody.appendChild(tr);
        });
        // Datum-Feld auf heute vorbelegen, Beträge mit dem aktuell gültigen Satz.
        if (!$('#wageNewDate').value) $('#wageNewDate').value = todayISO();
        const latest = hist[hist.length - 1] || { single: 0, double: 0 };
        if (!$('#wageNewSingle').value) $('#wageNewSingle').value = latest.single;
        if (!$('#wageNewDouble').value) $('#wageNewDouble').value = latest.double;
    }

    // Neuen datierten Satz hinzufügen (oder einen bestehenden mit gleichem
    // Stichtag ersetzen). Verändert keine alten Schichten — die rechnen weiter
    // mit dem Satz, der an ihrem Datum gilt.
    $('#wageAddForm').addEventListener('submit', (ev) => {
        ev.preventDefault();
        if (!isAdmin()) return;
        const date = $('#wageNewDate').value;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            toast('Bitte ein gültiges Stichtag-Datum wählen.', 'error');
            return;
        }
        const single = Math.max(0, Number($('#wageNewSingle').value) || 0);
        const double = Math.max(0, Number($('#wageNewDouble').value) || 0);
        const hist = wageHistory();
        const existing = hist.find(h => h.gueltigAb === date);
        if (existing) {
            existing.single = single;
            existing.double = double;
        } else {
            hist.push({ gueltigAb: date, single, double });
        }
        hist.sort((a, b) => a.gueltigAb.localeCompare(b.gueltigAb));
        // Spiegel-Felder auf den jüngsten Satz nachziehen.
        const latest = hist[hist.length - 1];
        settings().wageSingle = latest.single;
        settings().wageDouble = latest.double;
        saveData();
        // Eingabefelder zurücksetzen, damit renderWageHistory sie neu vorbelegt.
        $('#wageNewDate').value = '';
        $('#wageNewSingle').value = '';
        $('#wageNewDouble').value = '';
        renderSettings();
        renderPreview();
        toast(existing ? 'Satz für dieses Datum aktualisiert' : 'Neuer Satz hinzugefügt', 'success');
    });

    // Einen Lohnsatz löschen (außer dem ältesten — der deckt die alten Schichten ab).
    $('#wageHistoryTable').addEventListener('click', async (ev) => {
        const btn = ev.target.closest('[data-del-wage]');
        if (!btn || !isAdmin()) return;
        const date = btn.getAttribute('data-del-wage');
        const hist = wageHistory();
        if (hist.length <= 1) return;
        if (date === hist[0].gueltigAb) {
            toast('Der älteste Satz kann nicht gelöscht werden — er deckt alle früheren Schichten ab.', 'error');
            return;
        }
        if (!await confirmModal('Lohnsatz löschen?', `<p>Lohnsatz gültig ab ${escapeHtml(fmtDateDE(date))} wirklich löschen?</p>`)) return;
        const idx = hist.findIndex(h => h.gueltigAb === date);
        if (idx === -1) return;
        hist.splice(idx, 1);
        const latest = hist[hist.length - 1];
        settings().wageSingle = latest.single;
        settings().wageDouble = latest.double;
        saveData();
        renderSettings();
        renderPreview();
        toast('Lohnsatz gelöscht', 'success');
    });

    // ---------- Tagessicherung per Mail ----------

    /* Status: Sperre verhindert Mehrfach-Aufrufe, falls in schneller Folge
     * gespeichert wird, während der Share-Dialog noch offen ist. */
    let backupInProgress = false;

    function todayLocalISO() {
        const d = new Date();
        const tz = d.getTimezoneOffset() * 60000;
        return new Date(d.getTime() - tz).toISOString().slice(0, 10);
    }

    function buildBackupBlob() {
        // Wir packen den vollen App-State plus ein paar Metadaten in eine
        // .json-Datei. Reicht zum Wiederherstellen auf einem neuen Tablet.
        const payload = {
            type: 'paralox-stunden-backup',
            version: 1,
            createdAt: new Date().toISOString(),
            data: state.data,
        };
        const json = JSON.stringify(payload, null, 2);
        return new Blob([json], { type: 'application/json' });
    }

    function backupFilename() {
        return `paralox-backup-${todayLocalISO()}.json`;
    }

    /* Verschlüsselt eine Liste von Backup-Anhängen mit dem in den Settings
     * hinterlegten Backup-Passwort. Jede Datei bekommt ein .enc-Suffix und
     * den Typ application/octet-stream — Mitarbeiter sehen im Share-Dialog
     * also nur unleserliche Krypto-Dateien. */
    async function encryptBackupFiles(files) {
        const password = window.ParaloxStorage.getBackupPassword();
        if (!password) throw new Error('Backup-Passwort nicht gesetzt — bitte in den Einstellungen hinterlegen.');
        const out = [];
        for (const f of files) {
            const encBlob = await window.ParaloxCrypto.encryptBlob(f.blob, password);
            out.push({
                blob: encBlob,
                name: window.ParaloxCrypto.encName(f.name),
                type: 'application/octet-stream',
            });
        }
        return out;
    }

    /* Versucht, die Backup-Datei via Web Share API zu teilen. Auf Android
     * Chrome erscheint der System-Share-Dialog mit der Datei als Anhang —
     * der User wählt "Mail" und tippt einmal "Senden". Wenn Web Share Files
     * nicht verfügbar ist (Desktop), Fallback: Datei wird heruntergeladen
     * und der Standard-Mail-Client wird mit vorgefüllten Feldern geöffnet —
     * dort muss der User die heruntergeladene Datei selbst anhängen.
     *
     * Returns true wenn der Share/Versand-Dialog erfolgreich geöffnet wurde,
     * false bei Fehler/Abbruch (dann nicht als "heute gesichert" markieren).
     */
    async function runDailyBackup({ force = false } = {}) {
        if (backupInProgress) return false;
        const cfg = settings().dailyBackup || {};
        if (!force && !cfg.enabled) return false;
        const today = todayLocalISO();
        if (!force && window.ParaloxStorage.getLastBackupDate() === today) return false;
        if (!window.ParaloxStorage.getBackupPassword()) {
            // Ohne Passwort produzieren wir keine unbrauchbaren Klartext-Backups.
            // Admin sieht den Hinweis; Mitarbeiter müssen nicht informiert werden.
            if (isAdmin()) {
                toast('Backup-Passwort fehlt — bitte in den Einstellungen hinterlegen.', 'error');
            }
            return false;
        }
        const recipient = (cfg.recipient || '').trim();

        backupInProgress = true;
        try {
            // 1. JSON für Wiederherstellung (das eigentliche Backup)
            const jsonBlob = buildBackupBlob();
            const jsonName = backupFilename();
            const files = [{ blob: jsonBlob, name: jsonName, type: 'application/json' }];

            // 2. CSV mit allen aktuellen Schichten — menschenlesbar
            try {
                const allShifts = [...shifts()].sort((a, b) =>
                    a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
                const { rows } = exportRowsFromList(allShifts);
                const csvBlob = rowsToCsvBlob(rows);
                files.push({
                    blob: csvBlob,
                    name: `paralox-stunden-${today}.csv`,
                    type: 'text/csv',
                });
            } catch (e) {
                console.warn('CSV-Anhang konnte nicht erzeugt werden', e);
            }

            const encFiles = await encryptBackupFiles(files);

            return await sendBackupViaShare({
                files: encFiles, recipient, today,
                subject: `Paralox Tagessicherung ${today}`,
                title: 'Paralox Tagessicherung ' + today,
                onSuccess: () => {
                    window.ParaloxStorage.setLastBackupDate(today);
                    renderBackupStatus();
                    toast('Tagessicherung gesendet', 'success');
                },
            });
        } catch (e) {
            console.warn('Tagessicherung fehlgeschlagen', e);
            toast('Sicherung fehlgeschlagen: ' + (e.message || e), 'error');
            return false;
        } finally {
            backupInProgress = false;
        }
    }

    /* Gemeinsame Web-Share-Routine für Tages- und Monatsabschluss-Mails.
     * files = [{ blob, name, type }, …]. Bei Erfolg → onSuccess(). Bei
     * Web-Share-Abort → false (kein Marker setzen). Bei fehlender API →
     * mailto-Fallback (Dateien werden heruntergeladen). */
    async function sendBackupViaShare({ files, recipient, today, subject, title, onSuccess }) {
        if (!files.length) return false;
        if (typeof File === 'function' && navigator.canShare) {
            const fileObjs = files.map(f => new File([f.blob], f.name, { type: f.type }));
            if (navigator.canShare({ files: fileObjs })) {
                try {
                    await navigator.share({
                        files: fileObjs,
                        title,
                        text: recipient
                            ? `Bitte als Anhang an ${recipient} senden.`
                            : 'Backup-Dateien zum Versand.',
                    });
                    onSuccess();
                    return true;
                } catch (e) {
                    if (e && e.name === 'AbortError') return false;
                    console.warn('Web Share fehlgeschlagen, nutze mailto-Fallback', e);
                }
            }
        }
        // Fallback: alle Dateien einzeln herunterladen, dann Mail-Client öffnen
        files.forEach(f => downloadBlob(f.blob, f.name));
        const fileList = files.map(f => `"${f.name}"`).join(', ');
        const body = `Heute heruntergeladene Backup-Dateien (${fileList}) bitte als Anhang einfügen und absenden.\n\n— Paralox Stundenverwaltung`;
        const mailto = `mailto:${encodeURIComponent(recipient)}` +
            `?subject=${encodeURIComponent(subject)}` +
            `&body=${encodeURIComponent(body)}`;
        window.location.href = mailto;
        onSuccess();
        toast('Backup-Dateien heruntergeladen — bitte als Anhang an die Mail einfügen', 'info');
        return true;
    }

    function renderBackupStatus() {
        const el = $('#backupStatus');
        if (!el) return;
        const last = window.ParaloxStorage.getLastBackupDate();
        const lastMonthly = window.ParaloxStorage.getLastMonthlyArchive();
        const dailyTxt = !last
            ? 'noch keine'
            : last === todayLocalISO() ? 'heute ✓' : fmtDateDE(last);
        const monthlyTxt = lastMonthly
            ? `${MONTH_NAMES[Number(lastMonthly.split('-')[1]) - 1]} ${lastMonthly.split('-')[0]}`
            : 'noch keiner';
        el.textContent = `Letzte Tagessicherung: ${dailyTxt} · Letzter gesicherter Monatsabschluss: ${monthlyTxt}`;
    }

    /* Bestimmt YYYY-MM des Vormonats relativ zu heute (lokale Zeit). */
    function previousMonthYYYYMM() {
        const d = new Date();
        d.setDate(1);
        d.setMonth(d.getMonth() - 1);
        const y = d.getFullYear();
        const m = pad(d.getMonth() + 1);
        return `${y}-${m}`;
    }

    /* Monatsabschluss-Mail: beim ersten Login eines neuen Monats wird der
     * Vormonat archiviert — Minijob-PDF (alle Mitarbeiter) + CSV-Auswertung
     * + JSON-Backup. Marker LAST_MONTHLY_KEY hält fest, welcher Vormonat
     * zuletzt gesichert wurde, damit's nicht doppelt feuert. */
    let monthlyInProgress = false;
    async function runMonthlyArchive({ force = false, monthOverride = null } = {}) {
        if (monthlyInProgress) return false;
        const cfg = settings().monthlyArchive || {};
        if (!force && !cfg.enabled) return false;
        const targetMonth = monthOverride || previousMonthYYYYMM();
        if (!force && window.ParaloxStorage.getLastMonthlyArchive() === targetMonth) {
            return false;
        }
        if (!window.ParaloxStorage.getBackupPassword()) {
            if (isAdmin()) {
                toast('Backup-Passwort fehlt — Monatsabschluss übersprungen.', 'error');
            }
            return false;
        }
        const recipient = (cfg.recipient || '').trim();

        const monthShifts = shifts()
            .filter(s => s.date.startsWith(targetMonth))
            .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
        if (monthShifts.length === 0 && !force) {
            // Kein Monatsabschluss nötig wenn der Vormonat keine Schichten hatte —
            // Marker trotzdem setzen, damit's nicht jeden Tag erneut versucht wird.
            window.ParaloxStorage.setLastMonthlyArchive(targetMonth);
            return false;
        }

        monthlyInProgress = true;
        try {
            const [yearStr, monthStr] = targetMonth.split('-');
            const monthLabel = `${MONTH_NAMES[Number(monthStr) - 1]} ${yearStr}`;

            // 1. JSON (vollständiger State zur Wiederherstellung)
            const files = [{
                blob: buildBackupBlob(),
                name: `paralox-backup-${todayLocalISO()}.json`,
                type: 'application/json',
            }];

            // 2. CSV des Vormonats — menschenlesbar, prüfungstauglich
            try {
                const { rows } = exportRowsFromList(monthShifts);
                files.push({
                    blob: rowsToCsvBlob(rows),
                    name: `paralox-stunden_${targetMonth}.csv`,
                    type: 'text/csv',
                });
            } catch (e) {
                console.warn('Monatsabschluss-CSV fehlgeschlagen', e);
            }

            // 3. Minijob-PDF (eine Seite pro Mitarbeiter) — wenn jspdf da
            try {
                const targetEmps = [...employees()]
                    .map(e => ({
                        emp: e,
                        list: monthShifts.filter(s => s.employeeId === e.id),
                    }))
                    .filter(x => x.list.length > 0)
                    .sort((a, b) => a.emp.name.localeCompare(b.emp.name, 'de'));
                if (targetEmps.length > 0) {
                    const pdfBlob = buildMinijobPdfBlob(targetEmps, monthLabel, targetMonth);
                    if (pdfBlob) {
                        files.push({
                            blob: pdfBlob,
                            name: `stundenlisten_minijob_${yearStr}_${monthStr}.pdf`,
                            type: 'application/pdf',
                        });
                    }
                }
            } catch (e) {
                console.warn('Minijob-PDF für Monatsabschluss fehlgeschlagen', e);
            }

            const encFiles = await encryptBackupFiles(files);

            return await sendBackupViaShare({
                files: encFiles, recipient, today: todayLocalISO(),
                subject: `Paralox Monatsabschluss ${monthLabel}`,
                title: 'Paralox Monatsabschluss ' + monthLabel,
                onSuccess: () => {
                    window.ParaloxStorage.setLastMonthlyArchive(targetMonth);
                    renderBackupStatus();
                    toast(`Monatsabschluss ${monthLabel} gesendet`, 'success');
                },
            });
        } catch (e) {
            console.warn('Monatsabschluss fehlgeschlagen', e);
            return false;
        } finally {
            monthlyInProgress = false;
        }
    }

    $('#settingsForm').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const rv = Number($('#setRvAnteil').value);
        settings().rvAnteilProzent = (isFinite(rv) && rv >= 0 && rv <= 20) ? rv : 3.6;
        // Labels und Verantwortliche Stelle (für DSGVO + Listen / PDF) — werden
        // in den öffentlichen Quellcode bewusst NICHT hartkodiert, sondern hier
        // pro Gerät gepflegt.
        if (!settings().labels) settings().labels = {};
        settings().labels.owner1 = $('#setLabelOwner1').value.trim();
        settings().labels.owner2 = $('#setLabelOwner2').value.trim();
        settings().dataController = $('#setDataController').value.trim();
        saveData();
        renderPreview();
        toast('Einstellungen gespeichert', 'success');
    });

    $('#backupForm').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const cfg = settings().dailyBackup;
        cfg.enabled = $('#setBackupEnabled').checked;
        const r = $('#setBackupRecipient').value.trim();
        if (cfg.enabled && !r) {
            toast('Bitte eine Empfänger-Adresse für die Tagessicherung eintragen.', 'error');
            return;
        }
        cfg.recipient = r || cfg.recipient;

        const mcfg = settings().monthlyArchive;
        mcfg.enabled = $('#setMonthlyEnabled').checked;
        const mr = $('#setMonthlyRecipient').value.trim();
        if (mcfg.enabled && !mr) {
            toast('Bitte eine Empfänger-Adresse für den Monatsabschluss eintragen.', 'error');
            return;
        }
        mcfg.recipient = mr || mcfg.recipient;

        saveData();
        toast('Sicherungs-Einstellungen gespeichert', 'success');
    });

    $('#backupNow').addEventListener('click', async () => {
        await runDailyBackup({ force: true });
    });

    /* Backup-Passwort speichern. Liegt im localStorage (gerätelokal), nicht
     * im JSON-Backup. Mindestens 8 Zeichen, sonst lehnen wir ab. */
    $('#backupPasswordForm').addEventListener('submit', (ev) => {
        ev.preventDefault();
        if (!isAdmin()) return;
        const pw = $('#setBackupPassword').value;
        if (!pw || pw.length < 8) {
            toast('Backup-Passwort muss mindestens 8 Zeichen haben.', 'error');
            return;
        }
        window.ParaloxStorage.setBackupPassword(pw);
        $('#setBackupPassword').value = '';
        renderSettings();
        toast('Backup-Passwort gespeichert', 'success');
    });

    /* "Passwort anzeigen"-Toggle: schaltet das input zwischen type=password
     * und type=text um, damit der Admin sein gerade getipptes Passwort
     * gegenprüfen kann. */
    $('#setBackupPasswordShow').addEventListener('change', (ev) => {
        $('#setBackupPassword').type = ev.target.checked ? 'text' : 'password';
    });

    /* Liest die im Import-Form gewählte .enc-Datei und entschlüsselt sie mit
     * dem im Form eingegebenen oder im localStorage gespeicherten Passwort.
     * Wirft eine sprechende Exception bei jedem Fehler — der Caller zeigt
     * sie als Toast an. */
    async function readAndDecryptImportFile() {
        const fileInput = $('#setBackupImportFile');
        const file = fileInput.files && fileInput.files[0];
        if (!file) throw new Error('Bitte zuerst eine .enc-Datei auswählen.');
        const pw = $('#setBackupImportPassword').value
            || window.ParaloxStorage.getBackupPassword();
        if (!pw) throw new Error('Kein Passwort eingegeben und keines gespeichert.');
        const plain = await window.ParaloxCrypto.decryptBlob(file, pw);
        return { file, plain };
    }

    $('#backupImportDecrypt').addEventListener('click', async () => {
        if (!isAdmin()) return;
        try {
            const { file, plain } = await readAndDecryptImportFile();
            const outName = window.ParaloxCrypto.originalName(file.name);
            // Plain ist Uint8Array; Mime aus Endung erraten, sonst octet-stream
            const mime = /\.json$/i.test(outName) ? 'application/json'
                       : /\.csv$/i.test(outName)  ? 'text/csv'
                       : /\.pdf$/i.test(outName)  ? 'application/pdf'
                       : 'application/octet-stream';
            downloadBlob(new Blob([plain], { type: mime }), outName);
            toast('Datei entschlüsselt und heruntergeladen', 'success');
        } catch (e) {
            toast('Entschlüsselung fehlgeschlagen: ' + (e.message || e), 'error');
        }
    });

    $('#backupImportRestore').addEventListener('click', async () => {
        if (!isAdmin()) return;
        try {
            const { file, plain } = await readAndDecryptImportFile();
            const outName = window.ParaloxCrypto.originalName(file.name);
            if (!/\.json$/i.test(outName)) {
                toast('Wiederherstellen funktioniert nur mit JSON-Backups.', 'error');
                return;
            }
            const text = new TextDecoder().decode(plain);
            const payload = JSON.parse(text);
            const data = payload && payload.data ? payload.data : payload;
            if (!data || !Array.isArray(data.employees) || !Array.isArray(data.shifts)) {
                toast('JSON enthält keine gültige Paralox-Datenstruktur.', 'error');
                return;
            }
            const ok = await confirmModal('Backup wiederherstellen?',
                `<p>Alle aktuellen Daten auf diesem Gerät werden durch das importierte Backup ersetzt: <strong>${data.employees.length} Mitarbeiter, ${data.shifts.length} Schichten</strong>.</p><p>Diese Aktion kann nicht rückgängig gemacht werden.</p>`);
            if (!ok) return;
            window.ParaloxStorage.replace(data);
            toast('Backup wiederhergestellt — Seite wird neu geladen.', 'success');
            setTimeout(() => location.reload(), 800);
        } catch (e) {
            toast('Wiederherstellung fehlgeschlagen: ' + (e.message || e), 'error');
        }
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
