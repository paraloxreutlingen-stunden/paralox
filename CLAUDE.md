# Paralox Stunden — Projekt-Notiz für Claude

> **WICHTIG:** Die App ist **produktiv im Einsatz**. Echte Mitarbeiter- und Schichtdaten liegen in `localStorage` (Key `paraloxStunden.v1`). Vor Änderungen an Daten-Schema, `storage.js`, `crypto.js` oder am Bundle-Output das Risiko ansprechen — kein destruktives Überschreiben ohne Migration.

## Was die App tut

Stundenverwaltung für einen Betrieb mit zwei Eigentümern (Eigentümer 1 & Eigentümer 2). Mitarbeiter erfassen Schichten (Datum/Beginn/Ende/Raum, optional Doppelüberwachung mit 2. Raum). Die App berechnet Verdienste, teilt Kosten gemäß Raum-Anteilen auf die Eigentümer auf, exportiert CSV/ODS/PDF und insbesondere ein **Minijob-PDF** (1 Seite pro Mitarbeiter pro Monat). DSGVO-Consent pro Mitarbeiter. Pinnwand-Mitteilung auf Login-Seite.

Rollen: **Admin** (alles), **Buchhaltung** (nur Lesen, max. 90 Tage zurück), normaler **Mitarbeiter** (eigene Schichten erfassen + anzeigen). Admins können Schichten für andere nachtragen.

## Architektur

- **Vanilla JS** (kein Framework). PWA mit Manifest + Service Worker.
- **Speicher:** `localStorage` (siehe `storage.js`, Key `paraloxStunden.v1`). Aktuell **kein** Server-Backend aktiv.
- **OneDrive-Sync** über MSAL.js ist im Bundle deaktiviert (Marker `DRIVE_DISABLED_SCRIPTS` in `index.html`, Filter in `build-bundle.js`). `drive.js` und `vendor/msal-browser.min.js` bleiben unverändert auf Platte — reaktivierbar.
- **Auslieferung:** Single-File-Bundle `paralox-stunden.html` (auf GitHub Pages gehostet).
- **Externe Libs** (CDN, defer): `xlsx`, `jspdf`, `jspdf-autotable`, `bcryptjs`.
- **Backups:** verschlüsselte `.enc`-Anhänge per Web-Share-API (Tagessicherung + Monatsabschluss). AES-GCM/PBKDF2 in `crypto.js`. Backup-Passwort gerätelokal, **nicht** im JSON-Backup.

## Wichtigste Dateien

| Datei | Rolle |
|---|---|
| `index.html` | Source für das Bundle (HTML-Skelett, alle Views) |
| `app.js` | Komplette App-Logik (Routing, Views, Berechnungen, Export, Backup) |
| `storage.js` | `window.ParaloxStorage` — load/save/normalize, Session, Backup-Marker, Running-Shifts |
| `crypto.js` | AES-GCM-Verschlüsselung der `.enc`-Backups |
| `drive.js` | OneDrive-Sync (im Bundle deaktiviert) |
| `config.js` | MSAL Client-ID + Tenant (für OneDrive) |
| `style.css` | Styles |
| `build-bundle.js` | Baut `paralox-stunden.html` aus den obigen Quellen, validiert Inline-JS via `node --check` |
| `paralox-stunden.html` | **Generiertes Bundle**, nicht direkt editieren |
| `decrypt.html` | Standalone-Tool zum Entschlüsseln der `.enc`-Backups außerhalb der App (offline-fähig, kein Login) — Crypto-Format gespiegelt aus `crypto.js`, muss bei Format-Änderungen mitgepflegt werden |
| `service-worker.js`, `manifest.json`, `icons/` | PWA |
| `generate-icons.js` | Icon-Generator |
| `test-*.js` | Playwright-Tests (siehe unten) |
| `SETUP.md` | OneDrive-Setup-Anleitung (für den Fall der Reaktivierung) |

## Build

```bash
node build-bundle.js
```

Inlinet `style.css`, `config.js`, `crypto.js`, `storage.js`, `app.js` in `index.html` → `paralox-stunden.html`. Validiert jeden Inline-`<script>` mit `node --check` und bricht bei Syntaxfehlern mit Exit-Code 2 ab (siehe Memory: Build-Output validieren).

**Achtung:** Nach jeder Änderung an JS/CSS/HTML neu bauen, sonst sieht das produktive Tablet die Änderung nicht.

## Skript-Lade-Reihenfolge (wichtig!)

`config.js` → `crypto.js` → `storage.js` → `app.js` (drive.js dazwischen, wenn reaktiviert)

## localStorage-Keys

| Key | Inhalt |
|---|---|
| `paraloxStunden.v1` | **Haupt-Datenbank**: `{ employees, shifts, settings, pinboard, adminNotes, updatedAt }` |
| `paraloxStunden.session` (sessionStorage) | Aktive User-Session |
| `paraloxStunden.lastBackup` | ISO-Datum letzte Tagessicherung |
| `paraloxStunden.lastMonthlyArchive` | `YYYY-MM` der letzten Monatsabschluss-Mail |
| `paraloxStunden.dsgvoAccepted` | Map `{ employeeId: ISO }` mit Consent-Zeitpunkten |
| `paraloxStunden.backupPassword` | Backup-Verschlüsselungs-Passwort (gerätelokal!) |
| `paraloxStunden.runningShifts` | Map laufender Schichten pro Mitarbeiter |

## Tests

Playwright-Tests im Root, mit `node test-*.js` einzeln ausführbar. Decken ab: Tablet-Login-Layout, Tabs pro Rolle, RV-Auszahlung, Local-Mode, Tagessicherung, Monatsabschluss-Archiv, PWA-Setup, DSGVO-Dynamik, 90-Tage-Buchhaltungs-Limit, Running-Shift-Workflow.

Tests laufen gegen **Test-Daten**, nicht gegen die produktiven Daten — beim Schreiben neuer Tests darauf achten.

## Server-Reste (Cleanup ausstehend)

`api.php`, `install.php`, `test-server.js`, `data/employees.json`, `data/shifts.json`, `data/settings.json` — Überbleibsel aus der frühen PHP-Phase, aktuell ungenutzt (`.gitignore` ignoriert `data/`). Siehe Memory `project_cleanup_reminder.md` zur Entfernung.

## Konventionen

- Code-Kommentare auf Deutsch, in vollständigen Sätzen — Begründungen, nicht Beschreibungen
- Currency-Format: `"x,yy EUR"` (Komma, Suffix), siehe `fmtEUR` in `app.js`
- Datumsformat in der UI: `DD.MM.YYYY`; intern ISO `YYYY-MM-DD`
- Niemals echte Personen-/Firmennamen oder Stundenlöhne in den Default-Werten von `storage.js` hardcoden — diese landen im öffentlichen GitHub-Repo (siehe Kommentar im `DEFAULT_SETTINGS`)
