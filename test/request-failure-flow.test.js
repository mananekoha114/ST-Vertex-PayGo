import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerClient } from '../src/server-client.js';
import { installRequestTransport } from '../src/request-transport.js';

const origin = 'http://localhost:8000';
const endpoint = '/api/backends/chat-completions/generate';

function setup(reply, state = { tier: 'standard' }) {
    const requests = [];
    const errors = [];
    const target = { location: { origin }, fetch: async (url, init) => {
        requests.push({ url, init });
        if (url === endpoint) return Response.json({ generated: true });
        assert.equal(url, '/api/plugins/vertex-paygo/prepare');
        return reply();
    } };
    const serverClient = createServerClient({ fetchImpl: target.fetch.bind(target),
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'session-token', 'Content-Type': 'application/json' }) });
    const hook = installRequestTransport({ target, context: {}, serverClient, stateProvider: () => state,
        notifyError: message => errors.push(message), logger: { error() {} } });
    return { target, hook, requests, errors };
}

for (const source of ['vertexai', 'makersuite']) {
    for (const stream of [false, true]) {
        test(`${source} stream=${stream}: server preparation errors survive the full client flow`, async () => {
            const f = setup(() => Response.json({ error: true, code: 'GOOGLE_AUTH_CONFIGURATION_FAILED',
                message: 'Google authentication is unavailable for this configuration.' }, { status: 400 }));
            const payload = { chat_completion_source: source, model: 'gemini-2.5-pro', stream };
            f.hook(payload);
            assert.equal(payload.reverse_proxy, 'vertex-paygo-blocked://request');
            await assert.rejects(f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(payload) }), error => {
                assert.equal(error.code, 'HTTP_ERROR');
                assert.equal(error.serverCode, 'GOOGLE_AUTH_CONFIGURATION_FAILED');
                assert.equal(error.status, 400);
                assert.equal(error.message, 'Google authentication is unavailable for this configuration.');
                return true;
            });
            assert.equal(f.requests.length, 1);
            assert.equal(f.requests[0].init.headers['X-CSRF-Token'], 'session-token');
            assert.equal(f.errors.length, 1);
            assert.match(f.errors[0], /GOOGLE_AUTH_CONFIGURATION_FAILED/);
            assert.doesNotMatch(f.errors[0], /CSRF/);
        });
    }
}

test('a genuine CSRF failure ends at prepare with the correct refresh guidance', async () => {
    const f = setup(() => new Response('<html>Invalid CSRF token. Please refresh the page and try again.</html>', { status: 403 }));
    await assert.rejects(f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify({
        chat_completion_source: 'vertexai', model: 'gemini-2.5-pro',
    }) }), { code: 'CSRF_REJECTED', status: 403 });
    assert.equal(f.requests.length, 1);
    assert.match(f.errors[0], /CSRF token.*403.*Refresh/);
});

test('invalid Vertex regions fail before any network request, even behind a custom proxy', async () => {
    for (const [overrides, expectedCode] of [
        [{ vertexai_region: 'us-central1' }, 'TIER_REQUIRES_GLOBAL'],
        [{ vertexai_region: 'us-central1', reverse_proxy: 'https://custom.example' }, 'TIER_REQUIRES_GLOBAL'],
    ]) {
        const f = setup(() => assert.fail('Invalid settings must not prepare'), { tier: 'flex' });
        const payload = { chat_completion_source: 'vertexai', model: 'gemini-3.1-pro-preview', ...overrides };
        f.hook(payload);
        await assert.rejects(f.target.fetch(endpoint, { method: 'POST', body: JSON.stringify(payload) }), { code: expectedCode });
        assert.equal(f.requests.length, 0);
        assert.equal(f.errors.length, 1);
        assert.doesNotMatch(f.errors[0], /CSRF/);
    }
});

test('a failed attempt does not poison a subsequent successful preparation', async () => {
    const f = setup(() => f.requests.length === 1
        ? new Response('Bad Gateway', { status: 502 })
        : Response.json({ ok: true, pluginId: 'vertex-paygo', protocolVersion: 3, transport: 'loopback-http',
            proxyUrl: `http://127.0.0.1:1234/proxy/${'a'.repeat(32)}`, ticket: 'a'.repeat(32), proxySecret: 's'.repeat(32) }));
    const init = { method: 'POST', body: JSON.stringify({ chat_completion_source: 'makersuite', model: 'gemini-2.5-pro' }) };
    await assert.rejects(f.target.fetch(endpoint, init), { code: 'HTTP_ERROR', status: 502 });
    assert.deepEqual(await (await f.target.fetch(endpoint, init)).json(), { generated: true });
    assert.deepEqual(f.requests.map(request => request.url), [
        '/api/plugins/vertex-paygo/prepare', '/api/plugins/vertex-paygo/prepare', endpoint,
    ]);
    const sent = JSON.parse(f.requests[2].init.body);
    assert.match(sent.reverse_proxy, /^http:\/\/127\.0\.0\.1:/);
    assert.equal(f.errors.length, 1);
});
