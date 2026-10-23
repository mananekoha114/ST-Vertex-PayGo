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

test('known Gemini 4 failures are localized in JSON responses and SSE error events', async () => {
    const { localizeGemini4Response } = await import('../src/gemini4-request.js');
    const localize = (key, parameters) => `${key}|${JSON.stringify(parameters)}`;
    const failure = { code: 'GEMINI4_UPSTREAM_HTTP_ERROR', message: 'English', details: { upstreamStatus: 429, upstreamMessage: 'Quota exceeded' } };
    const json = await localizeGemini4Response(new Response(JSON.stringify({ error: failure, code: failure.code, message: 'English' }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } }), localize);
    const body = await json.json();
    assert.equal(json.status, 429);
    assert.equal(body.error.message, 'vertex_paygo.gemini4.upstream_error|{"status":429,"message":"Quota exceeded"}');
    assert.equal(body.message, body.error.message);
    const unknown = new Response(JSON.stringify({ error: { code: 'OTHER', message: 'kept' } }), { status: 500 });
    assert.equal(await localizeGemini4Response(unknown, localize), unknown);

    const frames = ['data: {"candidates":[{"content":{"parts":[{"text":"思考"}]}}]}',
        'data: {"error":{"code":"GEMINI4_OUTPUT_BUDGET_EXHAUSTED","message":"English","details":{"reason":"MAX_TOKENS"}}}',
        'data: {"error":{"code":"OTHER","message":"kept"}}'];
    const bytes = new TextEncoder().encode(frames.join('\n\n') + '\n\n');
    const stream = new ReadableStream({ start(controller) {
        controller.enqueue(bytes.subarray(0, 23)); controller.enqueue(bytes.subarray(23)); controller.close();
    } });
    const sse = await localizeGemini4Response(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }), localize);
    const output = (await sse.text()).trim().split('\n\n');
    assert.equal(output[0], frames[0]);
    assert.equal(JSON.parse(output[1].slice(6)).error.message, 'vertex_paygo.gemini4.budget_exhausted|{}');
    assert.equal(JSON.parse(output[1].slice(6)).error.code, 'GEMINI4_OUTPUT_BUDGET_EXHAUSTED');
    assert.equal(output[2], frames[2]);
});

test('native Gemini 4 responses pass through the localizer while other routes stay untouched', async () => {
    const target = { location: { origin }, fetch: async () => new Response(JSON.stringify({ error: { code: 'NATIVE_GEMINI_EMPTY_RESPONSE', message: 'English', details: { reason: 'SAFETY' } } }), { status: 502 }) };
    const hook = installRequestTransport({ context: {}, target, origin, localize: (key, parameters) => `${key}:${parameters.reason}`,
        stateProvider: () => ({ tier: 'standard', paygoOnly: false }),
        serverClient: { prepare: async () => ({ proxyUrl: 'http://127.0.0.1:12345/proxy/ticket', proxySecret: 'mock-secret', nativeGemini4: true, nativeGeminiApiVersion: 'v1beta' }) } });
    const body = payload('makersuite');
    hook(body);
    const response = await target.fetch(route, { method: 'POST', headers: {}, body: JSON.stringify(body) });
    assert.equal((await response.json()).error.message, 'vertex_paygo.gemini4.no_output:SAFETY');
});
