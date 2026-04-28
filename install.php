<?php
/**
 * Paralox Stundenverwaltung - Installer
 * Einmal im Browser aufrufen, um das data/ Verzeichnis und den ersten Admin anzulegen.
 * Nach erfolgreicher Installation diese Datei bitte löschen!
 */

declare(strict_types=1);

$DATA_DIR  = __DIR__ . '/data';
$EMP_FILE  = $DATA_DIR . '/employees.json';
$SHIFT_FILE= $DATA_DIR . '/shifts.json';
$SET_FILE  = $DATA_DIR . '/settings.json';
$HTACCESS  = $DATA_DIR . '/.htaccess';

function h($s) { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }

$alreadyInstalled = is_file($EMP_FILE) && filesize($EMP_FILE) > 2;
$done = false;
$error = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST' && !$alreadyInstalled) {
    $name = trim((string)($_POST['name'] ?? ''));
    $pin  = (string)($_POST['pin'] ?? '');
    $pin2 = (string)($_POST['pin2'] ?? '');
    if ($name === '') $error = 'Name erforderlich.';
    elseif (!preg_match('/^\d{4,10}$/', $pin)) $error = 'PIN muss 4-10 Ziffern haben.';
    elseif ($pin !== $pin2) $error = 'PIN-Bestätigung stimmt nicht.';
    else {
        if (!is_dir($DATA_DIR) && !mkdir($DATA_DIR, 0755, true)) {
            $error = 'Konnte data/ nicht anlegen. Bitte Schreibrechte prüfen.';
        } else {
            @file_put_contents($HTACCESS, "Require all denied\n<IfModule !mod_authz_core.c>\nOrder deny,allow\nDeny from all\n</IfModule>\n");

            $emp = [[
                'id'        => 1,
                'name'      => $name,
                'pinHash'   => password_hash($pin, PASSWORD_DEFAULT),
                'isAdmin'   => true,
                'isActive'  => true,
                'createdAt' => date('c'),
            ]];
            file_put_contents($EMP_FILE, json_encode($emp, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
            file_put_contents($SHIFT_FILE, "[]");

            $settings = [
                'wageSingle'    => 14.00,
                'wageDouble'    => 19.00,
                'abgabenPercent'=> 31.17,
                'rooms' => [
                    'FP' => ['name' => 'Raum 1',       'owner1' => 100, 'owner2' => 0],
                    'SL' => ['name' => 'Raum 3', 'owner1' => 100, 'owner2' => 0],
                    'BO' => ['name' => 'Raum 4', 'owner1' => 100, 'owner2' => 0],
                    'VS' => ['name' => 'Raum 2',         'owner1' => 0,   'owner2' => 100],
                    'PB' => ['name' => 'Raum 5',       'owner1' => 0,   'owner2' => 100],
                    'WS' => ['name' => 'Raum 6',        'owner1' => 50,  'owner2' => 50],
                ],
                'doubleSplit' => ['main' => 50, 'owner1' => 25, 'owner2' => 25],
            ];
            file_put_contents($SET_FILE, json_encode($settings, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
            $done = true;
        }
    }
}
?><!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Installation - Paralox Stundenverwaltung</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="style.css">
</head>
<body class="install-page">
<main class="install-card">
    <h1>Paralox Stundenverwaltung</h1>
    <p class="muted">Installation</p>

    <?php if ($alreadyInstalled): ?>
        <div class="alert info">
            Die App ist bereits installiert.<br>
            <strong>Bitte lösche <code>install.php</code> vom Server.</strong>
        </div>
        <p><a class="btn" href="index.html">Zur Anmeldung</a></p>
    <?php elseif ($done): ?>
        <div class="alert success">
            Installation abgeschlossen. Admin-Account wurde erstellt.<br>
            <strong>Bitte lösche <code>install.php</code> jetzt vom Server!</strong>
        </div>
        <p><a class="btn" href="index.html">Zur Anmeldung</a></p>
    <?php else: ?>
        <p>Lege den ersten Admin-Account an. Weitere Mitarbeiter kannst du später im Admin-Bereich anlegen.</p>
        <?php if ($error): ?><div class="alert error"><?=h($error)?></div><?php endif; ?>
        <form method="post" autocomplete="off">
            <label>Name
                <input type="text" name="name" value="<?=h($_POST['name'] ?? 'Owner1')?>" required>
            </label>
            <label>PIN (4-10 Ziffern)
                <input type="password" name="pin" pattern="\d{4,10}" required inputmode="numeric">
            </label>
            <label>PIN bestätigen
                <input type="password" name="pin2" pattern="\d{4,10}" required inputmode="numeric">
            </label>
            <button type="submit" class="btn primary">Installieren</button>
        </form>
    <?php endif; ?>
</main>
</body>
</html>
