<?php
/**
 * Paralox Stundenverwaltung - Backend API
 * Alle Endpunkte ueber POST action=... oder GET action=...
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');

session_name('PARALOX_STUNDEN');
session_set_cookie_params([
    'lifetime' => 0,
    'path'     => '/',
    'secure'   => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'),
    'httponly' => true,
    'samesite' => 'Lax',
]);
session_start();

define('DATA_DIR', __DIR__ . '/data');
define('EMPLOYEES_FILE', DATA_DIR . '/employees.json');
define('SHIFTS_FILE', DATA_DIR . '/shifts.json');
define('SETTINGS_FILE', DATA_DIR . '/settings.json');

function json_out($data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $msg, int $code = 400): void {
    json_out(['ok' => false, 'error' => $msg], $code);
}

function ensure_installed(): void {
    if (!is_dir(DATA_DIR) || !is_file(EMPLOYEES_FILE) || !is_file(SETTINGS_FILE)) {
        fail('Nicht installiert. Bitte install.php aufrufen.', 503);
    }
}

function load_json(string $file): array {
    if (!is_file($file)) return [];
    $fp = fopen($file, 'r');
    if (!$fp) return [];
    flock($fp, LOCK_SH);
    $raw = stream_get_contents($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    $data = json_decode($raw ?: 'null', true);
    return is_array($data) ? $data : [];
}

function save_json(string $file, array $data): void {
    $tmp = $file . '.tmp';
    $fp = fopen($tmp, 'w');
    if (!$fp) fail('Konnte Datei nicht schreiben.', 500);
    flock($fp, LOCK_EX);
    fwrite($fp, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    rename($tmp, $file);
}

function body_json(): array {
    $raw = file_get_contents('php://input');
    if (!$raw) return [];
    $d = json_decode($raw, true);
    return is_array($d) ? $d : [];
}

function current_user(): ?array {
    if (empty($_SESSION['uid'])) return null;
    foreach (load_json(EMPLOYEES_FILE) as $e) {
        if ((int)$e['id'] === (int)$_SESSION['uid']) return $e;
    }
    return null;
}

function require_login(): array {
    $u = current_user();
    if (!$u || empty($u['isActive'])) fail('Nicht angemeldet.', 401);
    return $u;
}

function require_admin(): array {
    $u = require_login();
    if (empty($u['isAdmin'])) fail('Keine Berechtigung.', 403);
    return $u;
}

function require_viewer(): array {
    $u = require_login();
    if (empty($u['isAdmin']) && empty($u['isAccountant'])) fail('Keine Berechtigung.', 403);
    return $u;
}

function next_id(array $items): int {
    $max = 0;
    foreach ($items as $i) $max = max($max, (int)($i['id'] ?? 0));
    return $max + 1;
}

function valid_time(string $t): bool {
    return (bool)preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $t);
}

function valid_date(string $d): bool {
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $d)) return false;
    [$y,$m,$da] = array_map('intval', explode('-', $d));
    return checkdate($m, $da, $y);
}

function time_to_min(string $t): int {
    [$h, $m] = array_map('intval', explode(':', $t));
    return $h * 60 + $m;
}

function find_overlap(array $shifts, array $candidate, ?int $ignoreId = null): ?array {
    $cS = time_to_min($candidate['startTime']);
    $cE = time_to_min($candidate['endTime']);
    if ($cE <= $cS) $cE += 1440;
    foreach ($shifts as $s) {
        if ($ignoreId !== null && (int)$s['id'] === $ignoreId) continue;
        if ((int)$s['employeeId'] !== (int)$candidate['employeeId']) continue;
        if ($s['date'] !== $candidate['date']) continue;
        $sS = time_to_min($s['startTime']);
        $sE = time_to_min($s['endTime']);
        if ($sE <= $sS) $sE += 1440;
        if ($cS < $sE && $sS < $cE) return $s;
    }
    return null;
}

function is_duplicate(array $shifts, array $candidate, ?int $ignoreId = null): bool {
    foreach ($shifts as $s) {
        if ($ignoreId !== null && (int)$s['id'] === $ignoreId) continue;
        if ((int)$s['employeeId'] !== (int)$candidate['employeeId']) continue;
        if ($s['date'] !== $candidate['date']) continue;
        if ($s['startTime'] !== $candidate['startTime']) continue;
        if ($s['endTime'] !== $candidate['endTime']) continue;
        if ($s['room'] !== $candidate['room']) continue;
        if (!empty($s['isDouble']) !== !empty($candidate['isDouble'])) continue;
        $s2 = $s['secondRoom'] ?? null;
        $c2 = $candidate['secondRoom'] ?? null;
        if ($s2 !== $c2) continue;
        return true;
    }
    return false;
}

function minutes_of(string $start, string $end): int {
    [$sh,$sm] = array_map('intval', explode(':', $start));
    [$eh,$em] = array_map('intval', explode(':', $end));
    $s = $sh * 60 + $sm;
    $e = $eh * 60 + $em;
    if ($e <= $s) $e += 24 * 60; // ueber Mitternacht
    return $e - $s;
}

// ---------- ROUTING ----------

$action = $_REQUEST['action'] ?? '';

if ($action === 'session') {
    $u = current_user();
    if ($u) {
        json_out(['ok' => true, 'user' => [
            'id' => $u['id'], 'name' => $u['name'],
            'isAdmin' => !empty($u['isAdmin']),
            'isAccountant' => !empty($u['isAccountant']),
        ]]);
    }
    json_out(['ok' => true, 'user' => null]);
}

if ($action === 'public-employees') {
    ensure_installed();
    $list = array_values(array_filter(load_json(EMPLOYEES_FILE), fn($e) => !empty($e['isActive'])));
    $names = array_map(fn($e) => ['id' => $e['id'], 'name' => $e['name']], $list);
    usort($names, fn($a, $b) => strcasecmp($a['name'], $b['name']));
    json_out(['ok' => true, 'employees' => $names]);
}

if ($action === 'login') {
    ensure_installed();
    $b = body_json();
    $id = (int)($b['id'] ?? 0);
    $pin = (string)($b['pin'] ?? '');
    if (!$id || $pin === '') fail('Name und PIN erforderlich.');
    foreach (load_json(EMPLOYEES_FILE) as $e) {
        if ((int)$e['id'] === $id && !empty($e['isActive'])) {
            if (password_verify($pin, $e['pinHash'])) {
                session_regenerate_id(true);
                $_SESSION['uid'] = $e['id'];
                json_out(['ok' => true, 'user' => [
                    'id' => $e['id'], 'name' => $e['name'],
                    'isAdmin' => !empty($e['isAdmin']),
                    'isAccountant' => !empty($e['isAccountant']),
                ]]);
            }
        }
    }
    // kleine Verzoegerung gegen Brute-Force
    usleep(400000);
    fail('Name oder PIN falsch.', 401);
}

if ($action === 'logout') {
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
    }
    session_destroy();
    json_out(['ok' => true]);
}

if ($action === 'settings') {
    ensure_installed();
    require_login();
    json_out(['ok' => true, 'settings' => load_json(SETTINGS_FILE)]);
}

if ($action === 'settings-update') {
    require_admin();
    $b = body_json();
    $s = load_json(SETTINGS_FILE);
    if (isset($b['wageSingle'])) $s['wageSingle'] = max(0, (float)$b['wageSingle']);
    if (isset($b['wageDouble'])) $s['wageDouble'] = max(0, (float)$b['wageDouble']);
    save_json(SETTINGS_FILE, $s);
    json_out(['ok' => true, 'settings' => $s]);
}

if ($action === 'change-pin') {
    $u = require_login();
    $b = body_json();
    $old = (string)($b['oldPin'] ?? '');
    $new = (string)($b['newPin'] ?? '');
    if (!preg_match('/^\d{4,10}$/', $new)) fail('Neue PIN muss 4-10 Ziffern haben.');
    if (!password_verify($old, $u['pinHash'])) fail('Alte PIN falsch.');
    $emps = load_json(EMPLOYEES_FILE);
    foreach ($emps as &$e) {
        if ((int)$e['id'] === (int)$u['id']) {
            $e['pinHash'] = password_hash($new, PASSWORD_DEFAULT);
        }
    }
    save_json(EMPLOYEES_FILE, $emps);
    json_out(['ok' => true]);
}

// ---------- SCHICHTEN ----------

if ($action === 'shifts') {
    $u = require_login();
    $all = load_json(SHIFTS_FILE);
    $mine = !empty($_REQUEST['mine']);
    $canSeeAll = !empty($u['isAdmin']) || !empty($u['isAccountant']);
    if ($mine || !$canSeeAll) {
        $all = array_values(array_filter($all, fn($s) => (int)$s['employeeId'] === (int)$u['id']));
    }
    usort($all, function($a, $b) {
        $c = strcmp($b['date'], $a['date']);
        return $c !== 0 ? $c : strcmp($b['startTime'], $a['startTime']);
    });
    json_out(['ok' => true, 'shifts' => $all]);
}

function validate_shift_input(array $b): array {
    $date = (string)($b['date'] ?? '');
    $start = (string)($b['startTime'] ?? '');
    $end = (string)($b['endTime'] ?? '');
    $room = (string)($b['room'] ?? '');
    $double = !empty($b['isDouble']);
    $second = $b['secondRoom'] ?? null;
    if ($second !== null) $second = (string)$second;
    if (!valid_date($date)) fail('Ungültiges Datum.');
    if (!valid_time($start) || !valid_time($end)) fail('Ungültige Uhrzeit.');
    if ($start === $end) fail('Beginn und Ende dürfen nicht gleich sein.');
    $settings = load_json(SETTINGS_FILE);
    $rooms = $settings['rooms'] ?? [];
    if (!isset($rooms[$room])) fail('Unbekannter Raum.');
    if ($double) {
        if (!$second || !isset($rooms[$second])) fail('Zweiter Raum ungültig.');
        if ($second === $room) fail('Zweiter Raum muss anders sein.');
    } else {
        $second = null;
    }
    return [$date, $start, $end, $room, $double, $second];
}

if ($action === 'shift-create') {
    $u = require_login();
    if (!empty($u['isAccountant']) && empty($u['isAdmin'])) fail('Buchhaltung kann keine Schichten erfassen.', 403);
    $b = body_json();
    [$date, $start, $end, $room, $double, $second] = validate_shift_input($b);
    if (empty($u['isAdmin']) && $date !== date('Y-m-d')) {
        fail('Schichten können nur für den heutigen Tag erfasst werden.', 403);
    }
    $empId = (int)$u['id'];
    if (!empty($u['isAdmin']) && !empty($b['employeeId'])) $empId = (int)$b['employeeId'];
    $shifts = load_json(SHIFTS_FILE);
    $candidate = [
        'employeeId' => $empId,
        'date'       => $date,
        'startTime'  => $start,
        'endTime'    => $end,
        'room'       => $room,
        'secondRoom' => $second,
        'isDouble'   => $double,
    ];
    $conflict = find_overlap($shifts, $candidate);
    if ($conflict) {
        fail("Zeit überschneidet sich mit bestehender Schicht ({$conflict['startTime']}–{$conflict['endTime']}, {$conflict['room']}).", 409);
    }
    if (is_duplicate($shifts, $candidate)) {
        fail('Diese Schicht existiert bereits.', 409);
    }
    $shifts[] = array_merge($candidate, [
        'id'        => next_id($shifts),
        'note'      => trim((string)($b['note'] ?? '')),
        'createdAt' => date('c'),
    ]);
    save_json(SHIFTS_FILE, $shifts);
    json_out(['ok' => true]);
}

if ($action === 'shift-update') {
    require_admin();
    $b = body_json();
    $id = (int)($b['id'] ?? 0);
    if (!$id) fail('ID fehlt.');
    [$date, $start, $end, $room, $double, $second] = validate_shift_input($b);
    $shifts = load_json(SHIFTS_FILE);
    $idx = null;
    foreach ($shifts as $i => $s) if ((int)$s['id'] === $id) { $idx = $i; break; }
    if ($idx === null) fail('Eintrag nicht gefunden.', 404);
    $empId = isset($b['employeeId']) ? (int)$b['employeeId'] : (int)$shifts[$idx]['employeeId'];
    $candidate = [
        'employeeId' => $empId,
        'date'       => $date,
        'startTime'  => $start,
        'endTime'    => $end,
        'room'       => $room,
        'secondRoom' => $second,
        'isDouble'   => $double,
    ];
    $conflict = find_overlap($shifts, $candidate, $id);
    if ($conflict) {
        fail("Zeit überschneidet sich mit bestehender Schicht ({$conflict['startTime']}–{$conflict['endTime']}, {$conflict['room']}).", 409);
    }
    if (is_duplicate($shifts, $candidate, $id)) {
        fail('Diese Schicht existiert bereits.', 409);
    }
    $shifts[$idx] = array_merge($shifts[$idx], $candidate);
    if (isset($b['note'])) $shifts[$idx]['note'] = trim((string)$b['note']);
    save_json(SHIFTS_FILE, $shifts);
    json_out(['ok' => true]);
}

if ($action === 'shift-delete') {
    $u = require_login();
    $b = body_json();
    $id = (int)($b['id'] ?? 0);
    if (!$id) fail('ID fehlt.');
    $shifts = load_json(SHIFTS_FILE);
    $target = null;
    foreach ($shifts as $s) if ((int)$s['id'] === $id) { $target = $s; break; }
    if (!$target) fail('Eintrag nicht gefunden.', 404);
    if (empty($u['isAdmin'])) {
        if ((int)$target['employeeId'] !== (int)$u['id']) fail('Keine Berechtigung.', 403);
        if ($target['date'] !== date('Y-m-d')) fail('Eigene Schichten können nur am selben Tag gelöscht werden.', 403);
    }
    $out = array_values(array_filter($shifts, fn($s) => (int)$s['id'] !== $id));
    save_json(SHIFTS_FILE, $out);
    json_out(['ok' => true]);
}

// ---------- MITARBEITER ----------

if ($action === 'employees') {
    require_viewer();
    $list = load_json(EMPLOYEES_FILE);
    $out = array_map(fn($e) => [
        'id' => $e['id'], 'name' => $e['name'],
        'isAdmin' => !empty($e['isAdmin']),
        'isAccountant' => !empty($e['isAccountant']),
        'isActive' => !empty($e['isActive']),
        'createdAt' => $e['createdAt'] ?? null,
    ], $list);
    usort($out, fn($a, $b) => strcasecmp($a['name'], $b['name']));
    json_out(['ok' => true, 'employees' => $out]);
}

if ($action === 'employee-create') {
    require_admin();
    $b = body_json();
    $name = trim((string)($b['name'] ?? ''));
    $pin = (string)($b['pin'] ?? '');
    $isAdmin = !empty($b['isAdmin']);
    if ($name === '') fail('Name erforderlich.');
    if (!preg_match('/^\d{4,10}$/', $pin)) fail('PIN muss 4-10 Ziffern haben.');
    $emps = load_json(EMPLOYEES_FILE);
    foreach ($emps as $e) {
        if (strcasecmp($e['name'], $name) === 0) fail('Name bereits vergeben.');
    }
    $emps[] = [
        'id'           => next_id($emps),
        'name'         => $name,
        'pinHash'      => password_hash($pin, PASSWORD_DEFAULT),
        'isAdmin'      => $isAdmin,
        'isAccountant' => !empty($b['isAccountant']),
        'isActive'     => true,
        'createdAt'    => date('c'),
    ];
    save_json(EMPLOYEES_FILE, $emps);
    json_out(['ok' => true]);
}

if ($action === 'employee-update') {
    $admin = require_admin();
    $b = body_json();
    $id = (int)($b['id'] ?? 0);
    if (!$id) fail('ID fehlt.');
    $emps = load_json(EMPLOYEES_FILE);
    $found = false;
    foreach ($emps as &$e) {
        if ((int)$e['id'] === $id) {
            if (isset($b['name'])) {
                $n = trim((string)$b['name']);
                if ($n !== '') $e['name'] = $n;
            }
            if (isset($b['pin']) && $b['pin'] !== '') {
                if (!preg_match('/^\d{4,10}$/', (string)$b['pin'])) fail('PIN muss 4-10 Ziffern haben.');
                $e['pinHash'] = password_hash((string)$b['pin'], PASSWORD_DEFAULT);
            }
            if (isset($b['isAdmin'])) {
                // verhindern, dass letzter Admin degradiert wird
                if (empty($b['isAdmin']) && !empty($e['isAdmin'])) {
                    $others = array_filter($emps, fn($x) => (int)$x['id'] !== $id && !empty($x['isAdmin']) && !empty($x['isActive']));
                    if (!$others) fail('Mindestens ein aktiver Admin erforderlich.');
                }
                $e['isAdmin'] = !empty($b['isAdmin']);
            }
            if (isset($b['isAccountant'])) {
                $e['isAccountant'] = !empty($b['isAccountant']);
            }
            if (isset($b['isActive'])) {
                if (empty($b['isActive']) && !empty($e['isAdmin'])) {
                    $others = array_filter($emps, fn($x) => (int)$x['id'] !== $id && !empty($x['isAdmin']) && !empty($x['isActive']));
                    if (!$others) fail('Mindestens ein aktiver Admin erforderlich.');
                }
                $e['isActive'] = !empty($b['isActive']);
            }
            $found = true;
            break;
        }
    }
    if (!$found) fail('Mitarbeiter nicht gefunden.', 404);
    save_json(EMPLOYEES_FILE, $emps);
    json_out(['ok' => true]);
}

fail('Unbekannte Aktion.', 404);
