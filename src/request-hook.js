/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AI_STUDIO_SOURCE, isGoogleSource, PROTOCOL_VERSION, VERTEX_SOURCE } from './constants.js';
import { getSafeErrorContext } from './client-logger.js';
import { createLocalizer, localizeError, localizeSupport, localizeValidation } from './i18n.js';
import { requiresPlugin, validatePluginState } from './state-machine.js';

export function createEphemeralSecret() {
    if (globalThis.crypto?.randomUUID) {
        return `blocked-${globalThis.crypto.randomUUID()}`;
    }
    return `blocked-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class PayGoRequestError extends Error {
    constructor(message, code = 'PAYGO_REQUEST_BLOCKED', options) {
        super(message, options);
        this.name = 'PayGoRequestError';
        this.code = code;
    }
}

export function installFailureSink(generateData, _origin, secretFactory = createEphemeralSecret) {
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

    // Never point this fallback at the ST HTTP server: its global CSRF gate
    // would hide the preparation error behind an unauthenticated backend POST.
    try {
        generateData.proxy_password = String(secretFactory()) || 'blocked';
    } catch {
        // Keep the default non-empty credential.
    }
    return generateData;
}

export function buildPreparePayload(generateData, state, upstreamProxy = generateData) {
    const source = generateData.chat_completion_source === AI_STUDIO_SOURCE ? AI_STUDIO_SOURCE : VERTEX_SOURCE;
    return {
        protocolVersion: PROTOCOL_VERSION,
        chat_completion_source: source,
        model: String(generateData.model ?? '').trim(),
        stream: Boolean(generateData.stream),
        ...(source === AI_STUDIO_SOURCE && upstreamProxy.reverse_proxy ? {
            reverse_proxy: String(upstreamProxy.reverse_proxy).trim(),
            proxy_password: String(upstreamProxy.proxy_password ?? ''),
        } : {}),
        ...(generateData.secret_id ? { secret_id: generateData.secret_id } : {}),
        ...(source === VERTEX_SOURCE ? {
            vertexai_auth_mode: String(generateData.vertexai_auth_mode || 'express').trim().toLowerCase(),
            vertexai_region: String(generateData.vertexai_region || 'us-central1').trim().toLowerCase(),
            vertexai_express_project_id: String(generateData.vertexai_express_project_id || '').trim(),
        } : {}),
        tier: state.tier,
        paygoOnly: source === VERTEX_SOURCE && state.paygoOnly,
    };
}

export function applyPreparedProxy(generateData, prepared) {
    generateData.reverse_proxy = prepared.proxyUrl;
    generateData.proxy_password = prepared.proxySecret;
    return generateData;
}

function recordClientEvent(logger, level, event, context = {}) {
    try {
        logger?.event?.(level, event, context);
    } catch {
        // Diagnostics must never affect the fail-closed request hook.
    }
}

function buildSafeRequestLogContext(generateData, state, requestId) {
    return {
        requestId,
        provider: generateData?.chat_completion_source,
        model: String(generateData?.model ?? '').trim(),
        region: generateData?.chat_completion_source === VERTEX_SOURCE
            ? String(generateData?.vertexai_region ?? '').trim().toLowerCase() : undefined,
        tier: state?.tier,
        paygoOnly: generateData?.chat_completion_source === VERTEX_SOURCE && state?.paygoOnly,
        stream: Boolean(generateData?.stream),
    };
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
    usageProvider = () => ({}),
}) {
    if (typeof stateProvider !== 'function') {
        throw new TypeError('stateProvider must be a function.');
    }

    const shownWarningKeys = new Set();

    return async function onChatCompletionSettingsReady(generateData) {
        const source = generateData?.chat_completion_source;
        if (!isGoogleSource(source)) {
            return;
        }

        const state = stateProvider(generateData);
        if (!requiresPlugin(state, source, generateData.model)) {
            return;
        }

        const existingReverseProxy = String(generateData.reverse_proxy ?? '').trim();
        const upstreamProxy = { reverse_proxy: existingReverseProxy, proxy_password: generateData.proxy_password };
        const requestId = logger?.createRequestId?.();
        const startedAt = Date.now();
        const logContext = buildSafeRequestLogContext(generateData, state, requestId);

        // EventEmitter.emit catches listener errors. Install the failure sink
        // before validation or I/O so no exceptional path can fall back to a
        // credentialed native Vertex request.
        installFailureSink(generateData, origin, secretFactory);
        recordClientEvent(logger, 'info', 'request.prepare_started', {
            ...logContext,
            phase: 'started',
        });

        try {
            if (existingReverseProxy && source !== AI_STUDIO_SOURCE) {
                throw new PayGoRequestError(localize('vertex_paygo.hook.proxy_conflict'), 'CUSTOM_REVERSE_PROXY_CONFLICT');
            }

            const validation = validatePluginState({
                state,
                source,
                model: generateData.model,
                region: generateData.vertexai_region,
            });
            if (!validation.ok) {
                throw new PayGoRequestError(localizeValidation(localize, validation, state), validation.code);
            }
            if (validation.warning) {
                const warningKey = `${source}:${validation.support?.level ?? 'warning'}:${String(generateData.model ?? '').trim().toLowerCase()}`;
                if (!shownWarningKeys.has(warningKey)) {
                    shownWarningKeys.add(warningKey);
                    notifyWarning(localizeSupport(localize, validation.support, state.tier));
                    recordClientEvent(logger, 'warn', 'request.support_unverified', {
                        ...logContext,
                        phase: 'warning',
                        supportLevel: validation.support?.level,
                    });
                }
            }

            const usage = usageProvider(generateData, validation.state);
            const prepared = await serverClient.prepare({
                ...buildPreparePayload(generateData, validation.state, upstreamProxy),
                ...usage,
            });
            applyPreparedProxy(generateData, prepared);
            if (usage.usageChatId && !prepared.usageId) {
                notifyWarning(localize('vertex_paygo.costs.recording_unavailable'));
            }
            recordClientEvent(logger, 'info', 'request.prepare_succeeded', {
                ...logContext,
                phase: 'succeeded',
                durationMs: Date.now() - startedAt,
            });
            return prepared;
        } catch (error) {
            const failure = error instanceof Error ? error : new PayGoRequestError(String(error), undefined, { cause: error });
            const blocked = failure instanceof PayGoRequestError;
            // UI and diagnostics must not replace the original failure.
            try {
                notifyError(blocked ? failure.message : localize('vertex_paygo.hook.request_blocked', {
                    message: localizeError(localize, failure),
                }));
            } catch { /* Preserve the request error. */ }
            recordClientEvent(logger, blocked ? 'warn' : 'error', blocked ? 'request.blocked' : 'request.prepare_failed', {
                ...logContext,
                phase: blocked ? 'blocked' : 'failed',
                durationMs: Date.now() - startedAt,
                ...getSafeErrorContext(failure),
            });
            try { logger.error('[Vertex PayGo] Request blocked before generation.', failure); }
            catch { /* Preserve the request error. */ }
            throw failure;
        }
    };
}
