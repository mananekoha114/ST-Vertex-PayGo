import test from 'node:test';
import assert from 'node:assert/strict';
import { installRequestTransport } from '../src/request-transport.js';
import { enrichGemini4ModelList, GEMINI4_NATIVE_ROUTE, isNativeGemini4Request } from '../src/gemini4-request.js';

const origin = 'http://localhost:8000';
const route = '/api/backends/chat-completions/generate';
function fixture(prepared = {}) {
    const sent = [];
    const target = { location: { origin }, fetch: async (input, init) => {
        sent.push({ input, init, data: JSON.parse(init.body) });
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    } };
    const hook = installRequestTransport({ context: {}, target, origin,
        stateProvider: () => ({ tier: 'standard', paygoOnly: false }),
        serverClient: { prepare: async () => ({ proxyUrl: 'http://127.0.0.1:12345/proxy/ticket',
            proxySecret: 'mock-secret', nativeGemini4: true, nativeGeminiApiVersion: 'v1beta', ...prepared }) },
    });
    return { target, hook, sent };
}
const payload = source => ({ chat_completion_source: source, model: 'gemini-4-argon',
    vertexai_region: 'global', vertexai_auth_mode: 'express', max_tokens: 4096,
    messages: [{ role: 'user', content: 'question' }], include_reasoning: true, reasoning_effort: 'medium', stream: true });

test('only native Google Argon requests use the compatibility route', async () => {
    for (const source of ['makersuite', 'vertexai']) {
        const f = fixture();
        const body = payload(source);
        f.hook(body);
        await f.target.fetch(route, { method: 'POST', headers: { 'x-csrf-token': 'fixture' }, body: JSON.stringify(body) });
        assert.equal(f.sent[0].input, origin + GEMINI4_NATIVE_ROUTE);
        assert.equal(f.sent[0].data.model, 'gemini-4-argon');
        assert.equal(f.sent[0].data.reasoning_effort, 'medium');
        assert.equal(f.sent[0].data.max_tokens, 4096);
        assert.equal(f.sent[0].data.native_gemini_api_version, 'v1beta');
        assert.equal(f.sent[0].init.headers['x-csrf-token'], 'fixture');
    }
    assert.equal(isNativeGemini4Request({ ...payload('custom') }), false);
    assert.equal(isNativeGemini4Request({ ...payload('makersuite'), model: 'gemini-3.1-pro-preview' }), false);
});

test('retargeted Request preserves headers, method and cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    const request = new Request(origin + route, { method: 'POST', headers: { 'x-csrf-token': 'fixture' },
        credentials: 'same-origin', signal: controller.signal, body: JSON.stringify(payload('makersuite')) });
    await f.target.fetch(request);
    assert.equal(f.sent[0].input.url, origin + GEMINI4_NATIVE_ROUTE);
    assert.equal(f.sent[0].input.headers.get('x-csrf-token'), 'fixture');
    assert.equal(f.sent[0].input.method, 'POST');
    assert.equal(f.sent[0].input.credentials, 'same-origin');
    controller.abort();
    assert.equal(f.sent[0].input.signal.aborted, true);
});

test('old server fails before generation instead of silently dropping Argon reasoning', async () => {
    const f = fixture({ nativeGemini4: false });
    await assert.rejects(f.target.fetch(route, { method: 'POST', body: JSON.stringify(payload('makersuite')) }),
        { code: 'GEMINI4_SERVER_UPGRADE_REQUIRED' });
    assert.equal(f.sent.length, 0);
});

test('model list receives missing limits before host status handling, preserving authoritative values', async () => {
    const response = Response.json({ data: [{ id: 'gemini-4-argon', inputTokenLimit: 900000 }, { id: 'unrelated' }] });
    const result = await enrichGemini4ModelList(response);
    const data = await result.json();
    assert.equal(data.data.find(record => record.id === 'gemini-4-argon').inputTokenLimit, 900000);
    assert.equal(data.data.find(record => record.id === 'gemini-4-argon').outputTokenLimit, 1048576);
    assert.equal(data.data.find(record => record.id === 'gemini-4-argon-cyber-permissive').inputTokenLimit, 1048576);
    assert.deepEqual(data.data.find(record => record.id === 'unrelated'), { id: 'unrelated' });
    const error = new Response('failure', { status: 502 });
    assert.equal(await enrichGemini4ModelList(error), error);
});
