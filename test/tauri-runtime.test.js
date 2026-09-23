import test from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'yaml';
import { initTauriTavern, assertTauriCapabilities } from '../src/tauri-runtime.js';
import { currentTauriRequest } from '../src/tauri-ui.js';
import { createMessageCosts, getMessageCost } from '../src/message-costs.js';
import { nativeContext, nativeDocument, nativeStore } from './helpers/native-dom.js';

test('native bootstrap, UI, fetch, streaming ledger and teardown work together without a Node plugin', async () => {
    const context = nativeContext(); const documentRef = nativeDocument(); const store = nativeStore();
    const requests = []; const notices = []; const originalFetch = async (url, options) => {
        requests.push({ url, data: JSON.parse(options.body) });
        assert.equal(url, '/api/backends/chat-completions/generate');
        return new Response('data: {"candidates":[{"content":{"parts":[{"text":"private answer"}]}}]}\n\n'
            + 'data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"thoughtsTokenCount":2,"cachedContentTokenCount":4}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    };
    const target = { document: documentRef, fetch: originalFetch, location: { origin: 'http://tauri.localhost' },
        __TAURITAVERN__: { ready: Promise.resolve(), api: { extension: { store }, llmConnections: { save: async () => {} } } },
        setInterval: () => 7, clearInterval(id) { assert.equal(id, 7); } };
    const runtime = await initTauriTavern({ target, getContext: () => context, loadLibrary: async () => ({ yaml }),
        notifyError: message => notices.push(message), factories: { refreshPolicy: async () => ({ changed: false }) } });
    const tier = documentRef.getElementById('vertex-paygo-tier'); tier.value = 'flex'; await tier.fire('change');
    const data = { ...currentTauriRequest(context), stream: true, messages: [{ content: 'private prompt' }] };
    await context.eventSource.emit('request', data);
    const response = await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(data) });
    assert.match(await response.text(), /private answer/);
    await runtime.usageClient.flush();
    const records = [...store.files.values()];
    assert.equal(records.length, 1);
    assert.equal(records[0].tier, 'flex');
    assert.equal(records[0].usage.thoughtsTokenCount, 2);
    assert.equal(records[0].usage.cachedContentTokenCount, 4);
    assert.doesNotMatch(JSON.stringify(records), /private prompt|private answer/);
    assert.equal(yaml.parse(requests[0].data.custom_include_headers)['X-Vertex-AI-LLM-Shared-Request-Type'], 'flex');
    assert.equal(requests[0].data.reverse_proxy, undefined);
    assert.equal(Object.keys(requests[0].data).some(key => key.startsWith('__vertex')), false);
    assert.deepEqual(notices, []);
    runtime.destroy(); assert.equal(target.fetch, originalFetch);
    assert.equal(documentRef.getElementById('vertex-paygo-settings'), null);
});

test('native non-streaming usage stays consumable and is explicitly marked approximate', async () => {
    const context = nativeContext(); const documentRef = nativeDocument(); const store = nativeStore();
    const original = { choices: [{ message: { content: 'answer' } }], usage: { prompt_tokens: 100, completion_tokens: 20,
        total_tokens: 150, prompt_tokens_details: { cached_tokens: 30 } } };
    const target = { document: documentRef, location: { origin: 'http://tauri.localhost' }, fetch: async () => Response.json(original),
        __TAURITAVERN__: { api: { extension: { store }, llmConnections: { save: async () => {} } } },
        setInterval: () => 1, clearInterval() {} };
    const runtime = await initTauriTavern({ target, getContext: () => context, loadLibrary: async () => ({ yaml }),
        factories: { refreshPolicy: async () => ({ changed: false }) } });
    const data = { ...currentTauriRequest(context), stream: false };
    const response = await target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(data) });
    assert.deepEqual(await response.json(), original);
    await runtime.usageClient.flush();
    const [record] = [...store.files.values()];
    assert.equal(record.usageAccuracy, 'tauri-normalized');
    assert.equal(record.usage.cachedContentTokenCount, 30);
    assert.equal(record.usage.thoughtsTokenCount, undefined);
    runtime.destroy();
});

test('native runtime binds a foreground reply to normalized usage and restores its message snapshot', async () => {
    const context = nativeContext(); const documentRef = nativeDocument(); const store = nativeStore();
    context.chat = [{ is_user: true, mes: 'prompt' }];
    Object.assign(context.eventTypes, {
        GENERATION_AFTER_COMMANDS: 'generation', MESSAGE_RECEIVED: 'message',
    });
    const original = { choices: [{ message: { content: 'answer' } }], usage: {
        input_tokens: 12, output_tokens: 4, prompt_tokens_details: { cached_tokens: 3 },
    } };
    const target = { document: documentRef, location: { origin: 'http://tauri.localhost' },
        fetch: async () => Response.json(original),
        __TAURITAVERN__: { api: { extension: { store }, llmConnections: { save: async () => {} } } },
        setInterval: () => 1, clearInterval() {} };
    let tracker; let destroyed = false;
    const runtime = await initTauriTavern({ target, getContext: () => context, loadLibrary: async () => ({ yaml }),
        factories: { refreshPolicy: async () => ({ changed: false }),
            messageCosts(options) {
                const actual = createMessageCosts(options);
                tracker = { ...actual, destroy() { destroyed = true; actual.destroy(); } };
                return tracker;
            },
        } });
    try {
        await context.eventSource.emit('generation', 'normal', {}, false);
        const data = { ...currentTauriRequest(context), model: 'gemini-2.0-flash', stream: false, type: 'normal' };
        await context.eventSource.emit('request', data);
        const response = await target.fetch('/api/backends/chat-completions/generate', {
            method: 'POST', body: JSON.stringify(data),
        });
        assert.deepEqual(await response.json(), original);
        const reply = { is_user: false, mes: 'answer', extra: {}, swipe_id: 0 };
        context.chat.push(reply);
        await context.eventSource.emit('message', 1, 'normal');
        await runtime.usageClient.flush();
        await tracker.refresh();
        const [record] = [...store.files.values()];
        const snapshot = getMessageCost(reply);
        assert.equal(snapshot.requests.length, 1);
        assert.equal(snapshot.requests[0].id, record.id);
        assert.equal(snapshot.requests[0].record.usageAccuracy, 'tauri-normalized');
        assert.deepEqual(snapshot.requests[0].record.usage, {
            promptTokenCount: 12, cachedContentTokenCount: 3, candidatesTokenCount: 4,
        });
        assert.equal(snapshot.requests[0].timing.interrupted, false);
    } finally {
        runtime.destroy();
    }
    assert.equal(destroyed, true);
});

test('missing native capabilities fail before loading libraries or installing hooks', async () => {
    const context = nativeContext();
    assert.throws(() => assertTauriCapabilities(context, { api: {} }), { code: 'TAURI_CAPABILITIES_UNAVAILABLE' });
    await assert.rejects(initTauriTavern({ target: { __TAURITAVERN__: {} }, getContext: () => context,
        loadLibrary: () => assert.fail('must not load unsupported host libraries') }), { code: 'TAURI_CAPABILITIES_UNAVAILABLE' });
});

test('capability gate accepts optional reads without requiring a second storage read API', () => {
    const context = nativeContext();
    const store = { setJson() {}, tryGetJson() {}, listKeys() {} };
    assert.equal(assertTauriCapabilities(context, { api: { extension: { store }, llmConnections: { save() {} } } }), store);
});
