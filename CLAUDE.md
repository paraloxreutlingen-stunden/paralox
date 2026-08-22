# Paralox Stunden — Projekt-Notiz für Claude

> **WICHTIG:** Die App ist **produktiv im Einsatz**. Echte Mitarbeiter- und Schichtdaten liegen in `localStorage` (Key `paraloxStunden.v1`). Vor Änderungen an Daten-Schema, `storage.js`, `crypto.js` oder am Bundle-Output das Risiko ansprechen — kein destruktives Überschreiben ohne Migration.

## Was die App tut

Stundenverwaltung für einen Betrieb mit zwei Eigentümern (Eigentümer 1 & Eigentümer 2). Mitarbeiter erfassen Schichten (Datum/Beginn/Ende/Raum, optional Doppelüberwachung mit 2. Raum). Admins tragen **Urlaubstage** pro Mitarbeiter ein (siehe unten). Die App berechnet Verdienste, teilt Kosten gemäß Raum-Anteilen auf die Eigentümer auf, exportiert CSV/ODS/PDF und insbesondere ein **Minijob-PDF** (1 Seite pro Mitarbeiter pro Monat). DSGVO-Consent pro Mitarbeiter. Pinnwand-Mitteilung auf Login-Seite.

Rollen: **Admin** (alles), **Buchhaltung** (nur Lesen, max. 90 Tage zurück), normaler **Mitarbeiter** (eigene Schichten erfassen + anzeigen). Admins können Schichten für andere nachtragen.

Zwei Pflicht-Modals nach dem Login (in dieser Reihenfolge, sie überlagern sich nicht): DSGVO-Consent (einmalig pro Mitarbeiter) und die jährliche **Resturlaubs-Erinnerung** (ab 30.03. bis 30.06., einmal pro Mitarbeiter und Jahr, für alle Rollen).

## Urlaubstage

Urlaubstage liegen **als Einträge in `shifts`** mit `isVacation: true` — nicht in einer eigenen Liste. Nur so fließen sie automatisch in Brutto, Minijob-Grenze, RV-Berechnung, CSV/ODS/PDF und den 90-Tage-Filter der Buchhaltung; eine Parallelliste hieße, ein Dutzend Aggregationsstellen anzufassen, und eine übersehene wäre eine still falsche Abrechnung. Sie tragen keine Uhrzeiten, keinen Raum und 0 Stunden.

Maßgeblich ist **§ 9 der Rahmenvereinbarung des Betriebs**, nicht die gesetzlichen Auffangregeln. Die Werte decken sich aber mit dem gesetzlichen Mindesturlaub.

- **Urlaubsanspruch** = `geleistete Arbeitstage im Kalenderjahr ÷ 13` (`URLAUB_TEILER`). Als Arbeitstag zählt **jeder Kalendertag mit mindestens einem Einsatz**, unabhängig von der Zahl der Räume oder Schichten — deshalb ein `Set` über die Daten. Urlaubstage selbst zählen nicht mit, sonst erhöhte genommener Urlaub den Anspruch. Deckt sich mit § 3 BUrlG: 313 Werktage ÷ 24 = 13,04. Der Anspruch wächst im laufenden Jahr mit und ist erst zum Jahresende endgültig.
- **Urlaubsentgelt** (§ 11 BUrlG): Durchschnitt der letzten 13 Wochen **vor Urlaubsantritt**, geteilt durch die tatsächlich gearbeiteten Tage in diesem Zeitraum. Bei zusammenhängenden Urlaubstagen läuft `urlaubsAntritt()` bis zum Blockanfang zurück, damit alle Tage denselben Satz bekommen — sonst stünde ein durchgehender Urlaub mit mehreren Beträgen im PDF. Frühere Urlaubstage zählen nicht in die Bemessung.
- **Der Betrag wird beim Eintragen eingefroren** (`urlaubsBetrag` im Datensatz) und NIE neu gerechnet. Der Schnitt wandert mit jeder neuen Schicht; ein laufend neu berechneter Wert würde bereits gemeldete Abrechnungen nachträglich verändern. Gleiche Linie wie `wageHistory`, `rvHistorie` und `CALC_V2_FROM_MONTH`.
- **Interne Abrechnung 50/50** auf die Eigentümer (raumlos, wie die Monatspauschale) — auch bei schiefen Raum-Anteilen.
- **Verfall zum 30. Juni des Folgejahres** (`URLAUB_VERFALL_MMDD`), abweichend von der sonst üblichen Frist zum 31. März. Resturlaub des Vorjahres erscheint als Übertrag; genommene Tage zehren zuerst den Übertrag auf, weil er zuerst verfällt. Am 30.06. selbst noch nutzbar, ab 01.07. verfallen.
- **Erinnerung** (30.03.–30.06., bestehendes Modal) erscheint nur bei tatsächlich offenem Übertrag und nennt die Zahl der Tage. Vorher wurden pauschal alle erinnert — die App kannte den Stand noch nicht.
- Tage werden über `roundTage`/`fmtTage` auf **eine** Nachkommastelle geführt — nicht erst auf Cent und dann fürs Anzeigen nochmal runden, sonst wird 0,8547 über 0,85 zu 0,8 und der Rest geht nicht auf.
- An einem Urlaubstag lässt sich keine Schicht erfassen und umgekehrt (`validateShiftPayload`).

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
| `LICENSE` | „Alle Rechte vorbehalten" — der Code ist öffentlich einsehbar, aber nicht zur Nutzung freigegeben. Ausgenommen: `vendor/msal-browser.min.js` (MIT, Microsoft) und die per CDN geladenen Bibliotheken. Bei neuem Fremdcode im Repo hier ergänzen |

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
| `paraloxStunden.shiftDrafts` | Map halbfertiger Formular-Eingaben pro Mitarbeiter — damit eine angefangene Schicht den Auto-Logout übersteht. **Keine** erfasste Schicht: taucht in keiner Auswertung, keinem Export und keinem Backup auf, wird beim Speichern/Starten verworfen |
| `paraloxStunden.vacationReminder` | Map `{ employeeId: ISO }` — Kenntnisnahme der jährlichen Resturlaubs-Erinnerung (Jahr im Zeitstempel entscheidet) |

