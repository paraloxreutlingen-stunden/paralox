/* Build-Script: erzeugt paralox-stunden.html als selbstständige Datei.
 * Nutzung:  node build-bundle.js
 *
 * - CSS aus style.css wird als <style> inline.
 * - JS aus config.js, storage.js und app.js werden als <script> inline eingebettet.
 * - OneDrive-Sync ist vorübergehend deaktiviert (App läuft rein lokal). Zum
 *   Reaktivieren: drive.js + vendor/msal-browser.min.js wieder einlesen und
 *   ins Bundle aufnehmen (siehe DRIVE_DISABLED-Marker unten).
 * - Andere CDN-Skripte (xlsx, jspdf, bcryptjs) bleiben als externe <script src>
 *   bestehen, da sie nur bei spezifischen Aktionen benötigt werden.
 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const indexHtml = read('index.html');
const styleCss  = read('style.css');
const cfgJs     = read('config.js');
const storageJs = read('storage.js');
const appJs     = read('app.js');
// DRIVE_DISABLED: const msalJs = read('vendor/msal-browser.min.js');
// DRIVE_DISABLED: const driveJs = read('drive.js');

let out = indexHtml;

// WICHTIG: replace(..., string) interpretiert $$, $&, $1 etc. im Ersetzungs-String.
// Wir nutzen daher die Funktions-Form, die diese Sonderzeichen NICHT interpretiert.
const lit = (s) => () => s;

// 1) <link rel="stylesheet" href="style.css"> -> <style>...</style>
out = out.replace(
    /<link\s+rel="stylesheet"\s+href="style\.css">/i,
    lit(`<style>\n${styleCss}\n</style>`)
);

// 2) MSAL-Kommentar-Block (deaktivierter OneDrive-Sync) komplett entfernen,
//    damit das Bundle keine OneDrive-Reste enthält. Der Block ist eindeutig
//    durch DRIVE_DISABLED_SCRIPTS markiert.
out = out.replace(
    /<!--\s*DRIVE_DISABLED_SCRIPTS[\s\S]*?-->\s*<!--\s*<script\s+src="vendor\/msal-browser[^>]*>\s*<\/script>\s*-->\s*/i,
    lit('')
);

// 3) Lokale eigene Skripte: config -> storage -> app
//    (drive.js ist im index.html als HTML-Kommentar markiert; der Regex matcht
//    inkl. dieses Kommentars bis zum app.js-Tag.)
const localScriptBlock = /<!--\s*Eigene Skripte[\s\S]*?<script\s+src="app\.js[^"]*"\s+defer><\/script>/i;
const inlineBlock = `<!-- Eingebettete Skripte: config -> storage -> app (drive deaktiviert) -->
<script>\n/* config.js */\n${cfgJs}\n</script>
<script>\n/* storage.js */\n${storageJs}\n</script>
<script>\n/* app.js */\n${appJs}\n</script>`;

if (!localScriptBlock.test(out)) {
    console.error('Konnte den lokalen Skript-Block in index.html nicht finden.');
    process.exit(1);
}
out = out.replace(localScriptBlock, lit(inlineBlock));

const target = path.join(root, 'paralox-stunden.html');
fs.writeFileSync(target, out, 'utf8');

// --- Validierung: Bundle nach dem Schreiben auf Syntaxfehler prüfen ---
// Wir extrahieren jeden <script>-Block ohne src und prüfen ihn mit dem Node-Parser.
// So fangen wir Fehler ab, die beim Inlinen entstehen (z.B. $$-Interpretation).
const scriptBlocks = [];
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, idx = 0;
while ((m = re.exec(out)) !== null) {
    scriptBlocks.push({ idx: ++idx, code: m[1], offset: m.index });
}

const { execSync } = require('child_process');
const tmpDir = require('os').tmpdir();
let hadError = false;
scriptBlocks.forEach(({ idx, code }) => {
    const tmpFile = path.join(tmpDir, `paralox-bundle-check-${process.pid}-${idx}.js`);
    fs.writeFileSync(tmpFile, code, 'utf8');
    try {
        execSync(`node --check "${tmpFile}"`, { stdio: 'pipe' });
    } catch (e) {
        hadError = true;
        const stderr = (e.stderr || '').toString();
        console.error(`\n✗ Syntaxfehler im Inline-<script>-Block #${idx}:`);
        console.error(stderr.split('\n').slice(0, 6).join('\n'));
    } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
    }
});

const stat = fs.statSync(target);
if (hadError) {
    console.error(`\n✗ Bundle wurde geschrieben (${(stat.size / 1024).toFixed(1)} KB), enthält aber JS-Fehler — NICHT hochladen!`);
    process.exit(2);
}
console.log(`✓ Geschrieben: ${target}`);
console.log(`✓ Größe: ${(stat.size / 1024).toFixed(1)} KB`);
console.log(`✓ Alle ${scriptBlocks.length} Inline-<script>-Blöcke syntaktisch valide.`);
