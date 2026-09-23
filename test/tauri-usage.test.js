/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTauriUsageClient } from '../src/tauri-usage.js';

function memoryStore() {
    const data = new Map();
    const path = ({ namespace, table, key }) => `${namespace}/${table}/${key}`;
    return {
        data,
        async setJson(options) { data.set(path(options), structuredClone(options.value)); },
        async tryGetJson(options) {
            const key = path(options);
            return data.has(key) ? { found: true, value: data.get(key) } : { found: false };
        },
        async listKeys({ namespace, table }) {
            const prefix = `${namespace}/${table}/`;
            return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
        },
    };
}

const metadata = (id, extra = {}) => ({
    id, chatId: 'chat-1', source: 'vertexai', model: 'gemini', tier: 'standard',
    paygoOnly: true, stream: true, price: { input: 1, cachedInput: .1, output: 2 },
    startedAt: '2026-09-22T00:00:00Z', ...extra,
});

test('oversized SSE event recovery handles a split delimiter and final unterminated usage event', async () => {
    const store = memoryStore(); const client = createTauriUsageClient({ store });
    const chunks = ['data: "' + 'x'.repeat(1024 * 1024) + '"\r', '\n', '\r', '\n',
        'data: {"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":5}}'];
    let index = 0;
    const body = new ReadableStream({ pull(controller) {
        if (index === chunks.length) controller.close();
        else controller.enqueue(new TextEncoder().encode(chunks[index++]));
    } });
    const response = client.observeResponse(new Response(body), metadata('oversized-split'));
    assert.equal(await response.text(), chunks.join(''));
    const { records } = await client.readUsage('chat-1');
    assert.equal(records[0].usage.candidatesTokenCount, 5);
    assert.equal(records[0].status, 'incomplete');
});

test('non-streaming raw Gemini usage and error responses preserve their semantics', async () => {
    const store = memoryStore(); const client = createTauriUsageClient({ store });
    const good = client.observeResponse(Response.json({ usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1,
        thoughtsTokenCount: 3, cachedContentTokenCount: 1 } }), metadata('raw', { stream: false }));
    await good.text();
    const bad = client.observeResponse(Response.json({ error: { message: 'private error' } }), metadata('error', { stream: false }));
    await bad.text();
    const { records } = await client.readUsage('chat-1');
    assert.equal(records.find(item => item.id === 'raw').usage.thoughtsTokenCount, 3);
    assert.equal(records.find(item => item.id === 'error').status, 'failed');
    assert.doesNotMatch(JSON.stringify(records), /private error/);
});

test('parses Gemini SSE across byte boundaries as cumulative snapshots and preserves response bytes', async () => {
    const store = memoryStore();
    const client = createTauriUsageClient({ store });
    const source = 'data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}\n\n'
        + 'data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"thoughtsTokenCount":3,"cachedContentTokenCount":4,"trafficType":"ON_DEMAND","promptTokensDetails":[{"modality":"TEXT","tokenCount":10}]}}\n\n';
    const bytes = new TextEncoder().encode(source);
    const body = new ReadableStream({ start(controller) {
        for (const end of [1, 7, 29, 71, bytes.length]) {
            const start = this.last ?? 0; controller.enqueue(bytes.slice(start, end)); this.last = end;
        }
        controller.close();
    } });
    const observed = client.observeResponse(new Response(body, { headers: { 'content-type': 'text/event-stream' } }), metadata('sse'));
    assert.equal(await observed.text(), source);
    await client.flush();
    const { records, truncated } = await client.readUsage('chat-1');
    assert.equal(truncated, false);
    assert.equal(records[0].usage.candidatesTokenCount, 5);
    assert.equal(records[0].usage.thoughtsTokenCount, 3);
    assert.equal(records[0].usage.trafficType, 'ON_DEMAND');
    assert.deepEqual(records[0].usage.promptTokensDetails, [{ modality: 'TEXT', tokenCount: 10 }]);
});

test('maps a non-stream normalized response without deriving thoughts from totals', async () => {
    const store = memoryStore();
    const client = createTauriUsageClient({ store });
    const response = new Response(JSON.stringify({ usage: {
        input_tokens: 12, output_tokens: 4, prompt_tokens_details: { cached_tokens: 3 }, total_tokens: 99,
        requestBody: 'secret prompt', apiKey: 'secret-key',
    } }), { headers: { 'content-type': 'application/json' } });
    const observed = client.observeResponse(response, metadata('json', { stream: false, requestBody: 'private request', apiKey: 'secret-key' }));
    await observed.arrayBuffer();
    await client.flush();
    const record = (await client.readUsage('chat-1')).records[0];
    assert.deepEqual(record.usage, { promptTokenCount: 12, cachedContentTokenCount: 3, candidatesTokenCount: 4 });
    assert.equal(record.usageAccuracy, 'tauri-normalized');
    assert.equal(record.usage.thoughtsTokenCount, undefined);
    assert.doesNotMatch(JSON.stringify([...store.data.values()]), /private request|secret-key/);
});

