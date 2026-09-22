/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/ */

import { DEFAULT_STATE, EXTENSION_ID, isGoogleSource } from './constants.js';
import { createRequestHook, installFailureSink } from './request-hook.js';
import { normalizeState, requiresPlugin } from './state-machine.js';

const REQUEST_STATE = '__vertexPayGoRequestState';
const GENERATE_PATH = '/api/backends/chat-completions/generate';

// Carry state on each request, rather than in shared mutable state: background
// profile requests may overlap each other and normal chat requests.
function markRequest(data, state, origin, protect = true) {
    const marked = { ...data, [REQUEST_STATE]: { state: normalizeState(state) } };
    if (protect && isGoogleSource(data.chat_completion_source) && requiresPlugin(state, data.chat_completion_source, data.model)) {
        marked[REQUEST_STATE].originalReverseProxy = data.reverse_proxy;
        installFailureSink(marked, origin);
        marked[REQUEST_STATE].sink = marked.reverse_proxy;
    }
    return marked;
}

function presetState(context, name) {
    if (!name) return DEFAULT_STATE;
    const preset = context.getPresetManager?.('openai')?.getCompletionPresetByName?.(name);
    // A missing named preset cannot safely be interpreted as Standard.
    if (!preset) throw new Error(`[Vertex PayGo] Cannot resolve request preset: ${name}`);
    return preset.extensions?.[EXTENSION_ID] ?? DEFAULT_STATE;
}

export function installRequestTransport({ context, stateProvider, target = globalThis, captureUsageContext = () => null,
    getUsagePrice = () => null, ...hookOptions }) {
    const origin = hookOptions.origin ?? target.location?.origin;
    const originalFetch = target.fetch;
    if (typeof originalFetch !== 'function') throw new TypeError('fetch is required.');
    const requestStates = new WeakMap();
    const requestUsage = new WeakMap();
    const prepareRequest = createRequestHook({ ...hookOptions, origin,
        usageProvider: data => requestUsage.get(data) ?? {},
        stateProvider: data => requestStates.get(data) });

    const onSettingsReady = data => {
        if (!isGoogleSource(data?.chat_completion_source)) return;
        Object.assign(data, markRequest(data, stateProvider(), origin));
        data[REQUEST_STATE].usageChatId = captureUsageContext();
    };

    target.fetch = async function payGoFetch(input, init) {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin);
        const method = init?.method ?? input?.method ?? 'GET';
        if (url.origin !== origin || url.pathname !== GENERATE_PATH || method.toUpperCase() !== 'POST') {
            return originalFetch.call(this, input, init);
        }
        const signal = init?.signal ?? input?.signal;
        signal?.throwIfAborted();
        // Capture before async Request body/preset/credential work: switching
        // chats while a request is in flight must never move its charge.
        const fallbackChatId = captureUsageContext();
        const rawBody = init?.body ?? (typeof input?.clone === 'function' ? await input.clone().text() : undefined);
        // Host generation requests use JSON strings; reject unexpected formats
        // instead of silently letting a paid request bypass preparation.
        if (typeof rawBody !== 'string') throw new TypeError('[Vertex PayGo] Expected a JSON generation request.');
        const data = JSON.parse(rawBody);
        const metadata = data[REQUEST_STATE];
        if (!metadata && !isGoogleSource(data.chat_completion_source)) {
            return originalFetch.call(this, input, init);
        }
        delete data[REQUEST_STATE];
        const state = metadata?.state ?? stateProvider();
        if (metadata?.sink && data.reverse_proxy === metadata.sink) {
            data.reverse_proxy = metadata.originalReverseProxy ?? '';
        }
        requestStates.set(data, state);
        const usageChatId = metadata && Object.hasOwn(metadata, 'usageChatId')
            ? metadata.usageChatId : fallbackChatId;
        requestUsage.set(data, {
            ...(usageChatId ? { usageChatId } : {}),
            usagePrice: getUsagePrice(data, state),
        });
        try {
            await prepareRequest(data);
        } finally {
            requestStates.delete(data);
            requestUsage.delete(data);
        }
        signal?.throwIfAborted();
        return originalFetch.call(this, input, { ...init, body: JSON.stringify(data) });
    };

    const service = context.ChatCompletionService;
    if (service) {
        const processRequest = service.processRequest;
        const sendRequest = service.sendRequest;
        service.processRequest = async function (data, options = {}, ...args) {
            if (data.chat_completion_source && !isGoogleSource(data.chat_completion_source)) {
                return processRequest.call(this, data, options, ...args);
            }
            const marked = data[REQUEST_STATE] ? data : markRequest(data,
                // A sink here would override a proxy inherited from the preset
                // before the host merges it. This API propagates errors itself.
                presetState(context, options.presetName), origin, false);
            if (!Object.hasOwn(marked[REQUEST_STATE], 'usageChatId')) {
                marked[REQUEST_STATE].usageChatId = captureUsageContext();
            }
            return processRequest.call(this, marked, options, ...args);
        };
        service.sendRequest = async function (data, ...args) {
            if (!isGoogleSource(data.chat_completion_source)) return sendRequest.call(this, data, ...args);
            const marked = data[REQUEST_STATE] ? data : markRequest(data,
                data.extensions?.[EXTENSION_ID] ?? DEFAULT_STATE, origin);
            if (!Object.hasOwn(marked[REQUEST_STATE], 'usageChatId')) {
                marked[REQUEST_STATE].usageChatId = captureUsageContext();
            }
            return sendRequest.call(this, marked, ...args);
        };
    }

    const manager = context.ConnectionManagerRequestService;
    if (manager) {
        const sendRequest = manager.sendRequest;
        manager.sendRequest = async function (profileId, prompt, maxTokens, custom = {}, overridePayload = {}) {
            const profile = this.getProfile(profileId);
            if (profile?.mode !== 'cc' || !isGoogleSource(profile.api)) {
                return sendRequest.call(this, profileId, prompt, maxTokens, custom, overridePayload);
            }
            const state = profile?.[EXTENSION_ID] ?? presetState(context,
                custom.includePreset === false ? undefined : profile?.preset);
            // The host adds provider/model before merging overridePayload. Do
            // not insert a sink here: validation must see its final proxy too.
            return sendRequest.call(this, profileId, prompt, maxTokens, custom, {
                ...overridePayload, [REQUEST_STATE]: { state: normalizeState(state), usageChatId: captureUsageContext() },
            });
        };
    }
    return onSettingsReady;
}
