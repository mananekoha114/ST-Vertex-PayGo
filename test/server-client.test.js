/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createServerClient, parseLoopbackProxyUrl, ServerPluginError } from '../src/server-client.js';
import { MAX_LOG_RESPONSE_BYTES, PREPARE_TIMEOUT_MS } from '../src/constants.js';

function jsonResponse(data, { ok = true, status = 200 } = {}) {
    return { ok, status, json: async () => data };
}

function textResponse(data, {
    ok = true,
    status = 200,
    contentType = 'text/plain; charset=utf-8',
    contentLength,
} = {}) {
    const headers = new Map([['content-type', contentType]]);
    if (contentLength !== undefined) headers.set('content-length', String(contentLength));
    return {
        ok,
        status,
        headers: { get: name => headers.get(String(name).toLowerCase()) ?? null },
        text: async () => data,
    };
}

test('allows 30 seconds for service-account preparation', () => {
    assert.equal(PREPARE_TIMEOUT_MS, 30_000);
});

test('usage is read by conversation using authenticated no-store GET', async () => {
    let request;
    const client = createServerClient({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture' }),
        fetchImpl: async (url, options) => {
            request = { url, options };
            return jsonResponse({ ok: true, records: [{ id: 'request-1', chatId: 'conversation-1' }] });
        } });
    assert.equal((await client.readUsage('conversation-1')).records.length, 1);
    assert.equal(request.url, '/api/plugins/vertex-paygo/usage?chatId=conversation-1');
    assert.equal(request.options.headers['X-CSRF-Token'], 'fixture');
    assert.equal(request.options.cache, 'no-store');
    await assert.rejects(client.readUsage('../other-user'), TypeError);
    const invalid = createServerClient({ fetchImpl: async () => jsonResponse({ ok: true }) });
    await assert.rejects(invalid.readUsage('conversation-1'), error => error.code === 'INVALID_USAGE_RESPONSE');
});

test('usage reader follows pages without silently dropping older charges or looping', async () => {
    const urls = [];
    const client = createServerClient({ fetchImpl: async url => {
        urls.push(url);
        return jsonResponse(url.includes('cursor=')
            ? { ok: true, records: [{ id: 'second' }], nextCursor: null }
            : { ok: true, records: [{ id: 'first' }], nextCursor: '1:2', truncated: true });
    } });
    const result = await client.readUsage('conversation-1');
    assert.deepEqual(result.records.map(record => record.id), ['first', 'second']);
    assert.equal(result.truncated, false);
    assert.match(urls[1], /cursor=1%3A2$/);
    const loop = createServerClient({ fetchImpl: async () => jsonResponse({ ok: true, records: [], nextCursor: 'same' }) });
    await assert.rejects(loop.readUsage('conversation-1'), error => error.code === 'INVALID_USAGE_RESPONSE');
});

test('health handshake requires protocol v2 and loopback transport', async () => {
    let request;
    const client = createServerClient({
        fetchImpl: async (url, options) => {
            request = { url, options };
            return jsonResponse({ ok: true, pluginId: 'vertex-paygo', protocolVersion: 2, transport: 'loopback-http', pluginVersion: '0.2.0' });
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
        fetchImpl: async () => jsonResponse({ ok: true, pluginId: 'vertex-paygo', protocolVersion: 99, transport: 'loopback-http' }),
    });
    await assert.rejects(() => protocolClient.checkHealth(), error => error instanceof ServerPluginError && error.code === 'PROTOCOL_MISMATCH');

    const transportClient = createServerClient({
        fetchImpl: async () => jsonResponse({ ok: true, pluginId: 'vertex-paygo', protocolVersion: 2, transport: 'same-origin' }),
    });
    await assert.rejects(() => transportClient.checkHealth(), error => error.code === 'TRANSPORT_MISMATCH');
});

test('prepare validates and returns only an absolute 127.0.0.1 HTTP proxy', async () => {
    const client = createServerClient({
        fetchImpl: async () => jsonResponse({
            ok: true,
            pluginId: 'vertex-paygo',
            protocolVersion: 2,
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
            protocolVersion: 2,
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

test('reads the bounded plain-text combined log with authenticated no-store request', async () => {
    let request;
    const client = createServerClient({
        fetchImpl: async (url, options) => {
            request = { url, options };
            return textResponse('{"source":"server"}\n{"source":"client","event":"猫"}\n');
        },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
    });

    const logs = await client.readLogs();
    assert.match(logs, /"source":"client"/u);
    assert.match(logs, /猫/u);
    assert.equal(request.url, '/api/plugins/vertex-paygo/logs');
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.cache, 'no-store');
    assert.equal(request.options.headers.Accept, 'text/plain');
    assert.equal(request.options.headers['X-CSRF-Token'], 'test');
});

test('writes one structured client event without requiring a response body', async () => {
    let request;
    const entry = {
        level: 'info',
        event: 'extension.init_ready',
        context: { clientVersion: '0.3.0', clientSessionId: 'session-1' },
    };
    const client = createServerClient({
        fetchImpl: async (url, options) => {
            request = { url, options };
            return { ok: true, status: 204 };
        },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
    });

    await client.writeClientLog(entry);
    assert.equal(request.url, '/api/plugins/vertex-paygo/logs/client');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.cache, 'no-store');
    assert.equal(request.options.headers['Content-Type'], 'application/vnd.st-vertex-paygo.client-log+json');
    assert.equal(request.options.headers['X-CSRF-Token'], 'test');
    assert.deepEqual(JSON.parse(request.options.body), entry);
});

test('log reader rejects an oversized declared body and non-text success response', async () => {
    const oversized = createServerClient({
        fetchImpl: async () => textResponse('', { contentLength: MAX_LOG_RESPONSE_BYTES + 1 }),
    });
    await assert.rejects(() => oversized.readLogs(), error => error.code === 'LOG_TOO_LARGE');

    const wrongType = createServerClient({
        fetchImpl: async () => textResponse('{}', { contentType: 'application/json' }),
    });
    await assert.rejects(() => wrongType.readLogs(), error => error.code === 'INVALID_LOG_RESPONSE');
});

test('log reader enforces the byte limit for text fallback including UTF-8 input', async () => {
    const exactAscii = 'a'.repeat(MAX_LOG_RESPONSE_BYTES);
    const exactClient = createServerClient({ fetchImpl: async () => textResponse(exactAscii) });
    assert.equal((await exactClient.readLogs()).length, MAX_LOG_RESPONSE_BYTES);

    const unicodeAtLimit = '猫'.repeat(Math.floor(MAX_LOG_RESPONSE_BYTES / 3));
    const unicodeClient = createServerClient({ fetchImpl: async () => textResponse(unicodeAtLimit) });
    assert.equal(await unicodeClient.readLogs(), unicodeAtLimit);

    const unicodeOverLimit = `${unicodeAtLimit}猫`;
    const oversizedUnicodeClient = createServerClient({ fetchImpl: async () => textResponse(unicodeOverLimit) });
    await assert.rejects(() => oversizedUnicodeClient.readLogs(), error => error.code === 'LOG_TOO_LARGE');
});

test('plain-text log HTTP errors preserve a safe JSON message', async () => {
    const client = createServerClient({
        fetchImpl: async () => textResponse(JSON.stringify({ message: 'Administrator access is required.' }), {
            ok: false,
            status: 403,
            contentType: 'application/json',
        }),
    });
    await assert.rejects(
        () => client.readLogs(),
        error => error.code === 'HTTP_ERROR' && error.status === 403 && error.message === 'Administrator access is required.',
    );
});
