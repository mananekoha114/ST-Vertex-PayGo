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
import { MAX_LOG_RESPONSE_BYTES, MAX_BRIDGE_LOG_RESPONSE_BYTES, PREPARE_TIMEOUT_MS, SERVER_ROUTES } from '../src/constants.js';

function jsonResponse(data, { ok = true, status = 200 } = {}) {
    return { ok, status, json: async () => data };
}

test('data backup operations use fresh authentication and validate the response contract', async () => {
    const requests = [];
    const report = { ok: true, entries: [{ id: 'snapshot', createdAt: '2026-10-17T00:00:00Z', restorable: true,
        reason: 'startup', files: ['usage-ledger.jsonl'] }], pending: null, nextCursor: null };
    const client = createServerClient({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture' }), fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return jsonResponse(url.includes('data-backups') ? report : url.endsWith('/cancel') ? { ok: true } : { ok: true, restartRequired: true });
    } });
    assert.equal((await client.listDataBackups('previous+id')).entries.length, 1);
    await client.scheduleDataRestore('snapshot'); await client.cancelDataRestore();
    assert.match(requests[0].url, /cursor=previous%2Bid/u);
    assert.deepEqual(JSON.parse(requests[1].options.body), { backupId: 'snapshot' });
    for (const request of requests) {
        assert.equal(request.options.headers['X-CSRF-Token'], 'fixture'); assert.equal(request.options.cache, 'no-store');
    }
    const invalid = createServerClient({ fetchImpl: async () => jsonResponse({ ok: true }) });
    for (const action of [() => invalid.listDataBackups(), () => invalid.scheduleDataRestore('snapshot')]) {
        await assert.rejects(action, { code: 'INVALID_BACKUP_RESPONSE' });
    }
});

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

test('bridge log reader allows the larger store but bounds declared and streamed response bytes', async () => {
    const content = 'x'.repeat(MAX_LOG_RESPONSE_BYTES + 1);
    const valid = createServerClient({ fetchImpl: async () => new Response(JSON.stringify({ ok: true, entries: [{ responseBody: content }] }), {
        headers: { 'Content-Type': 'application/json' },
    }) });
    assert.equal((await valid.readOpenAiBridgeLogs()).entries[0].responseBody, content);

    let aborted = false;
    const declared = createServerClient({ fetchImpl: async (_url, { signal }) => {
        signal.addEventListener('abort', () => { aborted = true; });
        return { ok: true, status: 200, headers: new Map([['content-length', String(MAX_BRIDGE_LOG_RESPONSE_BYTES + 1)]]),
            text() { assert.fail('Oversized body must not be read'); } };
    } });
    await assert.rejects(declared.readOpenAiBridgeLogs(), error => error.code === 'LOG_TOO_LARGE');
    assert.equal(aborted, true);

    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const streamed = createServerClient({ fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(chunk); },
        cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'application/json' } }) });
    await assert.rejects(streamed.readOpenAiBridgeLogs(), error => error.code === 'LOG_TOO_LARGE');
    assert.equal(cancelled, true);
});

test('an interrupted response body is reported as a timeout rather than invalid JSON', async () => {
    const client = createServerClient({ fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.error(new DOMException('The operation was aborted', 'AbortError')); },
    }), { headers: { 'Content-Type': 'application/json' } }) });
    await assert.rejects(client.readOpenAiBridge(), error => error.code === 'TIMEOUT');
    await assert.rejects(client.readOpenAiBridgeLogs(), error => error.code === 'TIMEOUT');
});

test('update check, start, and status use authenticated no-store requests', async () => {
    const requests = [];
    const client = createServerClient({
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture' }),
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            if (options.method === 'POST') return jsonResponse({ ok: true, started: true }, { status: 202 });
            if (url === SERVER_ROUTES.UPDATE_STATUS) {
                return jsonResponse({ ok: true, running: false, lastResult: { status: 'updated', restartRequired: true } });
            }
            return jsonResponse({ ok: true, status: 'update-available', components: [{ name: 'frontend', status: 'update' }] });
        },
    });

    const report = await client.checkUpdate();
    assert.equal(report.status, 'update-available');
    assert.equal(report.components.length, 1);
    assert.equal(requests[0].url, SERVER_ROUTES.UPDATE);
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[0].options.cache, 'no-store');
    assert.equal(requests[0].options.headers['X-CSRF-Token'], 'fixture');

    await client.startUpdate();
    assert.equal(requests[1].options.method, 'POST');
    assert.equal(requests[1].options.headers['X-CSRF-Token'], 'fixture');

    const status = await client.readUpdateStatus();
    assert.equal(status.lastResult.status, 'updated');
    assert.equal(requests[2].url, SERVER_ROUTES.UPDATE_STATUS);
});

