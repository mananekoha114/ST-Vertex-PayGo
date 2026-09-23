import test from 'node:test';
import assert from 'node:assert/strict';
import * as yaml from 'yaml';
import { createTauriUsageClient } from '../src/tauri-usage.js';
import { createMessageCosts, getMessageCost } from '../src/message-costs.js';
import { installTauriTransport, TAURI_REQUEST_STATE } from '../src/tauri-transport.js';

const endpoint = '/api/backends/chat-completions/generate';
const state = { tier: 'flex', paygoOnly: false };
const payload = (extra = {}) => ({ chat_completion_source: 'vertexai', model: 'gemini-2.0-flash',
    vertexai_region: 'global', stream: false, type: 'normal', ...extra });

function fixture({ response = () => Response.json({ usage: { input_tokens: 4, output_tokens: 2 } }),
    fetchError, withServices = false } = {}) {
    const values = new Map();
    const store = {
        async setJson({ table, key, value }) { values.set(`${table}/${key}`, structuredClone(value)); },
        async tryGetJson({ table, key }) { const value = values.get(`${table}/${key}`); return value
            ? { found: true, value } : { found: false }; },
        async listKeys({ table }) { return [...values.keys()].filter(key => key.startsWith(`${table}/`))
            .map(key => key.slice(table.length + 1)); },
    };
    const listeners = new Map();
    const bus = {
        on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
        removeListener(name, fn) { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== fn)); },
        emit(name, ...args) { for (const fn of listeners.get(name) ?? []) fn(...args); },
    };
    let chatId = 'chat-a';
    let contextValue = { chat: [{ is_user: true }], eventSource: bus,
        eventTypes: Object.fromEntries(['GENERATION_AFTER_COMMANDS', 'MESSAGE_RECEIVED', 'CHAT_CHANGED']
            .map(name => [name, name])), saveChat: async () => {} };
    const usageClient = createTauriUsageClient({ store });
    const messageCosts = createMessageCosts({ getContext: () => contextValue, getChatId: () => chatId,
        serverClient: usageClient, documentRef: null, retryMs: 60000 });
    const sent = [];
    const target = { location: { origin: 'http://localhost:8000' },
        async fetch(_input, init) { sent.push(JSON.parse(init.body)); if (fetchError) throw fetchError; return response(); } };
    let ready;
    const service = {
        async processRequest(data) { ready(data); return this.sendRequest(data); },
        async sendRequest(data) { return target.fetch(endpoint, { method: 'POST', body: JSON.stringify(data) }); },
    };
    const manager = {
        getProfile() { return { mode: 'cc', api: 'vertexai', 'vertex-paygo': state }; },
        async sendRequest(_id, _prompt, _max, _custom, override) { return service.processRequest(payload(override)); },
    };
    const context = withServices ? { ChatCompletionService: service, ConnectionManagerRequestService: manager } : {};
    ready = installTauriTransport({ context, target, yaml, usageClient, messageCosts,
        stateProvider: () => state, captureUsageContext: () => chatId,
        getUsagePrice: () => ({ input: 1, cachedInput: 0.1, output: 2 }) });
    return { ready, target, service, manager, usageClient, messageCosts, sent, bus,
        context: () => contextValue,
        switchChat() { chatId = 'chat-b'; contextValue = { ...contextValue, chat: [{ is_user: true }] }; bus.emit('CHAT_CHANGED'); },
        async records(id = chatId) { await usageClient.flush(); return (await usageClient.readUsage(id)).records; },
        destroy() { ready.destroy(); messageCosts.destroy(); usageClient.destroy(); },
    };
}

