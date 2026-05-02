/* Paralox Stundenverwaltung - Krypto-Helfer für Backup-Verschlüsselung
 *
 * Verschlüsselt Backup-Anhänge (JSON / CSV / PDF) symmetrisch mit AES-GCM 256.
 * Der Schlüssel wird per PBKDF2 (100 000 Iter, SHA-256) aus dem in den
 * Settings hinterlegten Backup-Passwort abgeleitet.
 *
 * .enc-Dateiformat (Bytes):
 *   0..3   Magic "PXEN"      (Identifikation)
 *   4      Version           (aktuell 0x01)
 *   5..20  Salt              (16 Bytes, zufällig pro Datei → PBKDF2)
 *   21..32 IV                (12 Bytes, zufällig pro Datei → AES-GCM)
 *   33..   Ciphertext + Tag  (AES-GCM-Output, Tag liegt am Ende)
 *
 * So sind Salt und IV pro Datei eindeutig — gleiche Klartexte ergeben nie
 * gleiche Chiffrate.
 */
(() => {
    'use strict';

    const MAGIC = new Uint8Array([0x50, 0x58, 0x45, 0x4E]); // "PXEN"
    const VERSION = 0x01;
    const SALT_LEN = 16;
    const IV_LEN = 12;
    const PBKDF2_ITER = 100000;
    const KEY_BITS = 256;
    const HEADER_LEN = MAGIC.length + 1 + SALT_LEN + IV_LEN; // 33

    async function deriveKey(password, salt) {
        const baseKey = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(password),
            { name: 'PBKDF2' },
            false,
            ['deriveKey']
        );
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
            baseKey,
            { name: 'AES-GCM', length: KEY_BITS },
            false,
            ['encrypt', 'decrypt']
        );
    }

    /* Verschlüsselt einen Blob. Liefert einen neuen Blob im .enc-Format. */
    async function encryptBlob(blob, password) {
        if (!password) throw new Error('Backup-Passwort fehlt');
        const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
        const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
        const key = await deriveKey(password, salt);
        const plain = new Uint8Array(await blob.arrayBuffer());
        const ct = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv }, key, plain
        ));
        const out = new Uint8Array(HEADER_LEN + ct.length);
        let pos = 0;
        out.set(MAGIC, pos); pos += MAGIC.length;
        out[pos++] = VERSION;
        out.set(salt, pos); pos += SALT_LEN;
        out.set(iv, pos); pos += IV_LEN;
        out.set(ct, pos);
        return new Blob([out], { type: 'application/octet-stream' });
    }

    /* Entschlüsselt eine .enc-Datei. Wirft eine sprechende Exception bei
     * falschem Passwort, falschem Format oder beschädigter Datei. */
    async function decryptBlob(blob, password) {
        if (!password) throw new Error('Backup-Passwort fehlt');
        const buf = new Uint8Array(await blob.arrayBuffer());
        if (buf.length < HEADER_LEN + 16) {
            throw new Error('Datei ist zu klein, um eine verschlüsselte Sicherung zu sein.');
        }
        for (let i = 0; i < MAGIC.length; i++) {
            if (buf[i] !== MAGIC[i]) {
                throw new Error('Datei ist keine Paralox-Sicherung (PXEN-Header fehlt).');
            }
        }
        const version = buf[MAGIC.length];
        if (version !== VERSION) {
            throw new Error('Unbekannte Sicherungs-Version: ' + version);
        }
        let pos = MAGIC.length + 1;
        const salt = buf.slice(pos, pos + SALT_LEN); pos += SALT_LEN;
        const iv = buf.slice(pos, pos + IV_LEN); pos += IV_LEN;
        const ct = buf.slice(pos);
        const key = await deriveKey(password, salt);
        let plain;
        try {
            plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
        } catch {
            throw new Error('Falsches Passwort oder beschädigte Datei.');
        }
        return new Uint8Array(plain);
    }

    /* Hilfsfunktion: hängt ".enc" an einen Dateinamen, wenn noch nicht vorhanden. */
    function encName(originalName) {
        return /\.enc$/i.test(originalName) ? originalName : originalName + '.enc';
    }

    /* Hilfsfunktion: entfernt das ".enc"-Suffix für den entschlüsselten Output. */
    function originalName(encryptedName) {
        return encryptedName.replace(/\.enc$/i, '');
    }

    window.ParaloxCrypto = { encryptBlob, decryptBlob, encName, originalName };
})();
