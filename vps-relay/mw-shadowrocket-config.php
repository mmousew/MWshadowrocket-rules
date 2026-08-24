<?php
declare(strict_types=1);

require_once __DIR__ . '/mw-relay-common.php';
mw_relay_handle([
    'format' => 'shadowrocket',
    'cacheKey' => 'shadowrocket-config',
    'upstream' => 'https://mw-rules-manager.mousew.chatgpt.site/api/shadowrocket-config/' . rawurlencode(mw_relay_token($_GET['token'] ?? null)),
    'defaultFilename' => 'MW-Shadowrocket-Rules',
]);
