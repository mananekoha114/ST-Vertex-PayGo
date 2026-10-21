import test from 'node:test';
import assert from 'node:assert/strict';
import { installRequestTransport } from '../src/request-transport.js';

const origin = 'http://localhost:8000';
const endpoint = '/api/backends/chat-completions/generate';
const flex = { tier: 'flex', paygoOnly: false };
const standard = { tier: 'standard', paygoOnly: false };
const data = () => ({ chat_completion_source: 'makersuite', model: 'gemini-2.5-pro', stream: false });

function setup({ state = flex, prepare, presets = {}, profiles = {}, captureUsageContext, getUsagePrice } = {}) {
    const sent = [];
    const prepared = [];
    const target = { location: { origin }, fetch: async (input, init) => {
        sent.push({ input, init, data: init?.body ? JSON.parse(init.body) : undefined });
        return 'response';
    } };
    class ChatCompletionService {
        static async processRequest(payload, options) {
            // Model the host's clone/merge boundary and async preset work.
            await Promise.resolve();
            return this.sendRequest({ ...data(), ...presets[options.presetName]?.payload, ...structuredClone(payload) });
        }
        static sendRequest(payload, extract, signal) {
            return target.fetch(endpoint, { method: 'POST', body: JSON.stringify(payload), signal });
        }
    }
    class ConnectionManagerRequestService {
        static getProfile(id) { return profiles[id]; }
        static sendRequest(id, prompt, max, custom, overrides) {
            const profile = this.getProfile(id);
            return ChatCompletionService.processRequest({ ...data(), secret_id: profile['secret-id'], ...overrides },
                { presetName: custom.includePreset === false ? undefined : profile.preset });
        }
    }
    const context = { ChatCompletionService, ConnectionManagerRequestService,
        getPresetManager: () => ({ getCompletionPresetByName: name => presets[name] }) };
    const hook = installRequestTransport({ context, target, stateProvider: () => state, captureUsageContext, getUsagePrice,
        logger: { error() {} }, serverClient: { prepare: async payload => {
            prepared.push(payload);
            if (prepare) await prepare(payload);
            return { proxyUrl: 'http://127.0.0.1:12345/proxy/ticket', proxySecret: 'fake-token' };
        } } });
    return { target, hook, context, sent, prepared };
}

test('chat prepare runs after a late secret override and keeps the event failure sink', async () => {
    const f = setup();
    const payload = data();
    f.hook(payload);
    assert.equal(f.prepared.length, 0);
    assert.match(payload.reverse_proxy, /^vertex-paygo-blocked:/);
    const finalBody = { ...structuredClone(payload), secret_id: 'chosen-key' };
    await f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(finalBody) });
    assert.equal(f.prepared.length, 1);
    assert.equal(f.prepared[0].secret_id, 'chosen-key');
    assert.equal(f.sent[0].data.proxy_password, 'fake-token');
    assert.equal(Object.keys(f.sent[0].data).some(k => k.startsWith('__vertex')), false);
});

test('overlapping profiles use their own state and never the active UI tier', async () => {
    const f = setup({ profiles: {
        a: { mode: 'cc', api: 'makersuite', 'vertex-paygo': flex, 'secret-id': 'a-key' },
        b: { mode: 'cc', api: 'makersuite', 'vertex-paygo': standard, 'secret-id': 'b-key' },
    } });
    await Promise.all(['a', 'b'].map(id => f.context.ConnectionManagerRequestService.sendRequest(id, 'fixture', 10)));
    assert.equal(f.prepared.length, 2);
    assert.equal(f.prepared.find(x => x.secret_id === 'a-key').tier, 'flex');
    assert.equal(f.prepared.find(x => x.secret_id === 'b-key').tier, 'standard');
    assert.match(f.sent.find(x => x.data.secret_id === 'b-key').data.reverse_proxy, /127\.0\.0\.1/);
});

