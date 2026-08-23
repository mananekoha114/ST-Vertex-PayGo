import test from 'node:test';
import assert from 'node:assert/strict';

import { createServerClient, parseLoopbackProxyUrl, ServerPluginError } from '../src/server-client.js';
import { PREPARE_TIMEOUT_MS } from '../src/constants.js';

function jsonResponse(data, { ok = true, status = 200 } = {}) {
    return { ok, status, json: async () => data };
}

test('allows 30 seconds for service-account preparation', () => {
    assert.equal(PREPARE_TIMEOUT_MS, 30_000);
});

test('health handshake requires protocol v1 and loopback transport', async () => {
    let request;
    const client = createServerClient({
        fetchImpl: async (url, options) => {
            request = { url, options };
            return jsonResponse({ ok: true, pluginId: 'vertex-paygo', protocolVersion: 1, transport: 'loopback-http', pluginVersion: '0.2.0' });
        },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
    });
    const health = await client.checkHealth();
    assert.equal(health.pluginVersion, '0.2.0');
    assert.equal(request.url, '/api/plugins/vertex-paygo/health');
    assert.equal(request.options.headers['X-CSRF-Token'], 'test');
});

test('rejects protocol and transport mismatches', async () => {
    const protocolClient = createServerClient({
        fetchImpl: async () => jsonResponse({ ok: true, pluginId: 'vertex-paygo', protocolVersion: 2, transport: 'loopback-http' }),
    });
    await assert.rejects(() => protocolClient.checkHealth(), error => error instanceof ServerPluginError && error.code === 'PROTOCOL_MISMATCH');

    const transportClient = createServerClient({
        fetchImpl: async () => jsonResponse({ ok: true, pluginId: 'vertex-paygo', protocolVersion: 1, transport: 'same-origin' }),
    });
    await assert.rejects(() => transportClient.checkHealth(), error => error.code === 'TRANSPORT_MISMATCH');
});

test('prepare validates and returns only an absolute 127.0.0.1 HTTP proxy', async () => {
    const client = createServerClient({
        fetchImpl: async () => jsonResponse({
            ok: true,
            pluginId: 'vertex-paygo',
            protocolVersion: 1,
            transport: 'loopback-http',
            proxyUrl: `http://127.0.0.1:32145/proxy/${'a'.repeat(32)}`,
            ticket: 'a'.repeat(32),
            proxySecret: 'a'.repeat(32),
        }),
    });
    const prepared = await client.prepare({ model: 'gemini-3.1-pro-preview' });
    assert.equal(prepared.proxyUrl, `http://127.0.0.1:32145/proxy/${'a'.repeat(32)}`);
    assert.equal(prepared.proxySecret.length, 32);
});

test('loopback URL validation rejects non-loopback, localhost aliases, HTTPS and missing ports', () => {
    const ticket = 'a'.repeat(32);
    assert.throws(() => parseLoopbackProxyUrl(`https://127.0.0.1:1234/proxy/${ticket}`), /loopback HTTP/);
    assert.throws(() => parseLoopbackProxyUrl(`http://localhost:1234/proxy/${ticket}`), /loopback HTTP/);
    assert.throws(() => parseLoopbackProxyUrl(`http://127.0.0.1/proxy/${ticket}`), /loopback HTTP/);
    assert.throws(() => parseLoopbackProxyUrl(`http://example.com:1234/proxy/${ticket}`), /loopback HTTP/);
    assert.throws(() => parseLoopbackProxyUrl(`http://127.0.0.1:1234/other/${ticket}`), /loopback HTTP/);
    assert.throws(() => parseLoopbackProxyUrl(`http://127.0.0.1:1234/proxy/${ticket}?target=other`), /loopback HTTP/);
});

test('prepare rejects a ticket that does not match the proxy URL', async () => {
    const client = createServerClient({
        fetchImpl: async () => jsonResponse({
            ok: true,
            pluginId: 'vertex-paygo',
            protocolVersion: 1,
            transport: 'loopback-http',
            proxyUrl: `http://127.0.0.1:32145/proxy/${'a'.repeat(32)}`,
            ticket: 'b'.repeat(32),
            proxySecret: 's'.repeat(32),
        }),
    });
    await assert.rejects(() => client.prepare({}), error => error.code === 'INVALID_PROXY_TICKET');
});

test('HTTP errors preserve the safe server message', async () => {
    const client = createServerClient({
        fetchImpl: async () => jsonResponse({ message: 'Invalid tier.' }, { ok: false, status: 400 }),
    });
    await assert.rejects(() => client.prepare({}), error => error.code === 'HTTP_ERROR' && error.message === 'Invalid tier.');
});
