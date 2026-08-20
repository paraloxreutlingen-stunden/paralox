# Paralox Stunden — Setup-Anleitung (OneDrive-Sync)

Ende-Ergebnis: Eine URL wie `https://deinusername.github.io/paralox/paralox-stunden.html`, die deine App ausliefert. Daten werden lokal im Browser gehalten und automatisch in **Microsoft OneDrive** gesichert. Funktioniert auf jedem Gerät, inklusive Android-Tablets mit Brave/Chrome.

**Architektur:** Authorization Code Flow + PKCE über die offizielle MSAL.js-Bibliothek (`@azure/msal-browser` v5.8.0), komplett im Bundle eingebettet — keine CDN-Abhängigkeit zur Laufzeit. Neuere MSAL-Versionen kannst du jederzeit nachladen mit:
```bash
curl -sS -L -o vendor/msal-browser.min.js https://cdn.jsdelivr.net/npm/@azure/msal-browser@<NEUE-VERSION>/lib/msal-browser.min.js
node build-bundle.js
```

---

## 1. App starten

**Lokal testen:** `paralox-stunden.html` über einen Webserver aufrufen (nicht direkt per Doppelklick als `file://`, sonst funktioniert OneDrive-Login nicht).

**Erst-Login:** Standard-Passwörter sind `paralox` für Eigentümer 1 und Eigentümer 2 — direkt nach dem ersten Login unter „Mitarbeiter → Passwort" ein eigenes setzen!

---

## 2. OneDrive-Sync einrichten (einmalig, ca. 10–15 Minuten)

### Schritt 1: Microsoft-Konto

Du brauchst ein Microsoft-Konto. Wenn du eines hast (Outlook, Hotmail, Live, Xbox, Office, Skype) — perfekt, das ist schon mit OneDrive verknüpft.

Falls noch nicht vorhanden: kostenlos anlegen unter https://signup.live.com — am besten ein gemeinsames Konto wie `paralox.stunden@outlook.com`, auf das beide Inhaber Zugriff haben. Das Konto bekommt **5 GB OneDrive gratis** — das reicht für eine ~50-KB-JSON-Datei tausendfach.

### Schritt 2: Azure Portal — App registrieren

1. Im Browser **https://portal.azure.com** öffnen, mit dem gemeinsamen Microsoft-Konto einloggen.
2. (Beim ersten Mal eventuell „Azure Free Trial überspringen" wählen — du brauchst kein Abo, App-Registrierung ist kostenlos.)
3. Oben in die Suche `App registrations` eingeben → den Treffer **„App registrations"** anklicken.
4. Oben auf **„+ New registration"**.
5. Ausfüllen:
   - **Name**: `Paralox Stunden`
   - **Supported account types**: **„Accounts in any organizational directory and personal Microsoft accounts"** auswählen. (Falls diese Option nicht erscheint, geht auch „Personal Microsoft accounts only".)
   - **Redirect URI** (wichtig!):
     - Plattform-Dropdown: **„Single-page application (SPA)"** auswählen.
     - Eingabefeld: deine GitHub-Pages-URL eintragen, z.B.
       `https://deinname.github.io/paralox/paralox-stunden.html`
     - **Genau diese Schreibweise** — keine `?v=…` und kein Slash am Ende.
6. Auf **„Register"** klicken.

### Schritt 3: Application (client) ID kopieren

Nach der Registrierung landest du auf der Übersichts-Seite der neuen App.

1. Oben siehst du **„Application (client) ID"** — eine UUID wie `12345678-abcd-1234-abcd-1234567890ab`.
2. Auf das **Kopier-Symbol** daneben klicken, in die Zwischenablage.

### Schritt 4: API-Berechtigungen prüfen

Diese sind meist schon richtig gesetzt, aber zur Sicherheit:

1. Links im Menü **„API permissions"** anklicken.
2. Du solltest sehen: `Microsoft Graph → User.Read` (Standard).
3. Wir brauchen zusätzlich **`Files.ReadWrite.AppFolder`** — das ist der minimale Zugriff: nur ein App-eigener Ordner in OneDrive, kein Zugriff auf andere Dateien.
4. **„+ Add a permission"** → **„Microsoft Graph"** → **„Delegated permissions"**.
5. In die Suche `Files.ReadWrite.AppFolder` eingeben → den Eintrag anhaken → **„Add permissions"**.
6. (Eine Admin-Zustimmung ist für persönliche Konten **nicht** notwendig.)

