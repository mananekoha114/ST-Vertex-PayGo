export const EXTENSION_ID = 'vertex-paygo';
export const CONFIG_VERSION = 1;
export const PROTOCOL_VERSION = 1;
export const REQUIRED_TRANSPORT = 'loopback-http';

export const VERTEX_SOURCE = 'vertexai';

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
});

export const HEALTH_TIMEOUT_MS = 5_000;
// Full service-account authentication may need an OAuth token exchange before
// the ticket can be issued.
export const PREPARE_TIMEOUT_MS = 30_000;
