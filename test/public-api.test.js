/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'yaml';
import {
    AI_STUDIO_SOURCE,
    CLIENT_VERSION,
    EXTENSION_ID,
    PROTOCOL_VERSION,
    TIER,
    VERTEX_SOURCE,
} from '../src/constants.js';
import { PayGoRequestError } from '../src/request-hook.js';
import {
    createPublicApi,
    installPublicApi,
    PUBLIC_API_READY_EVENT,
    PUBLIC_API_VERSION,
} from '../src/public-api.js';
import { initTauriTavern } from '../src/tauri-runtime.js';
import { nativeContext, nativeDocument, nativeStore } from './helpers/native-dom.js';

const REQUEST_STATE = '__vertexPayGoRequestState';

test('createPublicApi exposes a frozen v1 API and live status lifecycle', () => {
    let currentState = { version: 1, tier: TIER.FLEX, paygoOnly: true };
    const { api, destroy } = createPublicApi({
        mode: 'server',
        getState: () => currentState,
    });

    assert.equal(Object.isFrozen(api), true);
    assert.equal(api.apiVersion, PUBLIC_API_VERSION);
    assert.equal(api.apiVersion, 1);
    assert.equal(api.clientVersion, CLIENT_VERSION);
    assert.equal(api.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, 3);

    const status1 = api.getStatus();
    assert.equal(Object.isFrozen(status1), true);
    assert.equal(Object.isFrozen(status1.state), true);
    assert.deepEqual(status1, {
        ready: true,
        apiVersion: 1,
        mode: 'server',
        clientVersion: CLIENT_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        state: { version: 1, tier: TIER.FLEX, paygoOnly: true },
    });

    currentState = { tier: TIER.STANDARD, paygoOnly: false };
    assert.deepEqual(api.getStatus().state, { version: 1, tier: TIER.STANDARD, paygoOnly: false });

    destroy();
    assert.equal(api.getStatus().ready, false);
});

test('inspectRoute is read-only, unwraps sinks without leaking secrets, and isolates extension_internal', () => {
    const { api } = createPublicApi({
        mode: 'server',
        getState: () => ({ tier: TIER.FLEX, paygoOnly: true }),
    });

    const nonGoogle = api.inspectRoute({ chat_completion_source: 'openai', model: 'gpt-4o' });
    assert.equal(Object.isFrozen(nonGoogle), true);
    assert.deepEqual(nonGoogle, {
        isGoogleSource: false,
        requiresPlugin: false,
        isNativeGemini4: false,
        source: null,
        model: 'gpt-4o',
        tier: TIER.FLEX,
        paygoOnly: true,
        originalReverseProxy: '',
        originalBaseUrl: '',
        usageChatId: null,
    });

    const sinkRequest = {
        chat_completion_source: VERTEX_SOURCE,
        model: 'gemini-4-carbon',
        reverse_proxy: 'vertex-paygo-blocked://request',
        proxy_password: 'blocked-ephemeral-secret',
        base_url: 'https://ignored.example',
        [REQUEST_STATE]: {
            state: { tier: TIER.PRIORITY, paygoOnly: false },
            sink: 'vertex-paygo-blocked://request',
            originalReverseProxy: 'https://proxy.example/vertex',
            originalProxyPassword: 'super-secret-password',
            originalBaseUrl: 'https://base.example/custom',
            usageChatId: 'chat-42',
        },
    };
    const inspected = api.inspectRoute(sinkRequest);
    assert.equal(Object.isFrozen(inspected), true);
    assert.deepEqual(inspected, {
        isGoogleSource: true,
        requiresPlugin: true,
        isNativeGemini4: true,
        source: VERTEX_SOURCE,
        model: 'gemini-4-carbon',
        tier: TIER.PRIORITY,
        paygoOnly: false,
        originalReverseProxy: 'https://proxy.example/vertex',
        originalBaseUrl: 'https://base.example/custom',
        usageChatId: 'chat-42',
    });
    assert.equal('originalProxyPassword' in inspected, false);
    assert.equal('proxy_password' in inspected, false);
    assert.equal('proxySecret' in inspected, false);
    assert.equal(sinkRequest.reverse_proxy, 'vertex-paygo-blocked://request');

    // Unmarked extension_internal requests isolate to Standard instead of UI Flex.
    const internalTask = api.inspectRoute({
        chat_completion_source: AI_STUDIO_SOURCE,
        model: 'gemini-2.5-flash',
        type: 'extension_internal',
        base_url: 'https://custom-aistudio.example/v1',
    });
    assert.equal(internalTask.tier, TIER.STANDARD);
    assert.equal(internalTask.paygoOnly, false);
    assert.equal(internalTask.originalBaseUrl, 'https://custom-aistudio.example/v1');

    // Explicit extension state override on unmarked requests is honored.
    const taggedTask = api.inspectRoute({
        chat_completion_source: AI_STUDIO_SOURCE,
        model: 'gemini-2.5-flash',
        type: 'extension_internal',
        extensions: { [EXTENSION_ID]: { tier: TIER.FLEX, paygoOnly: false } },
    });
    assert.equal(taggedTask.tier, TIER.FLEX);
});

