/* Paralox Stundenverwaltung - OneDrive Sync via MSAL.js (Authorization Code + PKCE)
 *
 * Nutzt Microsoft's offizielle MSAL.js-Bibliothek für OAuth 2.0 mit PKCE-Redirect-Flow.
 * Funktioniert zuverlässig auf mobilen Browsern (Brave/Chrome auf Android), weil:
 *  - kein Popup verwendet wird
 *  - PKCE den Client-Secret-Bedarf eliminiert (echter SPA-Flow)
 *  - die Standard-Browser-Navigation für den Login-Wechsel benutzt wird
 *
 * Speichert die Datenbasis im OneDrive-App-Ordner ("Apps/<App-Name>") des
 * eingeloggten Microsoft-Kontos. Der App-Ordner ist nur für diese App sichtbar.
 *
 * Der Public-API-Vertrag (init/pull/pushNow) bleibt identisch — app.js braucht
 * keine Änderungen.
 */
(() => {
    'use strict';

    const SCOPES = ['Files.ReadWrite', 'offline_access'];
    const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0/me/drive/root';
    const FILE_ID_KEY = 'paraloxOneDrive.fileId';
    const UPLOAD_DEBOUNCE_MS = 2000;

    const cfg = window.ParaloxConfig || {};
    const fileName = cfg.driveFileName || 'paralox-stunden.json';
    const folder   = (cfg.driveFolder || 'Paralox').replace(/^\/+|\/+$/g, '');
    // Pfad-basierte Adressierung: "/me/drive/root:/Paralox/paralox-stunden.json"
    const filePath = folder ? `${folder}/${fileName}` : fileName;
    const filePathEnc = filePath.split('/').map(encodeURIComponent).join('/');

    const statusEl = () => document.getElementById('driveStatus');
    const altEl    = () => document.getElementById('driveAlt');
    const altLink  = () => document.getElementById('driveAltLink');

    function setStatus(kind, label, title) {
        const el = statusEl();
        if (!el) return;
        el.className = 'drive-status ' + kind;
        el.textContent = label;
        if (title) el.title = title;
        el.classList.remove('hidden');
    }

    function showAltLink(visible) {
        const el = altEl();
        if (!el) return;
        el.classList.toggle('hidden', !visible);
    }

    function getFileId()   { return localStorage.getItem(FILE_ID_KEY) || null; }
    function setFileId(id) { localStorage.setItem(FILE_ID_KEY, id); }

    // ---------- MSAL ----------

    let msalInstance = null;
    let msalReady    = false;
    let activeAccount = null;
    let uploadTimer = null;
    let syncInFlight = false;

    async function ensureMsalLoaded(maxMs = 8000) {
        const start = Date.now();
        while ((!window.msal || !window.msal.PublicClientApplication) && Date.now() - start < maxMs) {
            await new Promise(r => setTimeout(r, 100));
        }
        return !!(window.msal && window.msal.PublicClientApplication);
    }

    async function ensureMsal() {
        if (msalReady) return msalInstance;
        const ok = await ensureMsalLoaded();
        if (!ok) throw new Error('MSAL-Bibliothek konnte nicht geladen werden.');
        // Authority: bei gesetzter Tenant-ID single-tenant, sonst 'common' (multi-tenant + personal)
        const tenant = (cfg.msTenantId || 'common').trim() || 'common';
        const authorityUrl = `https://login.microsoftonline.com/${tenant}/`;
        msalInstance = new window.msal.PublicClientApplication({
            auth: {
                clientId: cfg.msClientId,
                authority: authorityUrl,
                knownAuthorities: ['login.microsoftonline.com'],
                redirectUri: window.location.origin + window.location.pathname,
                postLogoutRedirectUri: window.location.origin + window.location.pathname,
                // KRITISCH: false vermeidet Redirect-Schleife, wenn redirectUri == aktuelle Seite.
                // Microsoft-Doku: bei gleicher URL muss dieser Wert false sein, sonst Loop.
                navigateToLoginRequestUrl: false,
            },
            cache: {
                cacheLocation: 'localStorage',
                // true hilft auf mobilen Browsern (Brave/Safari Android), die Storage
                // zwischen Redirects manchmal verwerfen — Cookie-Fallback verhindert
                // PKCE-Verifier-Verlust und damit Re-Login-Schleifen
                storeAuthStateInCookie: true,
            },
            system: {
                allowNativeBroker: false,
                loggerOptions: {
                    logLevel: window.msal && window.msal.LogLevel ? window.msal.LogLevel.Warning : 0,
                },
            },
        });
        await msalInstance.initialize();
        msalReady = true;
        return msalInstance;
    }

    async function handleRedirect() {
        const app = await ensureMsal();
        try {
            const result = await app.handleRedirectPromise();
            if (result && result.account) {
                activeAccount = result.account;
                app.setActiveAccount(result.account);
                return { account: result.account };
            }
            // Kein Redirect aktiv — vorhandene Konten prüfen
            const accounts = app.getAllAccounts();
            if (accounts.length > 0) {
                activeAccount = app.getActiveAccount() || accounts[0];
                app.setActiveAccount(activeAccount);
            }
            return null;
        } catch (e) {
            console.warn('handleRedirectPromise error', e);
            return { error: e.message || String(e) };
        }
    }

    async function getAccessToken() {
        const app = await ensureMsal();
        const account = activeAccount || app.getActiveAccount() || app.getAllAccounts()[0];
        if (!account) return null;
        try {
            const result = await app.acquireTokenSilent({ scopes: SCOPES, account });
            return result.accessToken;
        } catch (e) {
            // InteractionRequiredAuthError → Redirect notwendig
            console.warn('Silent token failed; redirect erforderlich', e);
            return null;
        }
    }

    async function startLogin() {
        try {
            const app = await ensureMsal();
            const req = {
                scopes: SCOPES,
                prompt: 'select_account',
            };
            // Domain-Hint: springt direkt zur Tenant-Login-Seite, kein "Welches Konto?"-Schritt
            if (cfg.msDomainHint) {
                req.extraQueryParameters = { domain_hint: cfg.msDomainHint };
            }
            await app.loginRedirect(req);
        } catch (e) {
            console.error('loginRedirect error', e);
            setStatus('error', '⚠ OneDrive', 'Login-Fehler: ' + (e.message || e));
        }
    }

    async function startReauth() {
        try {
            const app = await ensureMsal();
            await app.acquireTokenRedirect({ scopes: SCOPES });
        } catch (e) {
            console.error('acquireTokenRedirect error', e);
            setStatus('error', '⚠ OneDrive', 'Re-Auth-Fehler: ' + (e.message || e));
        }
    }

    // ---------- Microsoft Graph ----------

    async function authedFetch(url, opts = {}) {
        const token = await getAccessToken();
        if (!token) throw new Error('OneDrive nicht verbunden.');
        const headers = Object.assign({}, opts.headers || {}, {
            Authorization: `Bearer ${token}`,
        });
        const res = await fetch(url, Object.assign({}, opts, { headers }));
        return res;
    }

    async function fileMetadata() {
        const url = `${GRAPH_ROOT}:/${filePathEnc}`;
        const res = await authedFetch(url);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('Drive-Metadaten-Fehler: ' + res.status);
        const j = await res.json();
        if (j.id) setFileId(j.id);
        return j;
    }

    async function downloadFile() {
        const url = `${GRAPH_ROOT}:/${filePathEnc}:/content`;
        const res = await authedFetch(url);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('Download fehlgeschlagen: ' + res.status);
        return res.text();
    }

    async function uploadFile(content) {
        // PUT auf den Pfad legt die Datei an (oder ersetzt sie); fehlende Ordner werden
        // bei diesem Endpoint mit erstellt.
        const url = `${GRAPH_ROOT}:/${filePathEnc}:/content`;
        const res = await authedFetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: content,
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error('Upload fehlgeschlagen: ' + res.status + ' ' + errText.slice(0, 200));
        }
        const j = await res.json().catch(() => null);
        if (j && j.id) setFileId(j.id);
        return j;
    }

    // ---------- Public API (kompatibel mit altem drive.js) ----------

    async function pull() {
        if (!cfg.msClientId) return;
        setStatus('sync', '⟳ OneDrive', 'Lade aus OneDrive...');
        try {
            const meta = await fileMetadata();
            const local = window.ParaloxStorage.load();

            if (!meta) {
                await uploadFile(JSON.stringify(local, null, 2));
                setStatus('ok', '✓ OneDrive', 'Neue Datei in OneDrive angelegt');
                showAltLink(false);
                return;
            }

            const text = await downloadFile();
            if (!text) {
                await uploadFile(JSON.stringify(local, null, 2));
                setStatus('ok', '✓ OneDrive', 'Lokal nach OneDrive hochgeladen');
                showAltLink(false);
                return;
            }

            const remote = JSON.parse(text);
            const remoteTs = remote?.updatedAt ? Date.parse(remote.updatedAt) : 0;
            const localTs  = local?.updatedAt  ? Date.parse(local.updatedAt)  : 0;

            if (remoteTs > localTs) {
                window.ParaloxStorage.replace(remote);
                window.dispatchEvent(new CustomEvent('paralox:external-update'));
                setStatus('ok', '✓ OneDrive', 'Aus OneDrive übernommen (' + new Date(remoteTs).toLocaleString('de-DE') + ')');
            } else if (localTs > remoteTs) {
                await uploadFile(JSON.stringify(local, null, 2));
                setStatus('ok', '✓ OneDrive', 'Lokaler Stand nach OneDrive hochgeladen');
            } else {
                setStatus('ok', '✓ OneDrive', 'Synchron');
            }
            showAltLink(false);
        } catch (e) {
            console.warn('OneDrive pull error', e);
            setStatus('error', '⚠ OneDrive', 'Sync-Fehler: ' + e.message);
        }
    }

    async function pushNow() {
        if (!cfg.msClientId) return;
        const token = await getAccessToken();
        if (!token) return; // ohne Token nichts versuchen
        if (syncInFlight) return;
        syncInFlight = true;
        setStatus('sync', '⟳ OneDrive', 'Speichere in OneDrive...');
        try {
            const data = window.ParaloxStorage.load();
            await uploadFile(JSON.stringify(data, null, 2));
            setStatus('ok', '✓ OneDrive', 'Gespeichert in OneDrive');
        } catch (e) {
            console.warn('OneDrive push error', e);
            setStatus('error', '⚠ OneDrive', 'Upload fehlgeschlagen: ' + e.message);
        } finally {
            syncInFlight = false;
        }
    }

    function schedulePush() {
        if (!cfg.msClientId) return;
        if (uploadTimer) clearTimeout(uploadTimer);
        uploadTimer = setTimeout(pushNow, UPLOAD_DEBOUNCE_MS);
    }

    async function init() {
        const el = statusEl();
        if (!el) return;
        el.classList.remove('hidden');

        if (!cfg.msClientId) {
            setStatus('warn', '⊘ OneDrive', 'Nicht eingerichtet — siehe SETUP.md.');
            el.removeAttribute('href');
            el.onclick = (ev) => {
                ev.preventDefault();
                alert('OneDrive ist nicht eingerichtet.\nBitte msClientId in config.js eintragen.');
            };
            return;
        }

        setStatus('sync', '⟳ OneDrive', 'Lade Microsoft-Bibliothek...');
        let app;
        try {
            app = await ensureMsal();
        } catch (e) {
            setStatus('error', '⚠ OneDrive', e.message);
            return;
        }

        // 1. Falls Seite gerade nach Microsoft-Login zurückkehrt: Auth abschließen
        const redirectResult = await handleRedirect();
        if (redirectResult && redirectResult.error) {
            setStatus('error', '⚠ OneDrive', 'Login-Fehler: ' + redirectResult.error);
        }

        // 2. Beide Buttons (Top-Status + Fallback-Banner) initiieren den Login
        const loginHandler = (ev) => {
            ev.preventDefault();
            startLogin();
        };
        el.removeAttribute('href');
        el.onclick = loginHandler;

        const alt = altLink();
        if (alt) {
            alt.removeAttribute('href');
            alt.onclick = loginHandler;
        }

        // 3. Wenn Token bereits silent verfügbar: synchronisieren
        const token = await getAccessToken();
        if (token) {
            try {
                await pull();
                showAltLink(false);
            } catch (e) {
                setStatus('error', '⚠ OneDrive', 'Sync-Fehler: ' + e.message);
            }
        } else if (!redirectResult || !redirectResult.error) {
            setStatus('warn', '◌ OneDrive', 'Tippen zum Verbinden');
        }

        // 4. Lokale Änderungen → debounced upload
        window.addEventListener('paralox:changed', schedulePush);

        // 5. Cross-Tab-Sync: andere Tabs schreiben MSAL-Tokens in localStorage
        window.addEventListener('storage', (ev) => {
            if (!ev.key) return;
            // MSAL-Schlüssel beginnen mit msal. — ein neues Token in einem anderen Tab
            // bedeutet, dass dort ein Login erfolgt ist
            if (!ev.key.startsWith('msal.')) return;
            (async () => {
                try {
                    if (await getAccessToken()) {
                        setStatus('ok', '✓ OneDrive', 'Verbunden — synchronisiere...');
                        await pull();
                        showAltLink(false);
                    }
                } catch (e) { console.warn('Cross-tab sync', e); }
            })();
        });

        // 6. Bei Rückkehr aus Hintergrund nochmal synchronisieren
        document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState !== 'visible') return;
            try {
                if (await getAccessToken()) {
                    pull().catch(e => console.warn('Visibility-Sync', e));
                }
            } catch { /* ignore */ }
        });
    }

    window.ParaloxDrive = { init, pushNow, pull, startLogin, startReauth };
})();
