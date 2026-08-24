<?php
declare(strict_types=1);

// One stable subscription entry for Clash/Mihomo and Shadowrocket.
// This relay only downloads and serves configuration text. It never carries
// proxy traffic.
const UPSTREAM_BASE = 'https://mw-rules-manager.mousew.chatgpt.site/api/';
const CACHE_DIR = '/home/cardlife/.mw-subscription-cache';

function failResponse(int $status, string $message): never
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    echo $message;
    exit;
}

function validToken(mixed $value): ?string
{
    return is_string($value) && preg_match('/^[A-Za-z0-9_-]{20,200}$/', $value) === 1 ? $value : null;
}

function cleanName(mixed $value): string
{
    if (!is_string($value)) return '';
    $value = trim($value);
    $value = preg_replace('/[\x00-\x1F\x7F\\\/\r\n"<>:*?|]+/u', ' ', $value) ?? '';
    return trim(substr($value, 0, 80));
}

function clientFormat(): string
{
    $requested = strtolower(trim((string) ($_GET['format'] ?? '')));
    if (in_array($requested, ['clash', 'mihomo', 'clashxmeta'], true)) return 'clash';
    if (in_array($requested, ['shadowrocket', 'surge', 'conf'], true)) return 'shadowrocket';

    $agent = strtolower((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''));
    if (str_contains($agent, 'clash') || str_contains($agent, 'mihomo')) return 'clash';
    if (str_contains($agent, 'shadowrocket')) return 'shadowrocket';

    // Unknown clients get the broadly compatible text profile. Explicit
    // format=clash remains available for manual tests and older clients.
    return 'shadowrocket';
}

function cacheFiles(string $token, string $format): array
{
    $key = hash('sha256', $token . ':' . $format);
    return [
        CACHE_DIR . DIRECTORY_SEPARATOR . $key . '.body',
        CACHE_DIR . DIRECTORY_SEPARATOR . $key . '.json',
    ];
}

function isUsable(string $body, string $format): bool
{
    if (trim($body) === '' || strlen($body) > 10000000) return false;
    if ($format === 'clash') {
        return preg_match('/^\s*(proxies|proxy-groups|rules)\s*:/m', $body) === 1;
    }
    return str_contains($body, '[General]') || str_contains($body, '[Proxy]') || str_contains($body, '[Rule]');
}

function safeDisposition(mixed $value): string
{
    if (!is_string($value) || $value === '' || str_contains($value, "\r") || str_contains($value, "\n")) return '';
    return $value;
}

function writeCache(string $bodyFile, string $metaFile, string $body, array $meta): void
{
    if (!is_dir(CACHE_DIR)) @mkdir(CACHE_DIR, 0700, true);
    if (!is_dir(CACHE_DIR) || !is_writable(CACHE_DIR)) return;

    $suffix = bin2hex(random_bytes(6));
    $bodyTemp = $bodyFile . '.tmp-' . $suffix;
    $metaTemp = $metaFile . '.tmp-' . $suffix;
    if (@file_put_contents($bodyTemp, $body, LOCK_EX) === false) return;
    if (@file_put_contents($metaTemp, json_encode($meta, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX) === false) {
        @unlink($bodyTemp);
        return;
    }
    @rename($bodyTemp, $bodyFile);
    @rename($metaTemp, $metaFile);
}

$token = validToken($_GET['token'] ?? null);
if ($token === null) failResponse(404, 'Not found');

$format = clientFormat();
$name = cleanName($_GET['name'] ?? '');
$endpoint = $format === 'clash' ? 'clash/' : 'shadowrocket/';
$upstreamUrl = UPSTREAM_BASE . $endpoint . rawurlencode($token);
[$bodyFile, $metaFile] = cacheFiles($token, $format);

$headers = [];
$curl = curl_init($upstreamUrl);
curl_setopt_array($curl, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_FRESH_CONNECT => true,
    CURLOPT_FORBID_REUSE => true,
    CURLOPT_CONNECTTIMEOUT => 12,
    CURLOPT_TIMEOUT => 45,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_HTTPHEADER => [
        $format === 'clash' ? 'Accept: text/yaml, application/yaml, */*' : 'Accept: text/plain, */*',
        'User-Agent: MW-VPS-Subscription-Relay/1.0',
        'Cache-Control: no-cache, no-store, max-age=0',
        'Pragma: no-cache',
    ],
    CURLOPT_HEADERFUNCTION => function ($curl, string $header) use (&$headers): int {
        $separator = strpos($header, ':');
        if ($separator !== false) {
            $key = strtolower(trim(substr($header, 0, $separator)));
            if (in_array($key, ['content-disposition', 'x-mw-config-name'], true)) {
                $value = safeDisposition(trim(substr($header, $separator + 1)));
                if ($value !== '') $headers[$key] = $value;
            }
        }
        return strlen($header);
    },
]);
$body = curl_exec($curl);
$status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
$error = curl_error($curl);
curl_close($curl);

$fresh = is_string($body) && $status >= 200 && $status < 300 && isUsable($body, $format);
if ($fresh) {
    $metadata = [
        'format' => $format,
        'fetchedAt' => gmdate('c'),
        'contentDisposition' => $headers['content-disposition'] ?? '',
        'configName' => $headers['x-mw-config-name'] ?? '',
    ];
    writeCache($bodyFile, $metaFile, $body, $metadata);
    $servedBody = $body;
    $servedMeta = $metadata;
    $fallback = false;
} else {
    $servedBody = is_file($bodyFile) ? @file_get_contents($bodyFile) : false;
    $servedMeta = is_file($metaFile) ? json_decode((string) @file_get_contents($metaFile), true) : [];
    if (!is_string($servedBody) || !isUsable($servedBody, $format)) {
        failResponse(502, 'Subscription temporarily unavailable');
    }
    $fallback = true;
}

$extension = $format === 'clash' ? 'yaml' : 'conf';
$configuredName = $name !== '' ? $name : cleanName($servedMeta['configName'] ?? '');
$filename = $configuredName !== '' ? $configuredName . '.' . $extension : ($format === 'clash' ? 'MW-Clash.yaml' : 'MW-Shadowrocket.conf');
$filename = str_replace(["\r", "\n"], '', $filename);
$disposition = $configuredName !== ''
    ? 'inline; filename="' . rawurlencode($filename) . '"; filename*=UTF-8\'\'' . rawurlencode($filename)
    : safeDisposition($servedMeta['contentDisposition'] ?? '');
if ($disposition === '') $disposition = 'inline; filename="' . $filename . '"';

header($format === 'clash' ? 'Content-Type: text/yaml; charset=utf-8' : 'Content-Type: text/plain; charset=utf-8');
header('Content-Disposition: ' . $disposition);
if (!empty($servedMeta['configName'])) header('X-MW-Config-Name: ' . safeDisposition($servedMeta['configName']));
header('X-MW-Subscription-Format: ' . $format);
header('X-MW-Subscription-Cache: ' . ($fallback ? 'fallback' : 'fresh'));
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');
header('X-Content-Type-Options: nosniff');
echo $servedBody;