test('onPrepare redacts all credential fields, isolates throwing listeners, and supports unsubscribe', () => {
    const { api, emitPrepared, destroy } = createPublicApi({ mode: 'server' });

    assert.throws(() => api.onPrepare('not-a-fn'), TypeError);

    const received = [];
    const unsub1 = api.onPrepare(() => { throw new Error('boom'); });
    const unsub2 = api.onPrepare(event => received.push(event));

    emitPrepared({
        usageId: 'u-1',
        usageChatId: 'chat-1',
        source: VERTEX_SOURCE,
        model: 'gemini-4-carbon',
        tier: TIER.FLEX,
        paygoOnly: true,
        stream: true,
        nativeGemini4: true,
        nativeGeminiApiVersion: 'v1beta',
        background: false,
        // Accidental secret fields that MUST be stripped:
        ticket: 'secret-ticket',
        proxyUrl: 'http://127.0.0.1:9999/proxy/secret-ticket',
        proxySecret: 'secret-bearer-token',
        proxy_password: 'secret-password',
    });

    assert.equal(received.length, 1);
    assert.equal(Object.isFrozen(received[0]), true);
    assert.deepEqual(received[0], {
        usageId: 'u-1',
        usageChatId: 'chat-1',
        source: VERTEX_SOURCE,
        model: 'gemini-4-carbon',
        tier: TIER.FLEX,
        paygoOnly: true,
        stream: true,
        nativeGemini4: true,
        nativeGeminiApiVersion: 'v1beta',
        background: false,
    });
    for (const forbidden of ['ticket', 'proxyUrl', 'proxySecret', 'proxy_password', 'originalProxyPassword']) {
        assert.equal(Object.hasOwn(received[0], forbidden), false);
    }

    unsub1();
    unsub2();
    emitPrepared({ usageId: 'u-2', source: VERTEX_SOURCE, model: 'gemini-2.5-pro' });
    assert.equal(received.length, 1);

    destroy();
    const lateUnsub = api.onPrepare(() => received.push('late'));
    emitPrepared({ usageId: 'u-3' });
    assert.equal(lateUnsub(), false);
    assert.equal(received.length, 1);
});

