/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
    HEALTH_TIMEOUT_MS,
    EXTENSION_ID,
    PREPARE_TIMEOUT_MS,
    PROTOCOL_VERSION,
    REQUIRED_TRANSPORT,
    SERVER_ROUTES,
} from './constants.js';

export class ServerPluginError extends Error {
    constructor(message, { code = 'SERVER_PLUGIN_ERROR', status, cause } = {}) {
        super(message, { cause });
        this.name = 'ServerPluginError';
        this.code = code;
        this.status = status;
    }
}

export function parseLoopbackProxyUrl(value) {
    let url;
    try {
        url = new URL(String(value));
    } catch (cause) {
        throw new ServerPluginError('Server Plugin returned an invalid proxy URL.', {
            code: 'INVALID_PROXY_URL',
            cause,
        });
    }

    // The Server Plugin chooses the ticket length. Require a bounded base64url
    // token here, then bind it exactly to data.ticket in prepare().
    const validPath = /^\/proxy\/[A-Za-z0-9_-]{16,128}$/.test(url.pathname);
    if (
        url.protocol !== 'http:'
        || url.hostname !== '127.0.0.1'
        || !url.port
        || url.username
        || url.password
        || !validPath
        || url.search
        || url.hash
    ) {
        throw new ServerPluginError('Server Plugin proxy URL is not an authenticated loopback HTTP endpoint.', {
            code: 'UNSAFE_PROXY_URL',
        });
    }

    return url.toString();
}

async function fetchJson(fetchImpl, url, options, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetchImpl(url, { ...options, signal: controller.signal });
        let data;
        try {
            data = await response.json();
        } catch (cause) {
            throw new ServerPluginError('Server Plugin returned a non-JSON response.', {
                code: 'INVALID_RESPONSE',
                status: response.status,
                cause,
            });
        }

        if (!response.ok) {
            const message = typeof data?.message === 'string' ? data.message : `Server Plugin request failed (${response.status}).`;
            throw new ServerPluginError(message, { code: 'HTTP_ERROR', status: response.status });
        }
        return data;
    } catch (error) {
        if (error instanceof ServerPluginError) {
            throw error;
        }
        if (error?.name === 'AbortError') {
            throw new ServerPluginError('Server Plugin request timed out.', { code: 'TIMEOUT', cause: error });
        }
        throw new ServerPluginError('Server Plugin is unavailable.', { code: 'UNAVAILABLE', cause: error });
    } finally {
        clearTimeout(timeout);
    }
}

function validateHandshake(data) {
    if (data?.ok !== true || data?.pluginId !== EXTENSION_ID || data?.protocolVersion !== PROTOCOL_VERSION) {
        throw new ServerPluginError(`Server Plugin protocol v${PROTOCOL_VERSION} is required.`, {
            code: 'PROTOCOL_MISMATCH',
        });
    }
    if (data.transport !== REQUIRED_TRANSPORT) {
        throw new ServerPluginError(`Server Plugin transport “${REQUIRED_TRANSPORT}” is required.`, {
            code: 'TRANSPORT_MISMATCH',
        });
    }
    return data;
}

export function createServerClient({ fetchImpl = globalThis.fetch, getRequestHeaders = () => ({}) } = {}) {
    if (typeof fetchImpl !== 'function') {
        throw new TypeError('A fetch implementation is required.');
    }

    return {
        async checkHealth() {
            const data = await fetchJson(fetchImpl, SERVER_ROUTES.HEALTH, {
                method: 'GET',
                headers: { ...getRequestHeaders(), Accept: 'application/json' },
                cache: 'no-store',
            }, HEALTH_TIMEOUT_MS);
            return validateHandshake(data);
        },

        async prepare(payload) {
            const data = await fetchJson(fetchImpl, SERVER_ROUTES.PREPARE, {
                method: 'POST',
                headers: { ...getRequestHeaders(), Accept: 'application/json' },
                body: JSON.stringify(payload),
                cache: 'no-store',
            }, PREPARE_TIMEOUT_MS);

            validateHandshake(data);
            const proxyUrl = parseLoopbackProxyUrl(data.proxyUrl);
            const ticket = new URL(proxyUrl).pathname.split('/').at(-1);
            if (data.ticket !== ticket) {
                throw new ServerPluginError('Server Plugin ticket does not match its proxy URL.', {
                    code: 'INVALID_PROXY_TICKET',
                });
            }
            if (typeof data.proxySecret !== 'string' || data.proxySecret.length < 16) {
                throw new ServerPluginError('Server Plugin returned an invalid proxy secret.', {
                    code: 'INVALID_PROXY_SECRET',
                });
            }

            return {
                ...data,
                proxyUrl,
                proxySecret: data.proxySecret,
            };
        },
    };
}
