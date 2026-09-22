import test from 'node:test';
import assert from 'node:assert/strict';
import { installRequestTransport } from '../src/request-transport.js';

const origin = 'http://localhost:8000';
const endpoint = '/api/backends/chat-completions/generate';
const state = { tier: 'flex', paygoOnly: false };
const requestData = () => ({ chat_completion_source: 'makersuite', model: 'gemini-2.5-pro', stream: false });

function setup({ messageCosts, prepare, response = new Response('ok') } = {}) {
    const sent = [];
    let settingsReady = () => {};
    const target = { location: { origin }, fetch: async (input, init) => {
        sent.push(JSON.parse(init.body));
        return response;
    } };
    class ChatCompletionService {
        static async processRequest(data, options = {}) {
            await Promise.resolve();
            settingsReady(data);
            return this.sendRequest(structuredClone(data), options);
        }
        static sendRequest(data) {
            return target.fetch(endpoint, { method: 'POST', body: JSON.stringify(data) });
        }
    }
    class ConnectionManagerRequestService {
        static getProfile() { return { mode: 'cc', api: 'makersuite', 'vertex-paygo': state }; }
        static sendRequest(_id, _prompt, _max, _custom, overrides) {
            return ChatCompletionService.processRequest({ ...requestData(), ...overrides });
        }
    }
    const context = { ChatCompletionService, ConnectionManagerRequestService };
    const hook = installRequestTransport({
        context, target, stateProvider: () => state, captureUsageContext: () => 'chat-1', messageCosts,
        logger: { error() {} }, origin,
        serverClient: { prepare: async payload => prepare?.(payload) ?? {
            usageId: 'usage-1', proxyUrl: 'http://127.0.0.1:1234/proxy/ticket', proxySecret: 'secret',
        } },
    });
    settingsReady = hook;
    return { hook, context, target, sent };
}

test('foreground settings capture carries the identical token through preparation and response', async () => {
    const token = 'cost-token';
    const calls = [];
    const f = setup({ messageCosts: {
        capture: (data, chatId) => (calls.push(['capture', data.type, chatId]), token),
        prepared: (value, usageId, details) => calls.push(['prepared', value, usageId, details]),
        started: value => calls.push(['started', value]),
        response: (value, response, signal) => (calls.push(['response', value, response, signal]), response),
    } });
    const payload = { ...requestData(), type: 'normal' };
    f.hook(payload);
    await f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(payload) });

    assert.equal(calls[1][1], token);
    assert.equal(calls[1][2], 'usage-1');
    assert.equal(calls[2][1], token);
    assert.equal(calls[3][1], token);
    assert.deepEqual(calls.map(call => call[0]), ['capture', 'prepared', 'started', 'response']);
    assert.equal(Object.keys(f.sent[0]).some(key => key.startsWith('__vertex')), false);
});

test('background service and connection-manager requests stay uncaptured even if settings-ready runs', async () => {
    let captures = 0;
    const f = setup({ messageCosts: { capture: () => (++captures, {}) } });

    await f.context.ChatCompletionService.processRequest(requestData());

    await f.context.ConnectionManagerRequestService.sendRequest('profile', 'prompt', 10, {});
    assert.equal(captures, 0);
});

test('observer exceptions never block generation and private metadata is not sent', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        const f = setup({ messageCosts: {
            capture: () => ({ id: 'token' }),
            prepared: () => { throw new Error('prepared observer failed'); },
            started: () => { throw new Error('started observer failed'); },
            response: () => { throw new Error('response observer failed'); },
        } });
        const payload = requestData();
        f.hook(payload);
        const result = await f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(payload) });
        assert.equal(await result.text(), 'ok');
        assert.equal(Object.keys(f.sent[0]).some(key => key.startsWith('__vertex')), false);
    } finally {
        console.warn = originalWarn;
    }
});

test('an abort after preparation marks the captured request failed and never starts it', async () => {
    const controller = new AbortController();
    const calls = [];
    const token = { id: 'aborted' };
    const f = setup({
        prepare: () => {
            controller.abort();
            return { usageId: 'usage-abort', proxyUrl: 'http://127.0.0.1:1234/proxy/ticket', proxySecret: 'secret' };
        },
        messageCosts: {
            capture: () => token,
            prepared: value => calls.push(['prepared', value]),
            started: value => calls.push(['started', value]),
            failed: value => calls.push(['failed', value]),
        },
    });
    const payload = requestData();
    f.hook(payload);
    await assert.rejects(f.target.fetch(endpoint, {
        method: 'POST', body: JSON.stringify(payload), signal: controller.signal,
    }), { name: 'AbortError' });
    assert.deepEqual(calls, [['prepared', token], ['failed', token]]);
    assert.equal(f.sent.length, 0);
});
