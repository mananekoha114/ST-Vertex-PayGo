import test from 'node:test';
import assert from 'node:assert/strict';
import * as yaml from 'yaml';
import { AI_STUDIO_SOURCE, TIER, VERTEX_SOURCE } from '../src/constants.js';
import { installTauriTransport, TAURI_REQUEST_STATE } from '../src/tauri-transport.js';

const origin = 'http://localhost:8000';
const endpoint = '/api/backends/chat-completions/generate';

function setup({ state = { tier: TIER.FLEX, paygoOnly: false }, context = {}, usageClient,
    captureUsageContext = () => 'chat-transport', getUsagePrice = () => ({ input: 1, cachedInput: 0.1, output: 2 }) } = {}) {
    const calls = [];
    const target = {
        location: { origin },
        fetch: async (input, init) => {
            calls.push({ input, init, data: init?.body ? JSON.parse(init.body) : undefined });
            return new Response('upstream', { headers: { 'content-type': 'text/plain' } });
        },
    };
    const originalFetch = target.fetch;
    const transport = installTauriTransport({ context, target, yaml, stateProvider: () => state,
        usageClient, captureUsageContext, getUsagePrice });
    return { target, transport, calls, originalFetch };
}

function request(source = VERTEX_SOURCE, fields = {}) {
    return {
        chat_completion_source: source,
        model: 'gemini-2.0-flash',
        vertexai_region: 'global',
        stream: false,
        ...fields,
    };
}

test('settings-ready and final fetch apply native Vertex policy without a reverse proxy', async () => {
    let observed;
    const usageClient = {
        observeResponse(response, metadata, options) {
            observed = { response, metadata, options };
            return new Response('observed', { status: response.status, headers: response.headers });
        },
    };
    const f = setup({ usageClient });
    const data = request(VERTEX_SOURCE, {
        custom_include_body: yaml.stringify({ temperature: 0.2 }),
        custom_include_headers: yaml.stringify({ 'X-Trace': 'keep' }),
        custom_exclude_body: '',
    });
    f.transport(data);
    assert.equal(data.reverse_proxy, undefined);
    const controller = new AbortController();
    const result = await f.target.fetch(endpoint, {
        method: 'POST',
        headers: { 'x-csrf-token': 'fixture' },
        signal: controller.signal,
        body: JSON.stringify(data),
    });
    assert.equal(await result.text(), 'observed');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.method, 'POST');
    assert.equal(f.calls[0].init.headers['x-csrf-token'], 'fixture');
    assert.equal(f.calls[0].init.signal, controller.signal);
    assert.deepEqual(yaml.parse(f.calls[0].data.custom_include_headers), {
        'X-Trace': 'keep',
        'X-Vertex-AI-LLM-Shared-Request-Type': 'flex',
        'X-Server-Timeout': '1800',
    });
    assert.equal(f.calls[0].data[TAURI_REQUEST_STATE], undefined);
    assert.equal(observed.metadata.chatId, 'chat-transport');
    assert.equal(observed.metadata.source, VERTEX_SOURCE);
    assert.equal(observed.metadata.tier, TIER.FLEX);
    assert.equal(observed.metadata.paygoOnly, false);
    assert.equal(observed.options.signal, controller.signal);
});

test('native request parameters outrank the foreground state for direct generation', async () => {
    const f = setup({ state: { tier: TIER.PRIORITY, paygoOnly: true } });
    const data = request(VERTEX_SOURCE, {
        custom_include_headers: yaml.stringify({ 'X-Vertex-AI-LLM-Shared-Request-Type': 'flex' }),
    });
    await f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(data) });
    assert.equal(yaml.parse(f.calls[0].data.custom_include_headers)['X-Vertex-AI-LLM-Shared-Request-Type'], 'flex');
    assert.equal(yaml.parse(f.calls[0].data.custom_include_headers)['X-Vertex-AI-LLM-Request-Type'], undefined);
});

test('AI Studio Flex uses service_tier and a service_tier exclusion blocks the send', async () => {
    const f = setup({ state: { tier: TIER.FLEX, paygoOnly: true } });
    const data = request(AI_STUDIO_SOURCE, {
        custom_include_body: yaml.stringify({ temperature: 0.2 }),
        custom_exclude_body: yaml.stringify(['service_tier']),
    });
    f.transport(data);
    await assert.rejects(f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(data) }), error => {
        assert.equal(error.code, 'TAURI_EXCLUDE_CONFLICT');
        return true;
    });
    assert.equal(f.calls.length, 0);
});

test('unknown service_tier is fail-closed and non-Google requests remain untouched', async () => {
    const f = setup({ state: { tier: TIER.STANDARD, paygoOnly: false } });
    const invalid = request(AI_STUDIO_SOURCE, {
        custom_include_body: yaml.stringify({ service_tier: 'priority' }),
    });
    await assert.rejects(f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(invalid) }), error => {
        assert.equal(error.code, 'TAURI_UNKNOWN_SERVICE_TIER');
        return true;
    });
    assert.equal(f.calls.length, 0);

    const customBody = JSON.stringify({ provider: 'custom', custom_include_body: yaml.stringify({ temperature: 0.3 }) });
    const init = { method: 'POST', body: customBody, headers: { 'x-test': 'keep' } };
    await f.target.fetch(`${origin}${endpoint}`, init);
    assert.equal(f.calls[0].init, init);
    assert.equal(f.calls[0].data.custom_include_body, yaml.stringify({ temperature: 0.3 }));
});

