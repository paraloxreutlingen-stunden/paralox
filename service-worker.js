/* Paralox Stundenverwaltung - Service Worker
 *
 * Macht aus der Webapp eine echte PWA:
 *  - alle App-Dateien werden gecached → läuft offline
 *  - index.html wird "network-first" geladen, damit neue Versionen sofort
 *    sichtbar sind, sobald Internet da ist (Fallback: Cache)
 *  - alles andere (CSS, JS, Icons) "cache-first" → schnelles Laden
 *
 * Update-Strategie: Bei einer neuen Version unten den CACHE_VERSION-String
 * hochzählen. Beim nächsten App-Start wird der alte Cache verworfen,
 * neue Dateien gezogen.
 */
'use strict';

const CACHE_VERSION = 'paralox-v3';
const APP_SHELL = [
    './',
    './index.html',
    './style.css',
    './config.js',
    './crypto.js',
    './storage.js',
    './app.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
        )).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    // Externe CDN-Skripte (jspdf, xlsx, bcrypt) NICHT cachen — Browser-HTTP-Cache übernimmt das.
    if (url.origin !== self.location.origin) return;

    // index.html / Stamm-URL: Network-First, damit Updates sofort greifen
    const isHtml = req.mode === 'navigate'
        || url.pathname.endsWith('/')
        || url.pathname.endsWith('/index.html');
    if (isHtml) {
        event.respondWith(
            fetch(req).then((res) => {
                const copy = res.clone();
                caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
                return res;
            }).catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
        );
        return;
    }

    // Alle anderen App-Dateien: Cache-First, im Hintergrund refreshen
    event.respondWith(
        caches.match(req).then((cached) => {
            const fetchPromise = fetch(req).then((res) => {
                if (res && res.status === 200) {
                    const copy = res.clone();
                    caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
                }
                return res;
            }).catch(() => cached);
            return cached || fetchPromise;
        })
    );
});