## Tests

Playwright-Tests im Root, mit `node test-*.js` einzeln ausführbar. Decken ab: Tablet-Login-Layout, Tabs pro Rolle, RV-Auszahlung, Local-Mode, Tagessicherung, Monatsabschluss-Archiv, PWA-Setup, DSGVO-Dynamik, 90-Tage-Buchhaltungs-Limit, Running-Shift-Workflow, Auto-Logout (`test-auto-logout.js`: fälscht die Uhr per `page.clock`, damit die Frist nicht real abgewartet werden muss; liest `IDLE_TIMEOUT_MS` aus `app.js`, statt die Zahl zu duplizieren), Formular-Entwurf (`test-shift-draft.js`), Urlaubstage (`test-urlaub.js`: 13-Wochen-Schnitt, eingefrorener Betrag, Urlaubsantritt bei zusammenhängenden Tagen, 50/50-Aufteilung gegen einen schiefen Raum geprüft, Restkonto, Konflikt Schicht/Urlaub), Urlaubs-Verfall (`test-urlaub-verfall.js`: Übertrag aus dem Vorjahr, Verfall zum 30.06., Erinnerung nur bei offenem Übertrag), Eigentümer-Schlüssel-Migration (`test-owner-migration.js`: lädt Daten im alten Format mit asymmetrischen Raum-Anteilen und prüft, dass sich nach der Migration kein Betrag ändert), Resturlaubs-Erinnerung (`test-urlaub-erinnerung.js`: fälscht die Systemzeit der Seite per `addInitScript`, damit der Test ganzjährig läuft), Rechnungs-Stichtag (`test-calc-cutoff.js`: ab `CALC_V2_FROM_MONTH` = 2026-08 wird jeder Schicht-Betrag EINMAL auf Cent gerundet und alle Summen daraus gebildet — jede Schicht zeigt überall denselben Betrag, Verdienst = Brutto = Zeilensumme; frühere Monate rechnen unverändert wie zuvor).

Ausführung braucht `playwright-core` (`npm i --no-save playwright-core`, lokales Chrome wird genutzt) und einen statischen Server auf `:8080`, der `paralox-stunden.html` ausliefert.

Tests laufen gegen **Test-Daten**, nicht gegen die produktiven Daten — beim Schreiben neuer Tests darauf achten.

## Server-Reste (Cleanup ausstehend)

`api.php`, `install.php`, `test-server.js`, `data/employees.json`, `data/shifts.json`, `data/settings.json` — Überbleibsel aus der frühen PHP-Phase, aktuell ungenutzt (`.gitignore` ignoriert `data/`). Siehe Memory `project_cleanup_reminder.md` zur Entfernung.

## Konventionen

- Code-Kommentare auf Deutsch, in vollständigen Sätzen — Begründungen, nicht Beschreibungen
- Currency-Format: `"x,yy EUR"` (Komma, Suffix), siehe `fmtEUR` in `app.js`
- Datumsformat in der UI: `DD.MM.YYYY`; intern ISO `YYYY-MM-DD`
- Niemals echte Personen-/Firmennamen, Raumnamen, Anteile oder Stundenlöhne in Default-/Seed-Werten hardcoden — das Repo ist **öffentlich**. Betrifft `storage.js` (`DEFAULT_SETTINGS`), `install.php` und `test-server.js`
- Die beiden Eigentümer heißen im Code durchgängig `owner1`/`owner2` — als Datenschlüssel (Raum-Anteile, `doubleSplit`, `assignedTo`) und in den Anzeige-Labels (`settings.labels`). Die echten Namen stehen ausschließlich in `settings.labels` auf dem jeweiligen Gerät und werden über `ownerLabel()` bzw. `owner1Label()`/`owner2Label()` ausgegeben. Nie einen Personennamen fest in Überschriften, Exportspalten oder PDFs schreiben
- Ausnahme: `migrateOwnerKeys()` in `storage.js` nennt die alten Schlüssel noch, weil es sie zum Lesen bestehender Daten und Backups braucht. Kann entfallen, sobald alle Geräte und aufbewahrten `.enc`-Backups migriert sind
