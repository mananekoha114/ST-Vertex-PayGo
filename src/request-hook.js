/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PROTOCOL_VERSION, SERVER_ROUTES, VERTEX_SOURCE } from './constants.js';
import { createLocalizer, localizeError, localizeSupport, localizeValidation } from './i18n.js';
import { requiresPlugin, validatePluginState } from './state-machine.js';

export function createEphemeralSecret() {
    if (globalThis.crypto?.randomUUID) {
        return `blocked-${globalThis.crypto.randomUUID()}`;
    }
    return `blocked-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function installFailureSink(generateData, origin, secretFactory = createEphemeralSecret) {
    // These assignments are the final safety net and must happen before any
    // operation that can throw. Node fetch rejects this private scheme without
    // opening a network connection.
    try {
        generateData.reverse_proxy = 'vertex-paygo-blocked://request';
    } catch {
        // SillyTavern currently emits a mutable plain object. Never propagate a
        // surprising setter/proxy failure into its error-swallowing event bus.
    }
    try {
        generateData.proxy_password = 'blocked';
    } catch {
        // See comment above.
    }

    try {
        generateData.reverse_proxy = new URL(SERVER_ROUTES.REJECTED, origin).toString();
    } catch {
        // Keep the non-network failure URL.
    }
    try {
        generateData.proxy_password = String(secretFactory()) || 'blocked';
    } catch {
        // Keep the default non-empty credential.
    }
    return generateData;
}

export function buildPreparePayload(generateData, state) {
    return {
        protocolVersion: PROTOCOL_VERSION,
        chat_completion_source: VERTEX_SOURCE,
        model: String(generateData.model ?? '').trim(),
        stream: Boolean(generateData.stream),
        vertexai_auth_mode: String(generateData.vertexai_auth_mode || 'express').trim().toLowerCase(),
        vertexai_region: String(generateData.vertexai_region || 'us-central1').trim().toLowerCase(),
        vertexai_express_project_id: String(generateData.vertexai_express_project_id || '').trim(),
        tier: state.tier,
        paygoOnly: state.paygoOnly,
    };
}

export function applyPreparedProxy(generateData, prepared) {
    generateData.reverse_proxy = prepared.proxyUrl;
    generateData.proxy_password = prepared.proxySecret;
    return generateData;
}

export function createRequestHook({
    stateProvider,
    serverClient,
    origin = globalThis.location?.origin,
    notifyError = () => {},
    notifyWarning = () => {},
    logger = console,
    secretFactory = createEphemeralSecret,
    localize = createLocalizer(),
}) {
    if (typeof stateProvider !== 'function') {
        throw new TypeError('stateProvider must be a function.');
    }

    const shownWarningKeys = new Set();

    return async function onChatCompletionSettingsReady(generateData) {
        if (generateData?.chat_completion_source !== VERTEX_SOURCE) {
            return;
        }

        const state = stateProvider();
        if (!requiresPlugin(state)) {
            return;
        }

        const existingReverseProxy = String(generateData.reverse_proxy ?? '').trim();

        // EventEmitter.emit catches listener errors. Install the failure sink
        // before validation or I/O so no exceptional path can fall back to a
        // credentialed native Vertex request.
        installFailureSink(generateData, origin, secretFactory);

        try {
            if (existingReverseProxy) {
                notifyError(localize('vertex_paygo.hook.proxy_conflict'));
                logger.error('[Vertex PayGo] Request blocked: CUSTOM_REVERSE_PROXY_CONFLICT');
                return;
            }

            const validation = validatePluginState({
                state,
                model: generateData.model,
                region: generateData.vertexai_region,
            });
            if (!validation.ok) {
                notifyError(localizeValidation(localize, validation, state));
                logger.error('[Vertex PayGo] Request blocked:', validation.code, validation.message);
                return;
            }
            if (validation.warning) {
                const warningKey = `${validation.support?.level ?? 'warning'}:${String(generateData.model ?? '').trim().toLowerCase()}`;
                if (!shownWarningKeys.has(warningKey)) {
                    shownWarningKeys.add(warningKey);
                    notifyWarning(localizeSupport(localize, validation.support, state.tier));
                }
            }

            const prepared = await serverClient.prepare(buildPreparePayload(generateData, validation.state));
            applyPreparedProxy(generateData, prepared);
        } catch (error) {
            notifyError(localize('vertex_paygo.hook.request_blocked', {
                message: localizeError(localize, error),
            }));
            logger.error('[Vertex PayGo] Failed to prepare request; failure sink retained.', error);
        }
    };
}
