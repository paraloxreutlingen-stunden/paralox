/* Generiert die PWA-Icons (icons/icon-192.png + icons/icon-512.png).
 * Kommt ohne externe Lib aus — nur Node-built-in zlib + Buffer-Operationen.
 *
 * Aktuell: hellgrünes Quadrat (Paralox-Logo-Farbe #bbce00) mit schwarzem
 * stilisierten "P". Later jederzeit ersetzbar durch ein echtes Logo
 * (gleiche Maße, gleiche Dateinamen).
 *
 * Nutzung: node generate-icons.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32-Tabelle (PNG-Standard)
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/* Stilisiertes "P" als 16x16-Bitmask. 1 = Vordergrund (schwarz),
 * 0 = Hintergrund (durchscheinend → hellgrün). */
const P_MASK = [
    '0000000000000000',
    '0011111111110000',
    '0011111111111000',
    '0011000000011100',
    '0011000000011100',
    '0011000000011100',
    '0011000000011100',
    '0011111111111100',
    '0011111111111000',
    '0011000000000000',
    '0011000000000000',
    '0011000000000000',
    '0011000000000000',
    '0011000000000000',
    '0011000000000000',
    '0000000000000000',
];

function writePng(filePath, size) {
    // Hintergrund: hellgrün (#bbce00, Paralox-Logo-Farbe), Vordergrund: schwarz
    const BG = [0xbb, 0xce, 0x00, 0xff];
    const FG = [0x00, 0x00, 0x00, 0xff];
    const MASK_SIZE = 16;
    const scale = size / MASK_SIZE;

    const bytesPerRow = size * 4;
    const raw = Buffer.alloc(size * (bytesPerRow + 1));
    for (let y = 0; y < size; y++) {
        const rowOff = y * (bytesPerRow + 1);
        raw[rowOff] = 0; // Filter: none
        const my = Math.floor(y / scale);
        const row = P_MASK[my];
        for (let x = 0; x < size; x++) {
            const mx = Math.floor(x / scale);
            const fg = row[mx] === '1';
            const c = fg ? FG : BG;
            const off = rowOff + 1 + x * 4;
            raw[off]     = c[0];
            raw[off + 1] = c[1];
            raw[off + 2] = c[2];
            raw[off + 3] = c[3];
        }
    }

    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // color type RGBA
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const idat = zlib.deflateSync(raw);
    const png = Buffer.concat([
        sig,
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0)),
    ]);
    fs.writeFileSync(filePath, png);
    console.log(`✓ ${filePath} (${size}x${size}, ${(png.length / 1024).toFixed(1)} KB)`);
}

const outDir = path.join(__dirname, 'icons');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
writePng(path.join(outDir, 'icon-192.png'), 192);
writePng(path.join(outDir, 'icon-512.png'), 512);
