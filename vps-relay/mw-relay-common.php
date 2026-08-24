<?php
declare(strict_types=1);

const MW_RELAY_CACHE_DIR = '/tmp/mw-subscription-cache-656577';
const MW_RELAY_CACHE_TTL = 300;

function mw_relay_fail(int $status, string $message): never
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    echo $message;
    exit;
}

function mw_relay_token(mixed $value): string
{
    if (!is_string($value) || preg_match('/^[A-Za-z0-9_-]{20,200}$/', $value) !== 1) {
        mw_relay_fail(404, 'Not found');
    }
    return $value;
}

function mw_relay_clean_name(mixed $value): string
{
    if (!is_string($value)) return '';
    $value = trim($value);
    // Keep warnings out of the subscription body: this runs before headers/body output.
    $value = preg_replace('/[\x00-\x1F\x7F]/', ' ', $value) ?? '';
    $value = str_replace(['\\', '/', '"', '<', '>', ':', '*', '?', '|'], ' ', $value);
    return trim(substr($value, 0, 80));
}

function mw_relay_usable(string $body, string $format): bool
{
    if (trim($body) === '' || strlen($body) > 10000000) return false;
    if ($format === 'clash') {
        return preg_match('/^\s*(proxies|proxy-groups|rules)\s*:/m', $body) === 1;
    }
    return str_contains($body, '[General]') || str_contains($body, '[Proxy]') || str_contains($body, '[Rule]');
}

function mw_relay_cache_files(string $token, string $cacheKey): array
{
    $key = hash('sha256', $token . ':' . $cacheKey);
    return [
        MW_RELAY_CACHE_DIR . DIRECTORY_SEPARATOR . $key . '.body',
        MW_RELAY_CACHE_DIR . DIRECTORY_SEPARATOR . $key . '.json',
    ];
}

function mw_relay_read_cache(string $bodyFile, string $metaFile, string $format): ?array
{
    if (!is_file($bodyFile)) return null;
    $body = @file_get_contents($bodyFile);
    if (!is_string($body) || !mw_relay_usable($body, $format)) return null;
    $meta = is_file($metaFile) ? json_decode((string) @file_get_contents($metaFile), true) : [];
    return [
        'body' => $body,
        'meta' => is_array($meta) ? $meta : [],
        'age' => max(0, time() - ((int) @filemtime($bodyFile))),
    ];
}

function mw_relay_write_cache(string $bodyFile, string $metaFile, string $body, array $meta): void
{
    if (!is_dir(MW_RELAY_CACHE_DIR)) @mkdir(MW_RELAY_CACHE_DIR, 0700, true);
    if (!is_dir(MW_RELAY_CACHE_DIR) || !is_writable(MW_RELAY_CACHE_DIR)) return;

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

function mw_relay_fetch(string $url, string $format, int $timeoutSeconds = 25): array
{
    $headers = [];
    $curl = curl_init($url);
    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_TIMEOUT => $timeoutSeconds,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_IPRESOLVE => CURL_IPRESOLVE_V4,
        CURLOPT_HTTPHEADER => [
            $format === 'clash' ? 'Accept: text/yaml, application/yaml, */*' : 'Accept: text/plain, */*',
            'User-Agent: MW-VPS-Subscription-Relay/2.0',
            'Cache-Control: no-cache, no-store, max-age=0',
            'Pragma: no-cache',
        ],
        CURLOPT_HEADERFUNCTION => function ($curl, string $header) use (&$headers): int {
            $separator = strpos($header, ':');
            if ($separator !== false) {
                $key = strtolower(trim(substr($header, 0, $separator)));
                if (in_array($key, ['content-disposition', 'x-mw-config-name'], true)) {
                    $value = trim(substr($header, $separator + 1));
                    if ($value !== '' && !str_contains($value, "\r") && !str_contains($value, "\n")) $headers[$key] = $value;
                }
            }
            return strlen($header);
        },
    ]);
    $body = curl_exec($curl);
    $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $error = curl_error($curl);
    curl_close($curl);
    $ok = is_string($body) && $status >= 200 && $status < 300 && mw_relay_usable($body, $format);
    return [$ok, $body, $headers, $status, $error];
}

function mw_relay_finish_response(): void
{
    if (function_exists('fastcgi_finish_request')) @fastcgi_finish_request();
}