test('background process and connection requests retain request-local state', async () => {
    const sent = [];
    const context = {
        ChatCompletionService: {
            async processRequest(data, options) {
                await Promise.resolve();
                return this.sendRequest({ ...request(data.chat_completion_source), ...data });
            },
            async sendRequest(data) {
                return target.fetch(endpoint, { method: 'POST', body: JSON.stringify(data) });
            },
        },
        ConnectionManagerRequestService: {
            getProfile(id) { return this.profiles[id]; },
            profiles: {
                flex: { mode: 'cc', api: VERTEX_SOURCE, 'vertex-paygo': { tier: TIER.FLEX }, },
            },
            async sendRequest(id, prompt, maxTokens, custom, override) {
                return this.__chat.sendRequest({ ...request(VERTEX_SOURCE), ...override });
            },
        },
    };
    const target = {
        location: { origin },
        fetch: async (input, init) => {
            sent.push(JSON.parse(init.body));
            return new Response('ok');
        },
    };
    context.ConnectionManagerRequestService.__chat = context.ChatCompletionService;
    const transport = installTauriTransport({ context, target, yaml,
        stateProvider: () => ({ tier: TIER.PRIORITY, paygoOnly: false }),
    });
    await context.ChatCompletionService.processRequest(request(VERTEX_SOURCE), {});
    await context.ConnectionManagerRequestService.sendRequest('flex', 'p', 10);
    assert.equal(sent.length, 2);
    assert.equal(yaml.parse(sent[0].custom_include_headers)['X-Vertex-AI-LLM-Shared-Request-Type'], 'priority');
    assert.equal(yaml.parse(sent[1].custom_include_headers)['X-Vertex-AI-LLM-Shared-Request-Type'], 'flex');
    transport.destroy();
});

test('destroy restores fetch and wrapped services', async () => {
    const service = { async sendRequest(data) { return data; } };
    const context = { ChatCompletionService: service };
    const originalSend = service.sendRequest;
    const f = setup({ context });
    f.transport.destroy();
    assert.equal(f.target.fetch, f.originalFetch);
    assert.equal(service.sendRequest, originalSend);
});

test('all-empty native Standard snapshots outrank a legacy extension state', async () => {
    const f = setup({ state: { tier: TIER.FLEX, paygoOnly: true } });
    const data = request(VERTEX_SOURCE, {
        extensions: { 'vertex-paygo': { tier: TIER.FLEX, paygoOnly: true } },
        custom_include_body: '',
        custom_exclude_body: '',
        custom_include_headers: '',
    });
    f.transport(data);
    await f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(data) });
    assert.equal(f.calls[0].data.custom_include_headers, '');
    assert.equal(f.calls[0].data.custom_include_body, '');
});

test('nested native preset parameters select state before a delayed host source merge', async () => {
    let chatId = 'chat-at-start';
    let observed;
    const preset = {
        chat_completion_source: VERTEX_SOURCE,
        model: 'gemini-2.0-flash',
        additional_parameters_by_source: {
            [VERTEX_SOURCE]: {
                include_body: yaml.stringify({ temperature: 0.1 }),
                exclude_body: '',
                include_headers: yaml.stringify({ 'X-Vertex-AI-LLM-Shared-Request-Type': TIER.PRIORITY }),
            },
        },
    };
    const target = {
        location: { origin },
        fetch: async (input, init) => {
            const payload = JSON.parse(init.body);
            return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
        },
    };
    const context = {
        getPresetManager: () => ({ getCompletionPresetByName: () => preset }),
        ChatCompletionService: {
            async processRequest(data) {
                await Promise.resolve();
                chatId = 'chat-after-host-work';
                return target.fetch(endpoint, {
                    method: 'POST',
                    body: JSON.stringify({ ...data, chat_completion_source: VERTEX_SOURCE,
                        model: 'gemini-2.5-flash', vertexai_region: 'global', stream: true }),
                });
            },
        },
    };
    const usageClient = {
        observeResponse(response, metadata) { observed = metadata; return response; },
    };
    const transport = installTauriTransport({ context, target, yaml, usageClient,
        stateProvider: () => ({ tier: TIER.STANDARD, paygoOnly: false }),
        captureUsageContext: () => chatId,
        getUsagePrice: data => data.stream ? { input: 2, output: 3 } : { input: 1, output: 1 },
    });
    await context.ChatCompletionService.processRequest({}, { presetName: 'native-preset' });
    assert.equal(observed.chatId, 'chat-at-start');
    assert.equal(observed.tier, TIER.PRIORITY);
    assert.equal(observed.stream, true);
    assert.equal(observed.model, 'gemini-2.5-flash');
    assert.deepEqual(observed.price, { input: 2, output: 3 });
    transport.destroy();
});

test('final metadata updates stream and model while preserving a null chat snapshot', async () => {
    let chatId = null;
    let observed = 0;
    let failure = 0;
    const usageClient = {
        observeResponse() { observed += 1; },
        recordFailure() { failure += 1; },
    };
    const f = setup({ usageClient, state: { tier: TIER.FLEX, paygoOnly: false },
        captureUsageContext: () => chatId });
    const data = request(VERTEX_SOURCE, {
        stream: false,
        custom_include_body: '', custom_exclude_body: '', custom_include_headers: '',
    });
    f.transport(data);
    chatId = 'chat-switched-later';
    const input = new Request(`${origin}${endpoint}`, {
        method: 'POST', body: JSON.stringify({ ...data, stream: true }),
    });
    await f.target.fetch(input);
    assert.equal(observed, 0);
    assert.equal(failure, 0);
});
