import test from 'node:test';
import assert from 'node:assert/strict';
import { installRequestTransport } from '../src/request-transport.js';

const origin = 'http://localhost:8000';
const endpoint = '/api/backends/chat-completions/generate';
const flex = { tier: 'flex', paygoOnly: false };
const standard = { tier: 'standard', paygoOnly: false };
const data = () => ({ chat_completion_source: 'makersuite', model: 'gemini-2.5-pro', stream: false });

function setup({ state = flex, prepare, presets = {}, profiles = {} } = {}) {
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
    const hook = installRequestTransport({ context, target, stateProvider: () => state,
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
    assert.match(payload.reverse_proxy, /\/rejected$/);
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
    assert.equal(f.prepared.length, 1);
    assert.equal(f.prepared[0].secret_id, 'a-key');
    assert.equal(f.sent.find(x => x.data.secret_id === 'b-key').data.reverse_proxy, undefined);
});

test('profile preference overrides preset; absent profile preference uses the requested preset', async () => {
    const f = setup({ state: standard, presets: { discounted: { extensions: { 'vertex-paygo': flex } } },
        profiles: { a: { mode: 'cc', api: 'makersuite', preset: 'discounted' },
            b: { mode: 'cc', api: 'makersuite', preset: 'discounted', 'vertex-paygo': standard } } });
    await f.context.ConnectionManagerRequestService.sendRequest('a', 'fixture', 10);
    await f.context.ConnectionManagerRequestService.sendRequest('b', 'fixture', 10);
    await f.context.ConnectionManagerRequestService.sendRequest('a', 'fixture', 10, { includePreset: false });
    assert.equal(f.prepared.length, 1);
    assert.equal(f.sent[1].data.reverse_proxy, undefined);
    assert.equal(f.sent[2].data.reverse_proxy, undefined);
});

test('direct preset requests use that preset and direct payloads default to Standard', async () => {
    const f = setup({ presets: { discounted: { extensions: { 'vertex-paygo': flex } } } });
    await f.context.ChatCompletionService.processRequest(data(), { presetName: 'discounted' });
    await f.context.ChatCompletionService.sendRequest(data());
    assert.equal(f.prepared.length, 1);
    assert.equal(f.sent[1].data.reverse_proxy, undefined);
    await assert.rejects(f.context.ChatCompletionService.processRequest(data(), { presetName: 'missing' }), /Cannot resolve/);
});

test('preparation failure and proxy conflicts retain a blocked destination', async () => {
    const f = setup({ prepare: () => { throw new Error('offline'); } });
    const payload = data();
    f.hook(payload);
    await f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(payload) });
    assert.match(f.sent[0].data.reverse_proxy, /\/rejected$/);
    const conflict = { ...data(), reverse_proxy: 'https://custom.example' };
    f.hook(conflict);
    await f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(conflict) });
    assert.equal(f.prepared.length, 1);
    assert.match(f.sent[1].data.reverse_proxy, /\/rejected$/);
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

test('preset-inherited custom proxies are rejected and non-Google preset fallbacks stay native', async () => {
    const f = setup({ presets: { proxy: { extensions: { 'vertex-paygo': flex },
        payload: { reverse_proxy: 'https://custom.example', proxy_password: 'custom' } } } });
    await f.context.ChatCompletionService.processRequest(data(), { presetName: 'proxy' });
    assert.equal(f.prepared.length, 0);
    assert.match(f.sent[0].data.reverse_proxy, /\/rejected$/);
    await f.context.ChatCompletionService.processRequest({ chat_completion_source: 'custom' }, { presetName: 'missing' });
    assert.equal(f.prepared.length, 0);
    assert.equal(f.sent[1].data.reverse_proxy, undefined);
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
