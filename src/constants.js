/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export const EXTENSION_ID = 'vertex-paygo';
export const CLIENT_VERSION = '0.3.0';
export const CONFIG_VERSION = 1;
export const PROTOCOL_VERSION = 1;
export const REQUIRED_TRANSPORT = 'loopback-http';
export const CLIENT_LOG_MEDIA_TYPE = 'application/vnd.st-vertex-paygo.client-log+json';

export const VERTEX_SOURCE = 'vertexai';
export const AI_STUDIO_SOURCE = 'makersuite';

export function isGoogleSource(source) {
    return source === VERTEX_SOURCE || source === AI_STUDIO_SOURCE;
}

export const TIER = Object.freeze({
    STANDARD: 'standard',
    FLEX: 'flex',
    PRIORITY: 'priority',
});

export const DEFAULT_STATE = Object.freeze({
    version: CONFIG_VERSION,
    tier: TIER.STANDARD,
    paygoOnly: false,
});

export const SERVER_ROUTES = Object.freeze({
    HEALTH: '/api/plugins/vertex-paygo/health',
    PREPARE: '/api/plugins/vertex-paygo/prepare',
    REJECTED: '/api/plugins/vertex-paygo/rejected',
    LOGS: '/api/plugins/vertex-paygo/logs',
    CLIENT_LOG: '/api/plugins/vertex-paygo/logs/client',
});

export const HEALTH_TIMEOUT_MS = 5_000;
export const LOG_TIMEOUT_MS = 5_000;
export const MAX_LOG_RESPONSE_BYTES = 5 * 1024 * 1024;
// Full service-account authentication may need an OAuth token exchange before
// the ticket can be issued.
export const PREPARE_TIMEOUT_MS = 30_000;
