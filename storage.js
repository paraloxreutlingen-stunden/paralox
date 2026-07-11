/* Paralox Stundenverwaltung - Storage-Schicht (localStorage) */
(() => {
    'use strict';

    const KEY = 'paraloxStunden.v1';
    const SESSION_KEY = 'paraloxStunden.session';
    // Bewusst NICHT in KEY enthalten: die Backup-Marker gehören zum Gerät,
    // nicht zu den Daten. Sonst würde ein importiertes Backup auf einem neuen
    // Gerät sofort glauben, es sei heute schon gesichert worden.
    const LAST_BACKUP_KEY = 'paraloxStunden.lastBackup';
    // Marker für die Monatsabschluss-Mail (YYYY-MM des bereits gesicherten
    // Vormonats). Liegt ebenfalls separat vom App-State.
    const LAST_MONTHLY_KEY = 'paraloxStunden.lastMonthlyArchive';
    // Marker für die einmalige DSGVO-Zustimmung (ISO-Zeitpunkt). Pro Gerät,
    // damit ein importiertes Backup auf einem neuen Gerät erneut die
    // Zustimmung verlangt.
    const DSGVO_ACCEPTED_KEY = 'paraloxStunden.dsgvoAccepted';
    // Symmetrisches Backup-Passwort für die Verschlüsselung der automatischen
    // Backup-Anhänge (AES-GCM 256, PBKDF2). Wird vom Admin in den Settings
    // gesetzt und gerätelokal gehalten — nicht im JSON-Backup, sonst hätte
    // jeder, der das Backup hat, automatisch das Passwort.
    const BACKUP_PASSWORD_KEY = 'paraloxStunden.backupPassword';
    // Offene Schichten ("Schicht gestartet, Ende noch nicht eingetragen").
    // Map { [employeeId]: { date, startTime, room, secondRoom, isDouble, note,
    // startedAt } }. Gerätelokal — wenn ein Mitarbeiter auf einem anderen
    // Tablet einloggt, sieht er die offene Schicht nicht. Eine Schicht pro
    // Mitarbeiter zur Zeit; muss erst beendet werden, bevor eine neue startet.
    const RUNNING_SHIFTS_KEY = 'paraloxStunden.runningShifts';

    /* WICHTIG: Diese Defaults landen im öffentlichen Quellcode auf GitHub.
     * Hier KEINE business-spezifischen Werte (Stundenlöhne, Mitarbeiter-
     * Namen, Adresse, Räume) hardcoden — das wären sonst Daten-Lecks.
     * Generische Platzhalter, die der Admin auf seinem Gerät einmalig in
     * den Settings überschreibt. Bestehende Geräte mit echten Werten in
     * localStorage sind nicht betroffen — Object.assign in normalize()
     * lässt vorhandene Werte stehen. */
    const DEFAULT_SETTINGS = {
        // wageSingle/wageDouble bleiben als "aktuellster Satz" erhalten (Spiegel
        // des jüngsten Eintrags aus wageHistory), damit evtl. verbliebene
        // Altzugriffe konsistent sind. Maßgeblich für die Berechnung ist aber
        // die datierte Lohnhistorie unten (siehe wageHistory).
        wageSingle: 0,
        wageDouble: 0,
        // Datierte Stundensätze. Jeder Eintrag { gueltigAb, single, double }
        // gilt ab seinem Stichtag (inklusive) bis zum nächsten Eintrag. Eine
        // Schicht wird mit dem Satz berechnet, der an ihrem Datum galt — ein
        // neuer Satz verändert daher rückwirkend KEINE alten Schichten. Wird
        // beim ersten Lauf aus wageSingle/wageDouble migriert (siehe normalize).
        wageHistory: [],
        abgabenPercent: 31.17,
        // Arbeitnehmer-Anteil zur gesetzlichen Rentenversicherung in Prozent
        // vom Brutto. Stand 2026: 18,6 % minus 15 % AG-Pauschale = 3,6 %.
        rvAnteilProzent: 3.6,
        // Tagessicherung per Mail. Empfänger ist gerätespezifisch — Admin
        // trägt seine eigene Backup-Adresse in den Settings ein.
        dailyBackup: {
            enabled: true,
            recipient: '',
        },
        // Monatsabschluss-Mail (Vormonat archivieren wegen Lohn-Aufbewahrungs-
        // pflicht, 10 Jahre, § 147 AO).
        monthlyArchive: {
            enabled: true,
            recipient: '',
        },
        // Generische Platzhalter-Räume mit 50/50-Aufteilung. Auf existierenden
        // Geräten werden die echten Räume aus localStorage NICHT überschrieben
        // (siehe Sonderbehandlung in normalize()).
        rooms: {
            R1: { name: 'Raum 1', owner1: 50, owner2: 50 },
            R2: { name: 'Raum 2', owner1: 50, owner2: 50 },
        },
        doubleSplit: { main: 50, owner1: 25, owner2: 25 },
        // Für DSGVO-Hinweis und Listen/PDFs sichtbare Bezeichnungen. Werden
        // vom Admin in Settings befüllt — Defaults sind generisch, damit der
        // Quellcode keine echten Personen/Firmen-Namen leakt.
        dataController: '',
        labels: {
            owner1: 'Eigentümer 1',
            owner2: 'Eigentümer 2',
        },
    };

    /* Seed nur für die allererste Installation eines neuen Geräts. Ein
     * generischer Admin mit Default-Passwort, damit der Owner sich erstmals
     * einloggen und alle echten Mitarbeiter anlegen kann. WICHTIG: das
     * Passwort sofort nach erstem Login ändern. */
    const DEFAULT_STATE = {
        employees: [
            {
                id: 1,
                name: 'Admin',
                password: 'paralox',
                isAdmin: true,
                isAccountant: false,
                isActive: true,
                rvBefreit: false,
                rvHistorie: [],
                assignedTo: 'owner1',
                monatspauschale: 0,
                pauschaleAb: '',
                createdAt: new Date().toISOString(),
            },
        ],
        shifts: [],
        settings: DEFAULT_SETTINGS,
        pinboard: { text: '', updatedAt: null, updatedBy: null },
        adminNotes: '',
        updatedAt: new Date().toISOString(),
    };

    function load() {
        try {
            const raw = localStorage.getItem(KEY);
            if (!raw) return seed();
            const data = JSON.parse(raw);
            return normalize(data);
        } catch (e) {
            console.warn('Storage-Lesefehler, starte neu', e);
            return seed();
        }
    }

    function seed() {
        const data = JSON.parse(JSON.stringify(DEFAULT_STATE));
        save(data);
        return data;
    }

    // Nicht-negative Zahl oder 0. Für Lohnsätze, die nie negativ sein dürfen.
    function wageNum(v) {
        const n = Number(v);
        return isFinite(n) && n >= 0 ? n : 0;
    }
    // Lokales Tagesdatum als ISO YYYY-MM-DD (für gueltigAb-Fallback ohne Schichten).
    function todayISODate() {
        const d = new Date();
        const tz = d.getTimezoneOffset() * 60000;
        return new Date(d.getTime() - tz).toISOString().slice(0, 10);
    }
    // Lokaler Monat als YYYY-MM (Fallback-Stichtag der RV-Historie, siehe unten).
    function todayISOMonth() {
        return todayISODate().slice(0, 7);
    }

    // Stellt sicher dass alle Felder vorhanden sind, auch bei alten Datensätzen
    function normalize(data) {
        if (!data || typeof data !== 'object') return seed();
        data.employees = Array.isArray(data.employees) ? data.employees : [];
        data.shifts    = Array.isArray(data.shifts) ? data.shifts : [];
        data.settings  = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
        // Räume NICHT mit Defaults mergen — sonst würden bei vorhandenen
        // echten Räumen die generischen Platzhalter R1/R2 zusätzlich
        // erscheinen. Defaults nur, wenn rooms ganz fehlt oder leer ist.
        const existingRooms = data.settings.rooms || {};
        data.settings.rooms = Object.keys(existingRooms).length > 0
            ? existingRooms
            : Object.assign({}, DEFAULT_SETTINGS.rooms);
        // Labels (Anzeige-Namen für die Eigentümer in Listen/PDF) — Defaults
        // füllen fehlende Felder, vorhandene Werte bleiben.
        data.settings.labels = Object.assign(
            {}, DEFAULT_SETTINGS.labels, data.settings.labels || {});
        if (typeof data.settings.dataController !== 'string') {
            data.settings.dataController = '';
        }
        if (typeof data.settings.rvAnteilProzent !== 'number' || isNaN(data.settings.rvAnteilProzent)) {
            data.settings.rvAnteilProzent = DEFAULT_SETTINGS.rvAnteilProzent;
        }
        // Migration: Lohnhistorie. Früher galten die zentralen Sätze
        // wageSingle/wageDouble rückwirkend für ALLE Schichten — eine
        // Lohnerhöhung hätte die Verdienste alter Schichten verändert. Jetzt
        // führen wir datierte Sätze. Beim ersten Lauf wandern die bisherigen
        // Sätze als erster Eintrag in die Historie, gültig ab der ältesten
        // vorhandenen Schicht, damit JEDE bestehende Schicht abgedeckt bleibt
        // und ihren Verdienst exakt behält.
        if (!Array.isArray(data.settings.wageHistory) || data.settings.wageHistory.length === 0) {
            let oldest = '';
            data.shifts.forEach(s => {
                if (s && typeof s.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date)) {
                    if (!oldest || s.date < oldest) oldest = s.date;
                }
            });
            data.settings.wageHistory = [{
                gueltigAb: oldest || todayISODate(),
                single: wageNum(data.settings.wageSingle),
                double: wageNum(data.settings.wageDouble),
            }];
        }
        // Bereinigen, defensiv parsen und chronologisch sortieren. Doppelte
        // Stichtage werden zusammengeführt (späterer Eintrag im Array gewinnt),
        // damit pro Datum genau ein Satz gilt.
        const byDate = {};
        data.settings.wageHistory.forEach(h => {
            if (h && typeof h.gueltigAb === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h.gueltigAb)) {
                byDate[h.gueltigAb] = { gueltigAb: h.gueltigAb, single: wageNum(h.single), double: wageNum(h.double) };
            }
        });
        data.settings.wageHistory = Object.values(byDate)
            .sort((a, b) => a.gueltigAb.localeCompare(b.gueltigAb));
        // Falls nach der Bereinigung nichts übrig blieb (kaputte Daten), aus den
        // Alt-Feldern neu aufbauen, damit die Historie nie leer ist.
        if (data.settings.wageHistory.length === 0) {
            data.settings.wageHistory = [{
                gueltigAb: todayISODate(),
                single: wageNum(data.settings.wageSingle),
                double: wageNum(data.settings.wageDouble),
            }];
        }
        // wageSingle/wageDouble als Spiegel des jüngsten Eintrags pflegen.
        const latestWage = data.settings.wageHistory[data.settings.wageHistory.length - 1];
        data.settings.wageSingle = latestWage.single;
        data.settings.wageDouble = latestWage.double;
        data.settings.dailyBackup = Object.assign(
            {}, DEFAULT_SETTINGS.dailyBackup, data.settings.dailyBackup || {});
        if (typeof data.settings.dailyBackup.enabled !== 'boolean') {
            data.settings.dailyBackup.enabled = false;
        }
        if (typeof data.settings.dailyBackup.recipient !== 'string') {
            data.settings.dailyBackup.recipient = DEFAULT_SETTINGS.dailyBackup.recipient;
        }
        data.settings.monthlyArchive = Object.assign(
            {}, DEFAULT_SETTINGS.monthlyArchive, data.settings.monthlyArchive || {});
        if (typeof data.settings.monthlyArchive.enabled !== 'boolean') {
            data.settings.monthlyArchive.enabled = DEFAULT_SETTINGS.monthlyArchive.enabled;
        }
        if (typeof data.settings.monthlyArchive.recipient !== 'string') {
            data.settings.monthlyArchive.recipient = DEFAULT_SETTINGS.monthlyArchive.recipient;
        }
        data.pinboard  = Object.assign({ text: '', updatedAt: null, updatedBy: null }, data.pinboard || {});
        if (typeof data.adminNotes !== 'string') data.adminNotes = '';
        data.updatedAt = data.updatedAt || new Date().toISOString();
        // Ältester Schicht-Monat je Mitarbeiter — Ankerpunkt für die Migration der
        // RV-Historie (siehe unten), damit der erste Eintrag jede bestehende
        // Schicht abdeckt.
        const oldestMonthByEmp = {};
        data.shifts.forEach(s => {
            if (!s || typeof s.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) return;
            const m = s.date.slice(0, 7);
            const cur = oldestMonthByEmp[s.employeeId];
            if (!cur || m < cur) oldestMonthByEmp[s.employeeId] = m;
        });
        // Sicherstellen dass jeder Mitarbeiter ein assignedTo hat
        data.employees.forEach(e => {
            if (e.assignedTo !== 'owner1' && e.assignedTo !== 'owner2') {
                e.assignedTo = (e.name && e.name.toLowerCase() === 'owner2') ? 'owner2' : 'owner1';
            }
            if (typeof e.password !== 'string') e.password = 'paralox';
            // Migration: bestehende Mitarbeiter sind standardmäßig RV-pflichtig
            // (rvBefreit=false). Befreiung muss aktiv per Häkchen gesetzt werden.
            if (typeof e.rvBefreit !== 'boolean') e.rvBefreit = false;
            // Migration: datierte RV-Historie. Früher galt der Boolean rvBefreit
            // rückwirkend für ALLE Monate — ein Statuswechsel hätte die
            // Abrechnung vergangener Monate nachträglich verändert. Jetzt gilt
            // jeder Eintrag { gueltigAb, befreit } ab seinem Stichtag (inklusive)
            // bis zum nächsten Eintrag. Beim ersten Lauf wandert der bisherige
            // Status als einziger Eintrag in die Historie, gültig ab dem ältesten
            // Schicht-Monat des Mitarbeiters. Dadurch bleibt sein Status in JEDEM
            // bestehenden Monat exakt derselbe wie vorher — die Migration ändert
            // keine einzige Abrechnung.
            if (!Array.isArray(e.rvHistorie) || e.rvHistorie.length === 0) {
                e.rvHistorie = [{
                    gueltigAb: oldestMonthByEmp[e.id] || todayISOMonth(),
                    befreit: e.rvBefreit,
                }];
            }
            // Bereinigen, defensiv parsen und chronologisch sortieren. Doppelte
            // Stichtage werden zusammengeführt (späterer Eintrag im Array gewinnt),
            // damit pro Monat genau ein Status gilt.
            const rvByMonth = {};
            e.rvHistorie.forEach(h => {
                if (h && typeof h.gueltigAb === 'string' && /^\d{4}-\d{2}$/.test(h.gueltigAb)) {
                    rvByMonth[h.gueltigAb] = { gueltigAb: h.gueltigAb, befreit: !!h.befreit };
                }
            });
            e.rvHistorie = Object.values(rvByMonth)
                .sort((a, b) => a.gueltigAb.localeCompare(b.gueltigAb));
            // Falls nach der Bereinigung nichts übrig blieb (kaputte Daten), aus
            // dem Alt-Feld neu aufbauen, damit die Historie nie leer ist.
            if (e.rvHistorie.length === 0) {
                e.rvHistorie = [{
                    gueltigAb: oldestMonthByEmp[e.id] || todayISOMonth(),
                    befreit: e.rvBefreit,
                }];
            }
            // rvBefreit als Spiegel des jüngsten Eintrags pflegen — analog zu
            // wageSingle/wageDouble. Reine Anzeige ("aktueller Status"); für jede
            // Berechnung ist die Historie maßgeblich.
            e.rvBefreit = e.rvHistorie[e.rvHistorie.length - 1].befreit;
            // Migration: Monatspauschale (EUR/Monat) — zusätzlicher fester Lohn-
            // Bestandteil neben den Schichten. Default 0 bedeutet "keine Pauschale".
            if (typeof e.monatspauschale !== 'number' || !isFinite(e.monatspauschale) || e.monatspauschale < 0) {
                e.monatspauschale = 0;
            }
            // Migration: Stichtag (YYYY-MM), ab dem die Monatspauschale gilt.
            // Vor der Einführung des Stichtags wurde die Pauschale rückwirkend in
            // ALLEN Monaten mit Schichten verrechnet. Bestehende Pauschalen werden
            // daher auf den Einführungsmonat 2026-06 datiert, damit sie nicht
            // weiter rückwirkend in ältere Monate fließen. Leerer String = keine
            // Beschränkung (Pauschale gilt in allen Monaten — z. B. wenn keine
            // Pauschale gesetzt ist).
            if (typeof e.pauschaleAb !== 'string' || !/^\d{4}-\d{2}$/.test(e.pauschaleAb)) {
                e.pauschaleAb = e.monatspauschale > 0 ? '2026-06' : '';
            }
        });
        return data;
    }

    function save(data) {
        data.updatedAt = new Date().toISOString();
        localStorage.setItem(KEY, JSON.stringify(data));
        // Event für Drive-Sync
        window.dispatchEvent(new CustomEvent('paralox:changed', { detail: { updatedAt: data.updatedAt } }));
    }

    // Ersetzt die komplette Datenbasis — wird vom Drive-Sync verwendet
    function replace(data) {
        const norm = normalize(data);
        localStorage.setItem(KEY, JSON.stringify(norm));
        return norm;
    }

    // Session (nur im sessionStorage, NICHT in Drive synchronisiert)
    function getSession() {
        try {
            const raw = sessionStorage.getItem(SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }
    function setSession(userId) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ uid: userId, ts: Date.now() }));
    }
    function clearSession() {
        sessionStorage.removeItem(SESSION_KEY);
    }

    function getLastBackupDate() {
        return localStorage.getItem(LAST_BACKUP_KEY) || null;
    }
    function setLastBackupDate(isoDate) {
        if (isoDate) localStorage.setItem(LAST_BACKUP_KEY, isoDate);
        else localStorage.removeItem(LAST_BACKUP_KEY);
    }
    function getLastMonthlyArchive() {
        return localStorage.getItem(LAST_MONTHLY_KEY) || null;
    }
    function setLastMonthlyArchive(yyyymm) {
        if (yyyymm) localStorage.setItem(LAST_MONTHLY_KEY, yyyymm);
        else localStorage.removeItem(LAST_MONTHLY_KEY);
    }
    /* DSGVO-Bestätigung pro Mitarbeiter (employeeId → ISO-Zeitpunkt). Damit
     * jeder Mitarbeiter den Hinweis einmal selbst bestätigen muss, nicht nur
     * der erste der das Tablet einrichtet. Alte String-Werte (gerätespezi-
     * fischer Marker aus früheren Versionen) werden beim ersten Lesen
     * ignoriert — alle User sehen das Popup dann beim nächsten Login einmalig. */
    function _readDsgvoMap() {
        try {
            const raw = localStorage.getItem(DSGVO_ACCEPTED_KEY);
            if (!raw) return {};
            const obj = JSON.parse(raw);
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
            return obj;
        } catch { return {}; }
    }
    function getDsgvoAccepted(employeeId) {
        if (employeeId == null) return null;
        return _readDsgvoMap()[String(employeeId)] || null;
    }
    function setDsgvoAccepted(employeeId, iso) {
        if (employeeId == null) return;
        const map = _readDsgvoMap();
        if (iso) map[String(employeeId)] = iso;
        else delete map[String(employeeId)];
        localStorage.setItem(DSGVO_ACCEPTED_KEY, JSON.stringify(map));
    }
    function getBackupPassword() {
        return localStorage.getItem(BACKUP_PASSWORD_KEY) || null;
    }
    function setBackupPassword(pw) {
        if (pw) localStorage.setItem(BACKUP_PASSWORD_KEY, pw);
        else localStorage.removeItem(BACKUP_PASSWORD_KEY);
    }
    function getRunningShifts() {
        try { return JSON.parse(localStorage.getItem(RUNNING_SHIFTS_KEY) || '{}'); }
        catch { return {}; }
    }
    function getRunningShift(employeeId) {
        const map = getRunningShifts();
        return map[String(employeeId)] || null;
    }
    function setRunningShift(employeeId, data) {
        const map = getRunningShifts();
        if (!data) delete map[String(employeeId)];
        else map[String(employeeId)] = data;
        localStorage.setItem(RUNNING_SHIFTS_KEY, JSON.stringify(map));
    }
    function clearRunningShift(employeeId) {
        setRunningShift(employeeId, null);
    }

    function nextId(items) {
        let max = 0;
        items.forEach(i => { if (+i.id > max) max = +i.id; });
        return max + 1;
    }

    window.ParaloxStorage = {
        KEY,
        DEFAULT_SETTINGS,
        load, save, replace,
        getSession, setSession, clearSession,
        getLastBackupDate, setLastBackupDate,
        getLastMonthlyArchive, setLastMonthlyArchive,
        getDsgvoAccepted, setDsgvoAccepted,
        getBackupPassword, setBackupPassword,
        getRunningShift, setRunningShift, clearRunningShift,
        nextId,
    };
})();