test('native Gemini SSE preserves exact cache and thought usage for the captured message', async t => {
    const raw = 'data: {"usageMetadata":{"promptTokenCount":10,"cachedContentTokenCount":4,"candidatesTokenCount":5,"thoughtsTokenCount":3}}\n\n';
    const f = fixture({ response: () => new Response(raw, { headers: { 'content-type': 'text/event-stream' } }) });
    t.after(() => f.destroy());
    f.bus.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    const data = payload({ stream: true });
    f.ready(data);
    assert.ok(data[TAURI_REQUEST_STATE].messageCostToken);
    const result = await f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(data) });
    assert.equal(await result.text(), raw);
    const message = { is_user: false, extra: {}, swipe_id: 0 };
    f.context().chat.push(message);
    f.bus.emit('MESSAGE_RECEIVED', 1, 'normal');
    await f.messageCosts.refresh();
    const record = (await f.records())[0];
    const cost = getMessageCost(message).requests[0];
    assert.equal(cost.id, record.id);
    assert.equal(record.usageAccuracy, undefined);
    assert.deepEqual(record.usage, { promptTokenCount: 10, cachedContentTokenCount: 4,
        candidatesTokenCount: 5, thoughtsTokenCount: 3 });
    assert.equal(cost.record.usage.thoughtsTokenCount, 3);
    assert.equal(cost.timing.interrupted, false);
    assert.equal(Object.hasOwn(f.sent[0], TAURI_REQUEST_STATE), false);
});

test('normalized non-stream usage is marked partial on the correlated message', async t => {
    const f = fixture(); t.after(() => f.destroy());
    f.bus.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    const data = payload(); f.ready(data);
    const result = await f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(data) });
    await result.text();
    const message = { is_user: false, extra: {}, swipe_id: 0 };
    f.context().chat.push(message); f.bus.emit('MESSAGE_RECEIVED', 1, 'normal');
    await f.messageCosts.refresh();
    assert.equal(getMessageCost(message).requests[0].record.usageAccuracy, 'tauri-normalized');
});

test('background service and connection requests remain uncaptured through settings-ready', async t => {
    const f = fixture({ withServices: true }); t.after(() => f.destroy());
    f.bus.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    await f.service.processRequest(payload());
    await f.manager.sendRequest('p', 'text', 10, {});
    assert.equal(f.sent.length, 2);
    assert.equal(f.messageCosts.getMessageCost(f.context().chat[0]), null);
    assert.equal(f.messageCosts.capture(payload(), 'chat-a') !== null, true);
    assert.equal(f.sent.every(item => !Object.hasOwn(item, TAURI_REQUEST_STATE)), true);
});

test('chat switch and failed request cannot attach old charge to the new chat', async t => {
    const error = new Error('network');
    const f = fixture({ fetchError: error }); t.after(() => f.destroy());
    f.bus.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    const data = payload(); f.ready(data);
    f.switchChat();
    await assert.rejects(f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(data) }), error);
    const records = await f.records('chat-a');
    assert.equal(records[0].status, 'failed');
    assert.equal(getMessageCost(f.context().chat[0]), null);
});

test('captured abort marks message timing interrupted without sending', async t => {
    const f = fixture(); t.after(() => f.destroy());
    f.bus.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    const data = payload(); f.ready(data);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(data), signal: controller.signal }),
        { name: 'AbortError' });
    const message = { is_user: false, extra: {}, swipe_id: 0 };
    f.context().chat.push(message); f.bus.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(getMessageCost(message).requests[0].timing.interrupted, true);
    assert.equal(getMessageCost(message).requests[0].status, 'unavailable');
    assert.equal(f.sent.length, 0);
});

test('pre-aborted native requests never read a streaming body or prefer JSON errors', async t => {
    const f = fixture(); t.after(() => f.destroy());
    const controller = new AbortController(); controller.abort();
    let cloned = false;
    const input = new Request(`${f.target.location.origin}${endpoint}`, {
        method: 'POST', body: new ReadableStream(), duplex: 'half', signal: controller.signal,
    });
    input.clone = () => { cloned = true; throw new Error('must not read aborted body'); };
    await assert.rejects(f.target.fetch(input), { name: 'AbortError' });
    assert.equal(cloned, false);
    await assert.rejects(f.target.fetch(endpoint, { method: 'POST', body: '{invalid', signal: controller.signal }),
        { name: 'AbortError' });
    assert.equal(f.sent.length, 0);
});