test('prepareTicket validates, forwards base_url/signal, checks Gemini 4 support, and emits redacted onPrepare', async () => {
    const prepareCalls = [];
    const preparedEvents = [];
    const priceSnapshot = { inputPerMillion: 1.25, outputPerMillion: 10 };

    const { api } = createPublicApi({
        mode: 'server',
        getState: () => ({ tier: TIER.STANDARD, paygoOnly: false }),
        getVertexDefaults: () => ({ vertexai_region: 'global', vertexai_auth_mode: 'express' }),
        captureUsageContext: () => 'live-chat',
        getUsagePrice: () => priceSnapshot,
        serverClient: {
            async prepare(payload, options) {
                prepareCalls.push({ payload, options });
                if (options?.signal?.aborted) {
                    throw new DOMException('Aborted', 'AbortError');
                }
                return {
                    ticket: 'tok_1234567890abcdef',
                    proxyUrl: 'http://127.0.0.1:43210/proxy/tok_1234567890abcdef',
                    proxySecret: 'bearer-top-secret',
                    usageId: 'usage-99',
                    nativeGemini4: true,
                    nativeGemini4Models: ['gemini-4-carbon'],
                    nativeGeminiApiVersion: 'v1beta',
                };
            },
        },
    });
    api.onPrepare(event => preparedEvents.push(event));

    // 1. MakerSuite with Luker base_url fallback and AbortSignal
    const controller = new AbortController();
    const ticket1 = await api.prepareTicket({
        chat_completion_source: AI_STUDIO_SOURCE,
        model: 'gemini-4-carbon',
        stream: true,
        base_url: 'https://custom-aistudio.example/gemini',
    }, {
        signal: controller.signal,
        chatId: 'chat-custom',
    });

    assert.equal(Object.isFrozen(ticket1), true);
    assert.deepEqual(ticket1, {
        ticket: 'tok_1234567890abcdef',
        proxyUrl: 'http://127.0.0.1:43210/proxy/tok_1234567890abcdef',
        proxySecret: 'bearer-top-secret',
        usageId: 'usage-99',
        usageChatId: 'chat-custom',
        nativeGemini4: true,
        nativeGeminiApiVersion: 'v1beta',
        tier: TIER.STANDARD,
        paygoOnly: false,
        price: priceSnapshot,
    });
    assert.equal(prepareCalls.length, 1);
    assert.equal(prepareCalls[0].payload.base_url, 'https://custom-aistudio.example/gemini');
    assert.equal(prepareCalls[0].payload.reverse_proxy, undefined);
    assert.equal(prepareCalls[0].payload.usageChatId, 'chat-custom');
    assert.deepEqual(prepareCalls[0].payload.usagePrice, priceSnapshot);
    assert.equal(prepareCalls[0].options?.signal, controller.signal);

    assert.equal(preparedEvents.length, 1);
    assert.equal(preparedEvents[0].usageId, 'usage-99');
    assert.equal(preparedEvents[0].nativeGemini4, true);
    assert.equal(preparedEvents[0].nativeGeminiApiVersion, 'v1beta');
    assert.equal(preparedEvents[0].background, true);
    assert.equal('proxySecret' in preparedEvents[0], false);
    assert.equal('ticket' in preparedEvents[0], false);

    // 2. Pre-aborted signal rejects immediately with AbortError without calling serverClient.prepare
    const aborted = new AbortController();
    aborted.abort(new DOMException('User stopped', 'AbortError'));
    await assert.rejects(
        api.prepareTicket({
            chat_completion_source: VERTEX_SOURCE,
            model: 'gemini-2.5-pro',
        }, { signal: aborted.signal }),
        err => err.name === 'AbortError',
    );
    assert.equal(prepareCalls.length, 1);

    // 3. Invalid source throws PayGoRequestError
    await assert.rejects(
        api.prepareTicket({ chat_completion_source: 'openai', model: 'gpt-4o' }),
        err => err instanceof PayGoRequestError && err.code === 'UNSUPPORTED_SOURCE',
    );

    // 4. Invalid region + Flex throws PayGoRequestError(TIER_REQUIRES_GLOBAL)
    await assert.rejects(
        api.prepareTicket({
            chat_completion_source: VERTEX_SOURCE,
            model: 'gemini-3.8-flash',
            vertexai_region: 'us-central1',
        }, { state: { tier: TIER.FLEX, paygoOnly: false } }),
        err => err instanceof PayGoRequestError && err.code === 'TIER_REQUIRES_GLOBAL',
    );

    // 5. Unsupported Flex model throws PayGoRequestError(MODEL_UNSUPPORTED)
    await assert.rejects(
        api.prepareTicket({
            chat_completion_source: VERTEX_SOURCE,
            model: 'gemini-2.5-pro',
            vertexai_region: 'global',
        }, { state: { tier: TIER.FLEX, paygoOnly: false } }),
        err => err instanceof PayGoRequestError && err.code === 'MODEL_UNSUPPORTED',
    );
});

