/* Paralox Stundenverwaltung - Konfiguration
 *
 * Cloud-Sync läuft über Microsoft OneDrive (offizielle MSAL.js-Bibliothek).
 * Siehe SETUP.md für die Schritt-für-Schritt-Anleitung im Azure Portal.
 *
 * Leer lassen = Cloud-Sync deaktiviert, App läuft rein lokal.
 */
window.ParaloxConfig = {
    // Microsoft Application (client) ID aus dem Azure Portal
    // (App registrations → deine App → Overview → Application (client) ID)
    msClientId: '6a526d81-91a0-4114-9219-776be6d5a560',

    // Microsoft Authority. Mögliche Werte:
    //   ''             → 'common' = Geschäfts- + Schul- + persönliche Konten (login.live.com)
    //   'organizations'→ nur Geschäfts-/Schulkonten (Microsoft 365, Entra) — empfohlen wenn
    //                    Login an persönlichen Microsoft-Konten scheitert
    //   'consumers'    → nur persönliche Microsoft-Konten
    //   <Tenant-GUID>  → nur Konten dieses bestimmten Tenants
    msTenantId: 'organizations',

    // Optional: Domain-Hint für Tenant-Login. Bei 'organizations'/'common' leer lassen.
    msDomainHint: '',

    // Dateiname und Ordnerpfad in OneDrive (unter dem Stammverzeichnis).
    // Nicht ändern nach Erst-Setup, sonst findet die App den alten Stand nicht mehr.
    driveFolder:   'Paralox',
    driveFileName: 'paralox-stunden.json',
};
