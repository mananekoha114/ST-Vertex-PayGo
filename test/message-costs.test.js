import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageCosts, getMessageCost, MESSAGE_COST_KEY } from '../src/message-costs.js';

class EventBus {
    #listeners = new Map();
    on(name, callback) { this.#listeners.set(name, [...(this.#listeners.get(name) ?? []), callback]); }
    removeListener(name, callback) {
        this.#listeners.set(name, (this.#listeners.get(name) ?? []).filter(value => value !== callback));
    }
    async emit(name, ...args) {
        for (const callback of [...(this.#listeners.get(name) ?? [])]) await callback(...args);
    }
}

const eventNames = [
    'GENERATION_AFTER_COMMANDS', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED',
    'STREAM_TOKEN_RECEIVED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'MESSAGE_SWIPED',
    'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED', 'CHAT_CHANGED',
];

function assistant(text = 'answer') {
    return { is_user: false, is_system: false, mes: text, extra: {}, swipe_id: 0,
        swipes: [text], swipe_info: [{ extra: {} }] };
}

function fixture({ chat = [], chatId = 'chat-a', readUsage = async () => ({ ok: true, records: [] }) } = {}) {
    const bus = new EventBus();
    const eventTypes = Object.fromEntries(eventNames.map(name => [name, name]));
    let current = { chat, eventSource: bus, eventTypes, streamingProcessor: null, saveChat: async () => {} };
    let currentChatId = chatId;
    let clock = 100;
    let sequence = 0;
    let changes = 0;
    const tracker = createMessageCosts({
        getContext: () => current,
        getChatId: () => currentChatId,
        serverClient: { readUsage },
        documentRef: null,
        now: () => clock,
        idFactory: () => `id-${++sequence}`,
        onChange: () => changes++,
        retryMs: 60_000,
        maxRetries: 2,
    });
    return {
        bus, tracker,
        context: () => current,
        setContext(value, id) { current = value; currentChatId = id; },
        setNow(value) { clock = value; },
        changes: () => changes,
        destroy() { tracker.destroy(); },
    };
}

async function begin(f, type = 'normal', dryRun = false) {
    await f.bus.emit('GENERATION_AFTER_COMMANDS', type, {}, dryRun);
}

test('reloading during preparation marks an unsent placeholder unavailable instead of pending forever', async t => {
    const message = assistant();
    message.extra[MESSAGE_COST_KEY] = { version: 1, requests: [{ id: 'pending-browser-crashed', chatId: 'chat-a', status: 'pending' }] };
    let reads = 0;
    const f = fixture({ chat: [message], readUsage: async () => { reads++; return { ok: true, records: [] }; } });
    t.after(() => f.destroy());
    await f.tracker.refresh();
    assert.equal(getMessageCost(message).requests[0].status, 'unavailable');
    assert.equal(reads, 0);
});

function prepare(f, data = { type: 'normal', stream: false }, usageId = 'usage-1') {
    const token = f.tracker.capture(data, 'chat-a');
    if (token) f.tracker.prepared(token, usageId, { model: 'gemini', source: 'makersuite', tier: 'standard' });
    return token;
}

test('non-streaming response stays pending until its fixed new-message target is received', async t => {
    const f = fixture({ chat: [{ is_user: true, mes: 'prompt', extra: {} }] });
    t.after(() => f.destroy());
    await begin(f);
    const token = prepare(f);
    f.tracker.started(token);
    f.setNow(145);
    const response = f.tracker.response(token, new Response('complete'), null);
    assert.equal(await response.text(), 'complete');
    await f.bus.emit('GENERATION_ENDED');
    assert.equal(getMessageCost(f.context().chat[0]), null);

    const result = assistant();
    f.context().chat.push(result);
    await f.bus.emit('MESSAGE_RECEIVED', 1, 'normal');
    const snapshot = getMessageCost(result);
    assert.equal(snapshot.requests[0].id, 'usage-1');
    assert.deepEqual(snapshot.requests[0].timing, {
        stream: false, durationMs: 45, firstTokenMs: null, interrupted: false,
    });
});

test('streaming binds only after the captured processor owns the fixed message id', async t => {
    const f = fixture({ chat: [{ is_user: true, mes: 'prompt' }] });
    t.after(() => f.destroy());
    const processor = { messageId: -1 };
    f.context().streamingProcessor = processor;
    await begin(f);
    const token = prepare(f, { type: 'normal', stream: true }, 'usage-stream');
    const generated = assistant('...');
    f.context().chat.push(generated);
    await f.bus.emit('STREAM_TOKEN_RECEIVED');
    assert.equal(getMessageCost(generated), null);
    processor.messageId = 1;
    await f.bus.emit('STREAM_TOKEN_RECEIVED');
    assert.equal(getMessageCost(generated).requests[0].id, 'usage-stream');

    f.tracker.started(token);
    const body = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n';
    f.setNow(120);
    const response = f.tracker.response(token, new Response(body), null);
    await response.text();
    assert.equal(getMessageCost(generated).requests[0].timing.firstTokenMs, 20);
});

test('quiet, impersonate, and dry-run generations cannot create message bindings', async t => {
    const f = fixture({ chat: [assistant()] });
    t.after(() => f.destroy());
    await begin(f, 'normal', true);
    assert.equal(f.tracker.capture({ type: 'normal' }, 'chat-a'), null);
    await begin(f, 'quiet');
    assert.equal(f.tracker.capture({ type: 'quiet' }, 'chat-a'), null);
    await begin(f, 'impersonate');
    assert.equal(f.tracker.capture({ type: 'impersonate' }, 'chat-a'), null);
    assert.equal(getMessageCost(f.context().chat[0]), null);
});

test('chat changes invalidate pending targets and late ledger results cannot mutate the new chat', async t => {
    let resolveRead;
    const read = new Promise(resolve => { resolveRead = resolve; });
    const oldMessage = assistant();
    const f = fixture({ chat: [oldMessage], readUsage: () => read });
    t.after(() => f.destroy());
    await begin(f, 'continue');
    const token = prepare(f, { type: 'continue', stream: false }, 'usage-old');
    const pendingRefresh = f.tracker.refresh();

    const newMessage = assistant('new chat');
    const newContext = { ...f.context(), chat: [newMessage] };
    f.setContext(newContext, 'chat-b');
    await f.bus.emit('CHAT_CHANGED');
    resolveRead({ ok: true, records: [{ id: 'usage-old', chatId: 'chat-a', status: 'complete', usage: {} }] });
    await pendingRefresh;
    f.tracker.failed(token);
    assert.equal(getMessageCost(newMessage), null);
    assert.equal(getMessageCost(oldMessage).requests[0].record.status, 'pending');
});

test('each swipe is independent while continuation appends to the active swipe snapshot', async t => {
    const message = assistant('first');
    const f = fixture({ chat: [message] });
    t.after(() => f.destroy());

    message.swipe_id = 1;
    message.swipes.push('second');
    message.swipe_info.push({ extra: {} });
    await begin(f, 'swipe');
    prepare(f, { type: 'swipe', stream: false }, 'usage-swipe');
    assert.deepEqual(getMessageCost(message).requests.map(x => x.id), ['usage-swipe']);
    assert.deepEqual(message.swipe_info[1].extra[MESSAGE_COST_KEY].requests.map(x => x.id), ['usage-swipe']);
    assert.equal(message.swipe_info[0].extra[MESSAGE_COST_KEY], undefined);

    await begin(f, 'continue');
    prepare(f, { type: 'continue', stream: false }, 'usage-continue');
    assert.deepEqual(getMessageCost(message).requests.map(x => x.id), ['usage-swipe', 'usage-continue']);
    assert.deepEqual(message.swipe_info[1].extra[MESSAGE_COST_KEY].requests.map(x => x.id),
        ['usage-swipe', 'usage-continue']);
});

test('stopped streaming generation stores one interrupted partial snapshot', async t => {
    const f = fixture({ chat: [{ is_user: true }] });
    t.after(() => f.destroy());
    const processor = { messageId: -1 };
    f.context().streamingProcessor = processor;
    await begin(f);
    const token = prepare(f, { type: 'normal', stream: true }, 'usage-partial');
    f.tracker.started(token);
    const partial = assistant('partial');
    f.context().chat.push(partial);
    processor.messageId = 1;
    f.setNow(160);
    f.tracker.failed(token);
    await f.bus.emit('GENERATION_STOPPED');
    const request = getMessageCost(partial).requests[0];
    assert.equal(request.id, 'usage-partial');
    assert.equal(request.timing.interrupted, true);
    assert.equal(request.timing.durationMs, 60);
});

test('persisted snapshots refresh after reload without backfilling messages that lack snapshots', async t => {
    const persisted = assistant();
    persisted.extra[MESSAGE_COST_KEY] = { version: 1, requests: [{ id: 'usage-saved', chatId: 'chat-a',
        record: { id: 'usage-saved', chatId: 'chat-a', status: 'pending' } }] };
    persisted.swipe_info[0].extra[MESSAGE_COST_KEY] = structuredClone(persisted.extra[MESSAGE_COST_KEY]);
    const historical = assistant('old untracked');
    const record = { id: 'usage-saved', chatId: 'chat-a', status: 'complete', usage: { promptTokenCount: 1 } };
    const f = fixture({ chat: [persisted, historical], readUsage: async () => ({ ok: true, records: [record] }) });
    t.after(() => f.destroy());
    await f.tracker.refresh();
    assert.equal(getMessageCost(persisted).requests[0].record.status, 'complete');
    assert.equal(getMessageCost(historical), null);
});

test('ledger network failure leaves the pending snapshot unchanged', async t => {
    const message = assistant();
    message.extra[MESSAGE_COST_KEY] = { version: 1, requests: [{ id: 'usage-pending', chatId: 'chat-a',
        record: { id: 'usage-pending', chatId: 'chat-a', status: 'pending' } }] };
    const f = fixture({ chat: [message], readUsage: async () => { throw new Error('offline'); } });
    t.after(() => f.destroy());
    const originalWarn = console.warn;
    console.warn = () => {};
    try { await f.tracker.refresh(); } finally { console.warn = originalWarn; }
    assert.equal(getMessageCost(message).requests[0].record.status, 'pending');
});

test('message removal or index shifts cannot bind a request to a different assistant message', async t => {
    const anchor = { is_user: true, mes: 'prompt' };
    const f = fixture({ chat: [anchor] });
    t.after(() => f.destroy());
    await begin(f);
    const token = prepare(f, { type: 'normal', stream: false }, 'usage-fixed');
    f.context().chat.unshift(assistant('inserted before target'));
    f.context().chat.push(assistant('unrelated result'));
    f.tracker.failed(token);
    await f.bus.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(getMessageCost(f.context().chat[0]), null);
    assert.equal(getMessageCost(f.context().chat[2]), null);
});

test('a finished unbound request survives recursive generation until a visible message can receive it', async t => {
    const f = fixture({ chat: [{ is_user: true, mes: 'prompt' }] });
    t.after(() => f.destroy());
    await begin(f);
    const first = prepare(f, { type: 'normal', stream: false }, 'usage-tool-step');
    f.tracker.started(first);
    const firstResponse = f.tracker.response(first, new Response('tool call'), null);
    await firstResponse.text();

    // A stealth tool call can recurse into Generate without producing a
    // MESSAGE_RECEIVED event for the first request.
    await begin(f, 'normal');
    const second = prepare(f, { type: 'normal', stream: false }, 'usage-visible');
    const visible = assistant('final answer');
    f.context().chat.push(visible);
    f.tracker.failed(second);
    await f.bus.emit('MESSAGE_RECEIVED', 1, 'normal');

    assert.deepEqual(getMessageCost(visible).requests.map(request => request.id),
        ['usage-tool-step', 'usage-visible']);
});

test('an active long stream does not read the ledger or spend retry attempts', async t => {
    let reads = 0;
    const message = assistant('partial');
    const f = fixture({ chat: [message], readUsage: async () => (++reads, { ok: true, records: [] }) });
    t.after(() => f.destroy());
    f.context().streamingProcessor = { messageId: 0 };
    await begin(f);
    const token = prepare(f, { type: 'continue', stream: true }, 'usage-long-stream');
    f.tracker.started(token);
    await f.tracker.refresh();
    await f.tracker.refresh();
    assert.equal(reads, 0);
    assert.equal(getMessageCost(message).requests[0].record.status, 'pending');
});

test('an older request finishing late preserves a continuation already appended to the same swipe', async t => {
    const message = assistant();
    const f = fixture({ chat: [message] });
    t.after(() => f.destroy());
    await begin(f, 'continue');
    const older = prepare(f, { type: 'continue', stream: false }, 'usage-older');
    f.tracker.started(older);

    const newer = prepare(f, { type: 'continue', stream: false }, 'usage-newer');
    f.tracker.started(newer);
    f.setNow(130);
    f.tracker.failed(newer);
    f.setNow(180);
    f.tracker.failed(older);

    const requests = getMessageCost(message).requests;
    assert.deepEqual(requests.map(request => request.id), ['usage-older', 'usage-newer']);
    assert.equal(requests[0].timing.durationMs, 80);
    assert.equal(requests[1].timing.durationMs, 30);
});

test('a request after generation ended cannot inherit an unbound failed request from the closed generation', async t => {
    const f = fixture({ chat: [{ is_user: true, mes: 'prompt' }] });
    t.after(() => f.destroy());
    await begin(f);
    const abandoned = prepare(f, { type: 'normal', stream: false }, 'usage-no-reply');
    f.tracker.failed(abandoned);
    await f.bus.emit('GENERATION_ENDED');

    await begin(f);
    const current = prepare(f, { type: 'normal', stream: false }, 'usage-current');
    const answer = assistant();
    f.context().chat.push(answer);
    f.tracker.failed(current);
    await f.bus.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.deepEqual(getMessageCost(answer).requests.map(request => request.id), ['usage-current']);
});

test('ledger refresh updates all variant copies and a late timing write does not restore pending data', async t => {
    const message = assistant();
    const record = { id: 'usage-refresh', chatId: 'chat-a', status: 'complete', usage: { promptTokenCount: 4 } };
    const f = fixture({ chat: [message], readUsage: async () => ({ ok: true, records: [record] }) });
    t.after(() => f.destroy());
    await begin(f, 'continue');
    const token = prepare(f, { type: 'continue', stream: false }, 'usage-refresh');
    f.tracker.started(token);
    f.setNow(150);
    f.tracker.failed(token);
    await f.tracker.refresh();
    assert.equal(getMessageCost(message).requests[0].record.status, 'complete');
    assert.equal(message.swipe_info[0].extra[MESSAGE_COST_KEY].requests[0].record.status, 'complete');

    f.setNow(175);
    f.tracker.failed(token);
    assert.equal(getMessageCost(message).requests[0].record.status, 'complete');
    assert.equal(message.swipe_info[0].extra[MESSAGE_COST_KEY].requests[0].record.status, 'complete');
    assert.equal(getMessageCost(message).requests[0].timing.durationMs, 75);
});