function mw_relay_disposition(string $filename): string
{
    $filename = mw_relay_clean_name($filename);
    if ($filename === '') $filename = 'MW-Subscription';
    // Keep filename= ASCII-only for legacy clients and provide the real UTF-8
    // name via RFC 5987. Raw UTF-8 in filename= is decoded as Latin-1 by some
    // clients, which produces mojibake for Chinese subscription names.
    $fallback = preg_replace('/[^\x20-\x7E]/', '_', $filename) ?: 'MW-Subscription';
    $fallback = trim($fallback) !== '' ? trim($fallback) : 'MW-Subscription';
    return 'inline; filename="' . $fallback . '"; filename*=UTF-8\'\'' . rawurlencode($filename);
}

function mw_relay_accepts_gzip(): bool
{
    $acceptEncoding = strtolower((string) ($_SERVER['HTTP_ACCEPT_ENCODING'] ?? ''));
    return str_contains($acceptEncoding, 'gzip') && function_exists('gzencode');
}

function mw_relay_apply_name(string $body, string $format, string $name): string
{
    if ($format !== 'shadowrocket' || $name === '') return $body;
    $safeName = str_replace(["\r", "\n"], ' ', $name);
    $safeName = trim(preg_replace('/\s+/', ' ', $safeName) ?? '');
    if ($safeName === '') return $body;
    $replacement = '#!name=' . $safeName;
    $updated = preg_replace('/^#!name=.*$/mi', $replacement, $body, 1, $count);
    if ($count > 0 && is_string($updated)) return $updated;
    return $replacement . "\n" . ltrim($body);
}

function mw_relay_send(string $body, array $meta, string $format, string $defaultFilename, string $cacheState, string $name = ''): void
{
    $extension = $format === 'clash' ? '.yaml' : '.conf';
    $configuredName = $name !== '' ? $name : mw_relay_clean_name($meta['configName'] ?? '');
    $filename = ($configuredName !== '' ? $configuredName : $defaultFilename) . $extension;
    header($format === 'clash' ? 'Content-Type: text/yaml; charset=utf-8' : 'Content-Type: text/plain; charset=utf-8');
    header('Content-Disposition: ' . mw_relay_disposition($filename));
    header('X-MW-Subscription-Format: ' . $format);
    header('X-MW-Subscription-Cache: ' . $cacheState);
    header('Vary: Accept-Encoding');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('Expires: 0');
    header('X-Content-Type-Options: nosniff');
    $payload = mw_relay_apply_name($body, $format, $name);
    if (mw_relay_accepts_gzip()) {
        $compressed = @gzencode($body, 6, ZLIB_ENCODING_GZIP);
        if (is_string($compressed) && strlen($compressed) < strlen($body)) {
            $payload = $compressed;
            header('Content-Encoding: gzip');
        }
    }
    header('Content-Length: ' . strlen($payload));
    header('Connection: close');
    echo $payload;
}

function mw_relay_handle(array $options): never
{
    $token = mw_relay_token($_GET['token'] ?? null);
    $format = (string) ($options['format'] ?? 'shadowrocket');
    $cacheKey = (string) ($options['cacheKey'] ?? $format);
    $name = mw_relay_clean_name($_GET['name'] ?? '');
    [$bodyFile, $metaFile] = mw_relay_cache_files($token, $cacheKey);
    $cached = mw_relay_read_cache($bodyFile, $metaFile, $format);

    // Existing subscriptions must never wait for a slow or blocked source.
    // Send stale data first; PHP-FPM can refresh it after the client receives it.
    if ($cached !== null) {
        $state = $cached['age'] <= MW_RELAY_CACHE_TTL ? 'cache' : 'stale';
        mw_relay_send($cached['body'], $cached['meta'], $format, (string) $options['defaultFilename'], $state, $name);
        if ($cached['age'] <= MW_RELAY_CACHE_TTL) exit;
        mw_relay_finish_response();
    }

    [$ok, $body, $headers] = mw_relay_fetch((string) $options['upstream'], $format, 25);
    if ($ok) {
        $meta = [
            'format' => $format,
            'fetchedAt' => gmdate('c'),
            'contentDisposition' => $headers['content-disposition'] ?? '',
            'configName' => isset($headers['x-mw-config-name'])
                ? mw_relay_clean_name(rawurldecode((string) $headers['x-mw-config-name']))
                : '',
        ];
        mw_relay_write_cache($bodyFile, $metaFile, $body, $meta);
        if ($cached === null) mw_relay_send($body, $meta, $format, (string) $options['defaultFilename'], 'fresh', $name);
    } elseif ($cached === null) {
        mw_relay_fail(502, 'Subscription temporarily unavailable');
    }
    exit;
}
