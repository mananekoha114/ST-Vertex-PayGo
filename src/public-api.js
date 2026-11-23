/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
    AI_STUDIO_SOURCE,
    CLIENT_VERSION,
    DEFAULT_STATE,
    EXTENSION_ID,
    isGoogleSource,
    PROTOCOL_VERSION,
    VERTEX_SOURCE,
} from './constants.js';
import { createLocalizer, localizeValidation } from './i18n.js';
import { serverSupportsNativeGemini4 } from './gemini4-models.js';
import { isNativeGemini4Request } from './gemini4-request.js';
import { buildPreparePayload, PayGoRequestError, resolveVertexRegion } from './request-hook.js';
import { normalizeState, requiresPlugin, validatePluginState } from './state-machine.js';

export const PUBLIC_API_VERSION = 1;
export const PUBLIC_API_READY_EVENT = 'st-vertex-paygo:ready';

const REQUEST_STATE = '__vertexPayGoRequestState';

export function createPublicApi({
    mode = 'server',
    getState = () => DEFAULT_STATE,
    serverClient = null,
    usageReader = serverClient,
    messageCosts = null,
    getVertexDefaults = () => undefined,
    captureUsageContext = () => null,
    getUsagePrice = () => null,
    localize = createLocalizer(),
} = {}) {
    const listeners = new Set();
    let destroyed = false;

    function getStatus() {
        const state = normalizeState(getState?.());
        return Object.freeze({
            ready: !destroyed,
            apiVersion: PUBLIC_API_VERSION,
            mode,
            clientVersion: CLIENT_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            state: Object.freeze({ ...state }),
        });
    }

    function inspectRoute(generateData = {}) {
        const data = generateData && typeof generateData === 'object' ? generateData : {};
        const rawMeta = data[REQUEST_STATE];
        const meta = rawMeta && typeof rawMeta === 'object' ? rawMeta : null;
        const rawSource = data.chat_completion_source;
        const google = isGoogleSource(rawSource);
        const source = google ? rawSource : null;
        const model = String(data.model ?? '').trim();

        const rawState = meta?.state
            ?? (data.extensions?.[EXTENSION_ID]
                ? normalizeState(data.extensions[EXTENSION_ID])
                : data.type === 'extension_internal'
                    ? DEFAULT_STATE
                    : normalizeState(getState?.()));
        const state = normalizeState(rawState);

        const originalReverseProxy = meta?.sink && data.reverse_proxy === meta.sink
            ? String(meta.originalReverseProxy ?? '')
            : String(data.reverse_proxy ?? '');
        const originalBaseUrl = meta?.originalBaseUrl !== undefined
            ? String(meta.originalBaseUrl ?? '')
            : String(data.base_url ?? '');

        return Object.freeze({
            isGoogleSource: google,
            requiresPlugin: google && requiresPlugin(state, source, model),
            isNativeGemini4: isNativeGemini4Request(data),
            source,
            model,
            tier: state.tier,
            paygoOnly: Boolean(state.paygoOnly),
            originalReverseProxy,
            originalBaseUrl,
            usageChatId: meta?.usageChatId ?? null,
        });
    }

    function onPrepare(listener) {
        if (typeof listener !== 'function') {
            throw new TypeError('onPrepare listener must be a function.');
        }
        if (destroyed) return () => false;
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function emitPrepared(summary = {}) {
        if (destroyed || !summary || typeof summary !== 'object') return;
        const nativeGemini4 = Boolean(summary.nativeGemini4);
        const event = Object.freeze({
            usageId: summary.usageId ?? null,
            usageChatId: summary.usageChatId ?? null,
            source: summary.source ?? null,
            model: String(summary.model ?? '').trim(),
            tier: summary.tier ?? DEFAULT_STATE.tier,
            paygoOnly: Boolean(summary.paygoOnly),
            stream: Boolean(summary.stream),
            nativeGemini4,
            nativeGeminiApiVersion: nativeGemini4 ? (summary.nativeGeminiApiVersion ?? null) : null,
            background: Boolean(summary.background),
        });
        for (const listener of [...listeners]) {
            try {
                listener(event);
            } catch (error) {
                console.warn('[Vertex PayGo] Public API onPrepare listener failed.', error);
            }
        }
    }

    async function prepareTicket(generateData, { signal, state: stateOverride, chatId, background = true } = {}) {
        if (destroyed) {
            throw Object.assign(new Error('STVertexPayGo public API is no longer active.'), {
                code: 'NOT_READY',
            });
        }
        if (mode !== 'server' || typeof serverClient?.prepare !== 'function') {
            throw Object.assign(new Error('prepareTicket is only available in SillyTavern / Luker server mode.'), {
                code: 'UNSUPPORTED_MODE',
            });
        }

        const data = generateData && typeof generateData === 'object' ? generateData : {};
        const source = data.chat_completion_source;
        if (!isGoogleSource(source)) {
            throw new PayGoRequestError(
                `Unsupported chat_completion_source for Vertex PayGo: ${String(source ?? '')}`,
                'UNSUPPORTED_SOURCE',
            );
        }

        signal?.throwIfAborted?.();

        const inspect = inspectRoute(data);
        const requestedState = normalizeState(stateOverride ?? { tier: inspect.tier, paygoOnly: inspect.paygoOnly });
        const vertexDefaults = source === VERTEX_SOURCE ? getVertexDefaults?.(data) : undefined;
        const region = source === VERTEX_SOURCE ? resolveVertexRegion(data, vertexDefaults) : undefined;

        const validation = validatePluginState({
            state: requestedState,
            source,
            model: data.model,
            region,
        });
        if (!validation.ok) {
            throw new PayGoRequestError(localizeValidation(localize, validation, requestedState), validation.code);
        }

        const usageChatId = chatId !== undefined ? chatId : (captureUsageContext?.() ?? null);
        const usagePrice = getUsagePrice?.(
            data,
            validation.state,
            source === VERTEX_SOURCE ? { region } : {},
        ) ?? null;

        const rawMeta = data[REQUEST_STATE];
        const meta = rawMeta && typeof rawMeta === 'object' ? rawMeta : null;
        const proxyPassword = meta?.sink && data.reverse_proxy === meta.sink
            ? (meta.originalProxyPassword ?? '')
            : data.proxy_password;
        const reverseProxy = inspect.originalReverseProxy.trim();
        const baseUrl = inspect.originalBaseUrl.trim();

        const payload = {
            ...buildPreparePayload(
                data,
                validation.state,
                {
                    reverse_proxy: reverseProxy,
                    proxy_password: proxyPassword,
                    base_url: baseUrl,
                },
                vertexDefaults,
            ),
            ...(!reverseProxy && baseUrl && source === AI_STUDIO_SOURCE ? { base_url: baseUrl } : {}),
            ...(usageChatId ? { usageChatId } : {}),
            usagePrice,
        };

        const prepared = await serverClient.prepare(payload, signal ? { signal } : undefined);

        const nativeGemini4 = isNativeGemini4Request(data);
        if (nativeGemini4 && !serverSupportsNativeGemini4(prepared, data.model)) {
            const message = localize?.('vertex_paygo.gemini4.server_upgrade')
                ?? 'Gemini 4 compatibility requires the updated server plugin. Update the server plugin and restart SillyTavern.';
            throw Object.assign(new Error(message), { code: 'GEMINI4_SERVER_UPGRADE_REQUIRED' });
        }

        const nativeGeminiApiVersion = nativeGemini4 ? (prepared.nativeGeminiApiVersion ?? null) : null;
        const resolvedPaygoOnly = source === VERTEX_SOURCE && validation.state.paygoOnly;

        emitPrepared({
            usageId: prepared.usageId ?? null,
            usageChatId: usageChatId ?? null,
            source,
            model: String(data.model ?? '').trim(),
            tier: validation.state.tier,
            paygoOnly: resolvedPaygoOnly,
            stream: Boolean(data.stream),
            nativeGemini4,
            nativeGeminiApiVersion,
            background: Boolean(background),
        });

        return Object.freeze({
            ticket: prepared.ticket,
            proxyUrl: prepared.proxyUrl,
            proxySecret: prepared.proxySecret,
            usageId: prepared.usageId ?? null,
            usageChatId: usageChatId ?? null,
            nativeGemini4,
            nativeGeminiApiVersion,
            tier: validation.state.tier,
            paygoOnly: resolvedPaygoOnly,
            price: usagePrice,
        });
    }

    function attachMessageUsage(options) {
        if (destroyed) return false;
        return messageCosts?.attachUsage?.(options) ?? false;
    }

    async function readUsage(chatId, options = {}) {
        if (destroyed) {
            throw Object.assign(new Error('STVertexPayGo public API is no longer active.'), {
                code: 'NOT_READY',
            });
        }
        if (typeof usageReader?.readUsage !== 'function') {
            throw Object.assign(new Error('Usage reader is unavailable.'), {
                code: 'USAGE_UNAVAILABLE',
            });
        }
        return usageReader.readUsage(chatId, options);
    }

    const api = Object.freeze({
        apiVersion: PUBLIC_API_VERSION,
        clientVersion: CLIENT_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        getStatus,
        inspectRoute,
        onPrepare,
        prepareTicket,
        attachMessageUsage,
        readUsage,
    });

    function destroy() {
        destroyed = true;
        listeners.clear();
    }

    return { api, emitPrepared, destroy };
}

export function installPublicApi(target, api) {
    if (!target || typeof target !== 'object') return () => {};
    target.STVertexPayGo = api;
    const EventCtor = target.CustomEvent ?? globalThis.CustomEvent;
    if (typeof target.dispatchEvent === 'function' && typeof EventCtor === 'function') {
        try {
            target.dispatchEvent(new EventCtor(PUBLIC_API_READY_EVENT, {
                detail: {
                    apiVersion: api.apiVersion ?? PUBLIC_API_VERSION,
                    mode: api.getStatus?.().mode ?? 'server',
                },
            }));
        } catch (error) {
            console.warn('[Vertex PayGo] Failed to dispatch st-vertex-paygo:ready event.', error);
        }
    }
    return () => {
        if (target.STVertexPayGo === api) {
            delete target.STVertexPayGo;
        }
    };
}