test('allowlists persisted usage and marks an SSE payload error failed', async () => {
    const store = memoryStore();
    const client = createTauriUsageClient({ store });
    const source = 'data: {"candidates":[{"content":{"parts":[{"text":"private answer"}]}}],"apiKey":"secret","usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1,"unknownSecret":"no"}}\n\n'
        + 'data: {"error":{"message":"upstream failed","secret":"no"}}\n\n';
    const observed = client.observeResponse(new Response(source, { headers: { 'content-type': 'text/event-stream' } }), metadata('private'));
    assert.equal(await observed.text(), source);
    await client.flush();
    const saved = (await client.readUsage('chat-1')).records[0];
    assert.equal(saved.status, 'failed');
    assert.equal(saved.errorCode, 'UPSTREAM_RESPONSE_ERROR');
    assert.deepEqual(saved.usage, { promptTokenCount: 2, candidatesTokenCount: 1 });
    assert.doesNotMatch(JSON.stringify([...store.data.values()]), /private answer|secret-key|unknownSecret|upstream failed/);
});

test('bounds capture memory while transparently forwarding oversized responses', async () => {
    const store = memoryStore();
    const client = createTauriUsageClient({ store });
    const source = JSON.stringify({ usage: { input_tokens: 1 }, padding: 'x'.repeat(1024 * 1024 + 1) });
    const observed = client.observeResponse(new Response(source), metadata('large', { stream: false }));
    assert.equal((await observed.text()).length, source.length);
    await client.flush();
    const saved = (await client.readUsage('chat-1')).records[0];
    assert.equal(saved.errorCode, 'USAGE_CAPTURE_LIMIT');
    assert.equal(saved.usage, null);
});

test('drops one oversized SSE event and still captures later usage metadata', async () => {
    const store = memoryStore();
    const client = createTauriUsageClient({ store });
    const source = `data: ${'x'.repeat(1024 * 1024 + 1)}\n\ndata: {"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2}}\n\n`;
    const observed = client.observeResponse(new Response(source, { headers: { 'content-type': 'text/event-stream' } }), metadata('large-sse'));
    assert.equal(await observed.text(), source);
    await client.flush();
    const saved = (await client.readUsage('chat-1')).records[0];
    assert.deepEqual(saved.usage, { promptTokenCount: 7, candidatesTokenCount: 2 });
    assert.equal(saved.errorCode, 'USAGE_CAPTURE_LIMIT');
});

test('marks cancellation, missing usage, HTTP errors and explicit failures distinctly', async () => {
    const store = memoryStore();
    const client = createTauriUsageClient({ store });
    let cancelled = false;
    const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } }));
    const observed = client.observeResponse(response, metadata('cancel'));
    const reader = observed.body.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(cancelled, true);
    client.observeResponse(new Response('', { status: 429 }), metadata('http'));
    client.recordFailure(metadata('failure'), Object.assign(new Error('offline'), { code: 'NETWORK_OFFLINE' }));
    const missing = client.observeResponse(new Response('{}'), metadata('missing', { stream: false }));
    await missing.text();
    await client.flush();
    const byId = Object.fromEntries((await client.readUsage('chat-1')).records.map(record => [record.id, record]));
    assert.equal(byId.cancel.errorCode, 'CLIENT_DISCONNECTED');
    assert.equal(byId.http.errorCode, 'UPSTREAM_HTTP_429');
    assert.equal(byId.failure.errorCode, 'NETWORK_OFFLINE');
    assert.equal(byId.missing.errorCode, 'USAGE_METADATA_MISSING');
});

test('an abort signal rejects response consumption and records the abort', async () => {
    const store = memoryStore();
    const client = createTauriUsageClient({ store });
    const abortController = new AbortController();
    let pulls = 0;
    const upstream = new Response(new ReadableStream({
        pull(controller) { if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('data: {}\n\n')); },
    }));
    Object.defineProperty(upstream, 'url', { value: 'https://example.invalid/model' });
    const observed = client.observeResponse(upstream, metadata('aborted'), { signal: abortController.signal });
    assert.equal(observed.url, upstream.url);
    const reader = observed.body.getReader();
    await reader.read();
    abortController.abort(new DOMException('stop', 'AbortError'));
    await assert.rejects(reader.read(), error => error?.name === 'AbortError');
    await client.flush();
    const saved = (await client.readUsage('chat-1')).records[0];
    assert.equal(saved.errorCode, 'CLIENT_ABORTED');
});

test('serializes concurrent writes by chat and exposes storage failures after warning', async () => {
    const store = memoryStore();
    const client = createTauriUsageClient({ store });
    client.recordFailure(metadata('a'), new Error('a'));
    client.recordFailure(metadata('b', { chatId: 'chat-2' }), new Error('b'));
    client.recordFailure(metadata('c'), new Error('c'));
    await client.flush();
    assert.deepEqual((await client.readUsage('chat-1')).records.map(record => record.id), ['a', 'c']);
    assert.deepEqual((await client.readUsage('chat-2')).records.map(record => record.id), ['b']);

    const warnings = [];
    const bad = createTauriUsageClient({
        store: { async listKeys() { return []; }, async tryGetJson() {}, async setJson() { throw new Error('disk full'); } },
        notifyWarning: (message, error) => warnings.push([message, error.message]),
    });
    const upstream = bad.observeResponse(new Response('{}'), metadata('bad', { stream: false }));
    assert.equal(await upstream.text(), '{}');
    await assert.rejects(bad.flush(), /disk full/);
    assert.match(warnings[0][0], /could not be added/);
    assert.equal(warnings[0][1], 'disk full');
});