test('update responses are validated before they are trusted', async () => {
    const client = createServerClient({ fetchImpl: async () => jsonResponse({ ok: true }) });
    await assert.rejects(client.checkUpdate(), error => error.code === 'INVALID_UPDATE_RESPONSE');
    await assert.rejects(client.startUpdate(), error => error.code === 'INVALID_UPDATE_RESPONSE');
    await assert.rejects(client.readUpdateStatus(), error => error.code === 'INVALID_UPDATE_RESPONSE');

    const conflict = createServerClient({
        fetchImpl: async () => jsonResponse({ error: true, code: 'UPDATER_IN_PROGRESS', message: 'An update is already running.' }, { ok: false, status: 409 }),
    });
    await assert.rejects(conflict.startUpdate(), error => error.code === 'HTTP_ERROR' && error.status === 409 && error.serverCode === 'UPDATER_IN_PROGRESS');
    const unknown = createServerClient({
        fetchImpl: async () => jsonResponse({ ok: true, status: 'unexpected-status', components: [] }),
    });
    await assert.rejects(unknown.checkUpdate(), error => error.code === 'INVALID_UPDATE_RESPONSE');
});

test('prepare preserves server error code and HTTP status', async () => {
    const client = createServerClient({ fetchImpl: async () => new Response(JSON.stringify({
        code: 'GOOGLE_CREDENTIALS_INVALID', message: 'Credential parsing failed.',
    }), { status: 422 }) });
    await assert.rejects(client.prepare({}), error => error.code === 'HTTP_ERROR'
        && error.serverCode === 'GOOGLE_CREDENTIALS_INVALID' && error.status === 422
        && error.message === 'Credential parsing failed.');
});

test('only explicit CSRF rejection is diagnosed as CSRF; other HTML errors retain HTTP status', async () => {
    const csrf = createServerClient({ fetchImpl: async () => new Response(
        '<html><pre>Invalid CSRF token. Please refresh the page and try again.</pre></html>', { status: 403 }) });
    await assert.rejects(csrf.prepare({}), error => error.code === 'CSRF_REJECTED'
        && error.status === 403 && /HTTP 403/u.test(error.message) && !error.message.includes('<html>'));
    for (const status of [403, 404, 502]) {
        const client = createServerClient({ fetchImpl: async () => new Response('<html>Private proxy diagnostics</html>', { status }) });
        await assert.rejects(client.prepare({}), error => error.code === 'HTTP_ERROR'
            && error.status === status && error.message.includes(String(status))
            && !error.message.includes('Private proxy diagnostics'));
    }
});

test('error page inspection cancels the body after a bounded prefix', async () => {
    let cancelled = false;
    let reads = 0;
    const client = createServerClient({ fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) { reads++; controller.enqueue(new Uint8Array(4096).fill(32)); },
        cancel() { cancelled = true; },
    }), { status: 502 }) });
    await assert.rejects(client.prepare({}), error => error.code === 'HTTP_ERROR' && error.status === 502);
    assert.equal(cancelled, true);
    assert.ok(reads <= 5);
});

test('prepare reads fresh authentication headers for every request', async () => {
    const tokens = [];
    let token = 'old';
    const client = createServerClient({ getRequestHeaders: () => ({ 'X-CSRF-Token': token }),
        fetchImpl: async (_url, options) => {
            tokens.push(options.headers['X-CSRF-Token']);
            return jsonResponse({ message: 'Blocked.' }, { ok: false, status: 400 });
        } });
    await assert.rejects(client.prepare({}));
    token = 'new';
    await assert.rejects(client.prepare({}));
    assert.deepEqual(tokens, ['old', 'new']);
});

test('an interrupted HTTP error body still reports timeout', async () => {
    const client = createServerClient({ fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.error(new DOMException('Aborted', 'AbortError')); },
    }), { status: 403 }) });
    await assert.rejects(client.prepare({}), error => error.code === 'TIMEOUT');
});