test('prepareTicket unwraps sink credentials for prepare payload and rejects unsupported Gemini 4 server', async () => {
    const payloads = [];
    const { api } = createPublicApi({
        mode: 'server',
        serverClient: {
            async prepare(payload) {
                payloads.push(payload);
                return {
                    ticket: 'tok_abcdef1234567890',
                    proxyUrl: 'http://127.0.0.1:43210/proxy/tok_abcdef1234567890',
                    proxySecret: 'sec',
                    usageId: 'u-sink',
                    nativeGemini4: false,
                };
            },
        },
    });

    const sinkData = {
        chat_completion_source: AI_STUDIO_SOURCE,
        model: 'gemini-2.5-flash',
        reverse_proxy: 'vertex-paygo-blocked://request',
        proxy_password: 'blocked-ephemeral',
        [REQUEST_STATE]: {
            sink: 'vertex-paygo-blocked://request',
            originalReverseProxy: 'https://proxy.example/aistudio',
            originalProxyPassword: 'real-proxy-password',
        },
    };
    await api.prepareTicket(sinkData);
    assert.equal(payloads[0].reverse_proxy, 'https://proxy.example/aistudio');
    assert.equal(payloads[0].proxy_password, 'real-proxy-password');

    await assert.rejects(
        api.prepareTicket({
            chat_completion_source: AI_STUDIO_SOURCE,
            model: 'gemini-4-carbon',
        }),
        { code: 'GEMINI4_SERVER_UPGRADE_REQUIRED' },
    );
});

test('prepareTicket isolates unmarked extension_internal requests to standard when UI state is flex', async () => {
    const payloads = [];
    const { api } = createPublicApi({
        mode: 'server',
        getState: () => ({ tier: TIER.FLEX, paygoOnly: true }),
        getVertexDefaults: () => ({ vertexai_region: 'global', vertexai_auth_mode: 'express' }),
        serverClient: {
            async prepare(payload) {
                payloads.push(payload);
                return {
                    ticket: 'tok_internal_1234567890',
                    proxyUrl: 'http://127.0.0.1:43210/proxy/tok_internal_1234567890',
                    proxySecret: 'sec-internal',
                    usageId: 'u-internal',
                };
            },
        },
    });

    const result = await api.prepareTicket({
        chat_completion_source: VERTEX_SOURCE,
        model: 'gemini-3.8-flash',
        type: 'extension_internal',
    });

    assert.equal(result.tier, TIER.STANDARD);
    assert.equal(result.paygoOnly, false);
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].tier, TIER.STANDARD);
    assert.equal(payloads[0].paygoOnly, false);

    // Explicit extensions['vertex-paygo'] override is still honored.
    const tagged = await api.prepareTicket({
        chat_completion_source: VERTEX_SOURCE,
        model: 'gemini-3.8-flash',
        type: 'extension_internal',
        extensions: { [EXTENSION_ID]: { tier: TIER.FLEX, paygoOnly: true } },
    });
    assert.equal(tagged.tier, TIER.FLEX);
    assert.equal(tagged.paygoOnly, true);
    assert.equal(payloads[1].tier, TIER.FLEX);
    assert.equal(payloads[1].paygoOnly, true);
});

test('prepareTicket rejects in tauri mode and after destroy; attachMessageUsage and readUsage delegate', async () => {
    const attached = [];
    const readCalls = [];
    const { api, destroy } = createPublicApi({
        mode: 'tauri',
        usageReader: {
            async readUsage(chatId, options) {
                readCalls.push({ chatId, options });
                return { ok: true, records: [{ id: 'u-1', chatId }], truncated: false };
            },
        },
        messageCosts: {
            attachUsage(options) {
                attached.push(options);
                return true;
            },
        },
    });

    await assert.rejects(
        api.prepareTicket({ chat_completion_source: VERTEX_SOURCE, model: 'gemini-2.5-pro' }),
        { code: 'UNSUPPORTED_MODE' },
    );

    const attachPayload = { chatId: 'c1', messageIndex: 2, swipeId: 0, requests: [{ id: 'u-1' }] };
    assert.equal(api.attachMessageUsage(attachPayload), true);
    assert.deepEqual(attached, [attachPayload]);

    const usage = await api.readUsage('c1', { ids: ['u-1'] });
    assert.equal(usage.ok, true);
    assert.deepEqual(readCalls, [{ chatId: 'c1', options: { ids: ['u-1'] } }]);

    destroy();
    assert.equal(api.attachMessageUsage(attachPayload), false);
    await assert.rejects(api.readUsage('c1'), { code: 'NOT_READY' });
    await assert.rejects(
        api.prepareTicket({ chat_completion_source: VERTEX_SOURCE, model: 'gemini-2.5-pro' }),
        { code: 'NOT_READY' },
    );
});