test('profile preference overrides preset; absent profile preference uses the requested preset', async () => {
    const f = setup({ state: standard, presets: { discounted: { extensions: { 'vertex-paygo': flex } } },
        profiles: { a: { mode: 'cc', api: 'makersuite', preset: 'discounted' },
            b: { mode: 'cc', api: 'makersuite', preset: 'discounted', 'vertex-paygo': standard } } });
    await f.context.ConnectionManagerRequestService.sendRequest('a', 'fixture', 10);
    await f.context.ConnectionManagerRequestService.sendRequest('b', 'fixture', 10);
    await f.context.ConnectionManagerRequestService.sendRequest('a', 'fixture', 10, { includePreset: false });
    assert.deepEqual(f.prepared.map(x => x.tier), ['flex', 'standard', 'standard']);
    assert.match(f.sent[1].data.reverse_proxy, /127\.0\.0\.1/);
    assert.match(f.sent[2].data.reverse_proxy, /127\.0\.0\.1/);
});

test('direct preset requests use that preset and direct payloads default to Standard', async () => {
    const f = setup({ presets: { discounted: { extensions: { 'vertex-paygo': flex } } } });
    await f.context.ChatCompletionService.processRequest(data(), { presetName: 'discounted' });
    await f.context.ChatCompletionService.sendRequest(data());
    assert.deepEqual(f.prepared.map(x => x.tier), ['flex', 'standard']);
    assert.match(f.sent[1].data.reverse_proxy, /127\.0\.0\.1/);
    await assert.rejects(f.context.ChatCompletionService.processRequest(data(), { presetName: 'missing' }), /Cannot resolve/);
});

test('preparation failure and proxy conflicts reject before any generation request', async () => {
    const failure = Object.assign(new Error('Selected Google credential was not found.'), {
        code: 'HTTP_ERROR', serverCode: 'EXPLICIT_SECRET_NOT_FOUND', status: 400,
    });
    const f = setup({ prepare: () => { throw failure; } });
    const payload = data();
    f.hook(payload);
    await assert.rejects(f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(payload) }), error => error === failure);
    assert.equal(f.sent.length, 0);
    const conflict = { ...data(), chat_completion_source: 'vertexai', reverse_proxy: 'https://custom.example' };
    f.hook(conflict);
    await assert.rejects(f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(conflict) }), {
        code: 'CUSTOM_REVERSE_PROXY_CONFLICT',
    });
    assert.equal(f.prepared.length, 1);
    assert.equal(f.sent.length, 0);
});

test('background service, preset and connection profile failures propagate without generating', async () => {
    const failure = Object.assign(new Error('The selected Google credential was not found.'), {
        code: 'HTTP_ERROR', serverCode: 'EXPLICIT_SECRET_NOT_FOUND', status: 400,
    });
    const f = setup({ prepare: () => { throw failure; },
        presets: { discounted: { extensions: { 'vertex-paygo': flex } } },
        profiles: { a: { mode: 'cc', api: 'makersuite', 'vertex-paygo': flex } },
    });
    for (const send of [
        () => f.context.ChatCompletionService.sendRequest(data()),
        () => f.context.ChatCompletionService.processRequest(data(), { presetName: 'discounted' }),
        () => f.context.ConnectionManagerRequestService.sendRequest('a', 'fixture', 10),
    ]) await assert.rejects(send(), error => error === failure);
    assert.equal(f.prepared.length, 3);
    assert.equal(f.sent.length, 0);
});

test('unmarked chat paths also prepare; unrelated fetches remain untouched', async () => {
    const f = setup();
    await f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(data()) });
    assert.equal(f.prepared.length, 1);
    const init = { method: 'POST', body: JSON.stringify({ chat_completion_source: 'custom' }) };
    await f.target.fetch(endpoint, init);
    assert.equal(f.sent[1].init, init);
    await f.target.fetch('/api/other');
    assert.equal(f.prepared.length, 1);
});

