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

    const DEFAULT_SETTINGS = {
        wageSingle: 14,
        wageDouble: 19,
        abgabenPercent: 31.17,
        // Arbeitnehmer-Anteil zur gesetzlichen Rentenversicherung in Prozent vom
        // Brutto. Wird vom Lohn abgezogen und an die Minijob-Zentrale abgeführt,
        // wenn der Mitarbeiter nicht von der RV-Pflicht befreit ist. Stand 2026:
        // 18,6% allgemeiner Beitrag minus 15% AG-Pauschale = 3,6% AN-Anteil.
        rvAnteilProzent: 3.6,
        // Tagessicherung per Mail (Web Share / mailto-Fallback). Greift beim
        // ersten Login eines neuen Tages. Default aktiv mit der dedizierten
        // Backup-Adresse backup@example.org — der Owner kann das im
        // Settings-Tab abschalten oder die Adresse ändern.
        dailyBackup: {
            enabled: true,
            recipient: 'backup@example.org',
        },
        // Monatsabschluss-Mail beim ersten Login eines neuen Monats:
        // Minijob-PDF + CSV des Vormonats + JSON-Backup. Wird zum
        // dauerhaften Archivieren wegen Lohn-Aufbewahrungspflicht (10 Jahre,
        // § 147 AO) gedacht. Empfänger ist standardmäßig der gleiche wie
        // dailyBackup.recipient, kann aber separat eingestellt werden.
        monthlyArchive: {
            enabled: true,
            recipient: 'backup@example.org',
        },
        rooms: {
            FP: { name: 'Raum 1',        owner1: 100, owner2: 0   },
            SL: { name: 'Raum 3',  owner1: 100, owner2: 0   },
            BO: { name: 'Raum 4',  owner1: 100, owner2: 0   },
            VS: { name: 'Raum 2',          owner1: 0,   owner2: 100 },
            PB: { name: 'Raum 5',        owner1: 0,   owner2: 100 },
            WS: { name: 'Raum 6',         owner1: 50,  owner2: 50  },
        },
        doubleSplit: { main: 50, owner1: 25, owner2: 25 },
    };

    const DEFAULT_STATE = {
        employees: [
            {
                id: 1,
                name: 'Owner1',
                password: 'paralox',
                isAdmin: true,
                isAccountant: false,
                isActive: true,
                rvBefreit: false,
                assignedTo: 'owner1',
                createdAt: new Date().toISOString(),
            },
            {
                id: 2,
                name: 'Owner2',
                password: 'paralox',
                isAdmin: true,
                isAccountant: false,
                isActive: true,
                rvBefreit: false,
                assignedTo: 'owner2',
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

    // Stellt sicher dass alle Felder vorhanden sind, auch bei alten Datensätzen
    function normalize(data) {
        if (!data || typeof data !== 'object') return seed();
        data.employees = Array.isArray(data.employees) ? data.employees : [];
        data.shifts    = Array.isArray(data.shifts) ? data.shifts : [];
        data.settings  = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
        data.settings.rooms = Object.assign({}, DEFAULT_SETTINGS.rooms, data.settings.rooms || {});
        if (typeof data.settings.rvAnteilProzent !== 'number' || isNaN(data.settings.rvAnteilProzent)) {
            data.settings.rvAnteilProzent = DEFAULT_SETTINGS.rvAnteilProzent;
        }
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
        // Sicherstellen dass jeder Mitarbeiter ein assignedTo hat
        data.employees.forEach(e => {
            if (e.assignedTo !== 'owner1' && e.assignedTo !== 'owner2') {
                e.assignedTo = (e.name && e.name.toLowerCase() === 'owner2') ? 'owner2' : 'owner1';
            }
            if (typeof e.password !== 'string') e.password = 'paralox';
            // Migration: bestehende Mitarbeiter sind standardmäßig RV-pflichtig
            // (rvBefreit=false). Befreiung muss aktiv per Häkchen gesetzt werden.
            if (typeof e.rvBefreit !== 'boolean') e.rvBefreit = false;
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
        nextId,
    };
})();