test('installPublicApi mounts global API, dispatches ready event, and cleans up safely', () => {
    const dispatched = [];
    const target = {
        dispatchEvent(event) {
            dispatched.push(event);
        },
    };
    const { api } = createPublicApi({ mode: 'server' });
    const uninstall = installPublicApi(target, api);

    assert.equal(target.STVertexPayGo, api);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, PUBLIC_API_READY_EVENT);
    assert.deepEqual(dispatched[0].detail, { apiVersion: 1, mode: 'server' });

    // Replacing with a newer API prevents stale cleanup from deleting the new instance.
    const { api: newerApi } = createPublicApi({ mode: 'tauri' });
    const uninstallNewer = installPublicApi(target, newerApi);
    uninstall();
    assert.equal(target.STVertexPayGo, newerApi);

    uninstallNewer();
    assert.equal('STVertexPayGo' in target, false);
});

test('initTauriTavern installs STVertexPayGo in tauri mode and removes it on destroy', async () => {
    const context = nativeContext();
    const documentRef = nativeDocument();
    const store = nativeStore();
    const events = [];
    const target = {
        document: documentRef,
        location: { origin: 'http://tauri.localhost' },
        fetch: async () => Response.json({}),
        dispatchEvent(event) { events.push(event); },
        __TAURITAVERN__: { ready: Promise.resolve(), api: { extension: { store }, llmConnections: { save: async () => {} } } },
        setInterval: () => 1,
        clearInterval() {},
    };

    const runtime = await initTauriTavern({
        target,
        getContext: () => context,
        loadLibrary: async () => ({ yaml }),
        factories: { refreshPolicy: async () => ({ changed: false }) },
    });

    assert.ok(target.STVertexPayGo);
    assert.equal(target.STVertexPayGo.apiVersion, 1);
    assert.equal(target.STVertexPayGo.getStatus().mode, 'tauri');
    assert.equal(target.STVertexPayGo.getStatus().ready, true);
    assert.equal(events.some(e => e.type === PUBLIC_API_READY_EVENT && e.detail.mode === 'tauri'), true);
    await assert.rejects(
        target.STVertexPayGo.prepareTicket({ chat_completion_source: VERTEX_SOURCE, model: 'gemini-2.5-pro' }),
        { code: 'UNSUPPORTED_MODE' },
    );

    const apiRef = target.STVertexPayGo;
    runtime.destroy();
    assert.equal('STVertexPayGo' in target, false);
    assert.equal(apiRef.getStatus().ready, false);
});

test('prepareTicket enforces Full auth and server vertexMultiRegions capability on us/eu', async () => {
    let serverRegions = undefined;
    const { api } = createPublicApi({
        mode: 'server',
        serverClient: {
            prepare: async () => ({
                ticket: 't-multi',
                proxyUrl: 'http://127.0.0.1:43210/proxy/t-multi',
                proxySecret: 'secret-token-value',
                ...(serverRegions ? { vertexMultiRegions: serverRegions } : {}),
            }),
        },
    });

    await assert.rejects(
        api.prepareTicket({
            chat_completion_source: VERTEX_SOURCE,
            model: 'gemini-3.8-flash',
            vertexai_region: 'us',
            vertexai_auth_mode: 'express',
        }),
        { code: 'MULTI_REGION_REQUIRES_FULL_AUTH' },
    );

    await assert.rejects(
        api.prepareTicket({
            chat_completion_source: VERTEX_SOURCE,
            model: 'gemini-3.8-flash',
            vertexai_region: 'eu',
            vertexai_auth_mode: 'full',
        }),
        { code: 'MULTI_REGION_SERVER_UPGRADE_REQUIRED' },
    );

    serverRegions = ['us', 'eu'];
    const prepared = await api.prepareTicket({
        chat_completion_source: VERTEX_SOURCE,
        model: 'gemini-3.8-flash',
        vertexai_region: 'eu',
        vertexai_auth_mode: 'full',
    });
    assert.equal(prepared.ticket, 't-multi');
});