### Schritt 5: Client-ID in die App eintragen

Öffne `config.js` und trage die Client-ID ein:

```js
window.ParaloxConfig = {
    msClientId: 'DEINE-APPLICATION-CLIENT-ID',
    driveFileName: 'paralox-stunden.json',
};
```

Speichern. Bundle neu bauen mit `node build-bundle.js`. Die neue `paralox-stunden.html` auf GitHub Pages hochladen.

### Schritt 6: Verbinden auf dem Tablet

1. Im Brave/Chrome auf dem Tablet die App-URL aufrufen.
2. Du siehst oben mittig den Banner **„OneDrive nicht verbunden: → jetzt mit OneDrive verbinden"**.
3. Tippen → die ganze Seite navigiert zu `login.microsoftonline.com`.
4. Mit dem gemeinsamen Microsoft-Konto einloggen, Berechtigung („Files.ReadWrite.AppFolder") bestätigen.
5. Du wirst zurück zur App geschickt — der Status oben rechts wird zu **„✓ OneDrive"** und die Synchronisation läuft.

Auf dem zweiten Gerät (z.B. das Tablet/Laptop des zweiten Eigentümers): gleiche URL aufrufen, Banner antippen, mit demselben Microsoft-Konto einloggen — Daten werden automatisch synchronisiert.

---

## 3. Wo liegen die Daten in OneDrive?

OneDrive legt einen **App-Ordner** an unter:
```
OneDrive / Apps / Paralox Stunden / paralox-stunden.json
```

Du findest die JSON-Datei dort jederzeit zum manuellen Backup oder zur Inspektion. Andere Apps können auf diesen Ordner **nicht** zugreifen — nur die Paralox-App, weil sie mit derselben Client-ID läuft.

---

## 4. Langzeit-Pflege

- **Tokens werden automatisch erneuert** — MSAL.js holt sich silent neue Tokens, solange du beim Microsoft-Konto eingeloggt bist. Du musst dich praktisch nie wieder neu einloggen.
- **App bleibt im Microsoft Identity Platform** — keine Verifizierung nötig, weil wir nur den minimalen `Files.ReadWrite.AppFolder`-Scope nutzen.
- **Updates der App** (neue `paralox-stunden.html` von mir): einfach im GitHub-Repo die Datei überschreiben → 1–5 Minuten warten → auf dem Tablet neu laden. Die OneDrive-Verbindung bleibt erhalten.

---

## 5. Was passiert wenn OneDrive ausfällt?

Die App läuft weiter, alles wird lokal im Browser-Speicher gehalten. Sobald OneDrive wieder erreichbar ist, klick auf den Status-Button oben rechts → manueller Sync.

---

## 6. Backup außerhalb von OneDrive

Die komplette Datenbank liegt als JSON in `localStorage` unter dem Key `paraloxStunden.v1`. Im Browser mit F12 → „Anwendung" → „Local Storage" findest du alles. Einmal im Monat den Wert kopieren und als zusätzliches Backup speichern schadet nie.

Zusätzlich liegt **immer** eine aktuelle Kopie als Datei in OneDrive — die kannst du jederzeit herunterladen.

---

## 7. Fehlersuche

| Symptom | Ursache / Lösung |
|---|---|
| Banner sagt „MSAL-Bibliothek konnte nicht geladen werden" | Bundle ist unvollständig oder unvollständig hochgeladen — neue `paralox-stunden.html` per Build erstellen und vollständig auf GitHub Pages laden (sollte ca. 365 KB sein) |
| Login zeigt „AADSTS50011: redirect_uri mismatch" | Die Redirect-URI im Azure Portal stimmt nicht mit der tatsächlichen App-URL überein. Im Portal unter „Authentication" prüfen; muss SPA-Plattform sein und URL exakt gleich (HTTPS, kein `?v=…`, kein Trailing-Slash). |
| Banner sagt „OneDrive nicht verbunden" obwohl ich gerade eingeloggt bin | Cache/Cookie-Problem in Brave — einmal Brave-Shields auf „Standard" stellen, Browser-Cache leeren, neu probieren |
| „Files.ReadWrite.AppFolder" wird beim Login als Berechtigung angezeigt → ich denke das ist zu wenig | Doch — das ist exakt richtig. App liest und schreibt nur in IHREM eigenen Ordner, nicht im Rest des OneDrive |
