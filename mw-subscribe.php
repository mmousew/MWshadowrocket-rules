<?php
declare(strict_types=1);

require_once __DIR__ . '/mw-relay-common.php';

$requested = strtolower(trim((string) ($_GET['format'] ?? '')));
$agent = strtolower((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''));
$format = in_array($requested, ['clash', 'mihomo', 'clashxmeta'], true) || str_contains($agent, 'clash') || str_contains($agent, 'mihomo')
    ? 'clash'
    : 'shadowrocket';
$endpoint = $format === 'clash' ? 'clash/' : 'shadowrocket/';
$token = mw_relay_token($_GET['token'] ?? null);

mw_relay_handle([
    'format' => $format,
    'cacheKey' => $format,
    'upstream' => 'https://mw-rules-manager.mousew.chatgpt.site/api/' . $endpoint . rawurlencode($token),
    'defaultFilename' => $format === 'clash' ? 'MW-Clash' : 'MW-Shadowrocket',
]);
