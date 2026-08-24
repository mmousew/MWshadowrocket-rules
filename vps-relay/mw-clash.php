<?php
declare(strict_types=1);

require_once __DIR__ . '/mw-relay-common.php';
mw_relay_handle([
    'format' => 'clash',
    'cacheKey' => 'clash',
    'upstream' => 'https://mw-rules-manager.mousew.chatgpt.site/api/clash/' . rawurlencode(mw_relay_token($_GET['token'] ?? null)),
    'defaultFilename' => 'MW-ClashX-Meta',
]);