test('preset-inherited Studio proxies are prepared and non-Google preset fallbacks stay native', async () => {
    const f = setup({ presets: { proxy: { extensions: { 'vertex-paygo': flex },
        payload: { reverse_proxy: 'https://custom.example', proxy_password: 'custom' } } } });
    await f.context.ChatCompletionService.processRequest(data(), { presetName: 'proxy' });
    assert.equal(f.prepared[0].reverse_proxy, 'https://custom.example');
    assert.equal(f.prepared[0].proxy_password, 'custom');
    assert.equal(f.sent[0].data.proxy_password, 'fake-token');
    await f.context.ChatCompletionService.processRequest({ chat_completion_source: 'custom' }, { presetName: 'missing' });
    assert.equal(f.prepared.length, 1);
    assert.equal(f.sent[1].data.reverse_proxy, undefined);
});

test('Studio proxy credentials survive the chat failure sink and remain isolated across background requests', async () => {
    const f = setup({ presets: {
        first: { payload: { reverse_proxy: 'http://localhost:9000/gateway', proxy_password: 'first-password' } },
        second: { payload: { reverse_proxy: 'https://second.example', proxy_password: 'second-password' } },
    } });
    const request = { ...data(), reverse_proxy: 'https://chat.example/prefix/', proxy_password: 'chat-password' };
    f.hook(request);
    assert.notEqual(request.proxy_password, 'chat-password');
    await Promise.all([
        f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(request) }),
        ...['first', 'second'].map(presetName => f.context.ChatCompletionService.processRequest(data(), { presetName })),
        f.context.ChatCompletionService.sendRequest({ ...data(), reverse_proxy: 'https://direct.example' }),
    ]);
    assert.deepEqual(Object.fromEntries(f.prepared.map(p => [p.reverse_proxy, p.proxy_password])), {
        'https://chat.example/prefix/': 'chat-password',
        'http://localhost:9000/gateway': 'first-password',
        'https://second.example': 'second-password',
        'https://direct.example': '',
    });
    for (const sent of f.sent) {
        assert.match(sent.data.reverse_proxy, /^http:\/\/127\.0\.0\.1:/u);
        assert.equal(sent.data.proxy_password, 'fake-token');
        assert.equal(Object.keys(sent.data).some(k => k.startsWith('__vertex')), false);
    }
});

test('aborted requests never generate; Request objects preserve headers and abort signal', async () => {
    const controller = new AbortController();
    const f = setup({ prepare: () => controller.abort() });
    const input = new Request(`${origin}${endpoint}`, { method: 'POST', headers: { 'x-csrf-token': 'fixture' },
        signal: controller.signal, body: JSON.stringify(data()) });
    await assert.rejects(f.target.fetch(input), { name: 'AbortError' });
    assert.equal(f.sent.length, 0);
    await assert.rejects(f.target.fetch(input), { name: 'AbortError' });
    assert.equal(f.prepared.length, 1);
});

test('usage attribution is fixed at generation start even if the active conversation changes', async () => {
    let chatId = 'chat-first';
    const rate = { input: 2, cachedInput: 0.2, output: 12 };
    const f = setup({ state: standard, captureUsageContext: () => chatId, getUsagePrice: () => ({ ...rate }) });
    const request = data();
    f.hook(request);
    chatId = 'chat-second';
    await f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(request) });
    assert.equal(f.prepared[0].usageChatId, 'chat-first');
    assert.deepEqual(f.prepared[0].usagePrice, rate);
    assert.equal(f.sent[0].data.usageChatId, undefined);
    assert.equal(f.sent[0].data.usagePrice, undefined);
    assert.equal(Object.keys(f.sent[0].data).some(key => key.startsWith('__vertex')), false);
});

test('background preset work keeps its conversation and missing conversation does not fall into a later chat', async () => {
    let chatId = 'chat-first';
    const f = setup({ state: standard, captureUsageContext: () => chatId });
    const pending = f.context.ChatCompletionService.processRequest(data(), {});
    chatId = 'chat-second';
    await pending;
    assert.equal(f.prepared[0].usageChatId, 'chat-first');
    chatId = null;
    const request = data();
    f.hook(request);
    chatId = 'chat-third';
    await f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(request) });
    assert.equal(f.prepared[1].usageChatId, undefined);
});
