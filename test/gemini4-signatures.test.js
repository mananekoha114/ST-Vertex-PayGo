import test from 'node:test';
import assert from 'node:assert/strict';
import { createGemini4SignatureTracker } from '../src/gemini4-signatures.js';

function fixture() {
    const handlers = new Map();
    let context = { chat: [], getCurrentChatId: () => 'chat-A',
        eventTypes: { GENERATION_STARTED: 'start', CHAT_CHANGED: 'chat', MESSAGE_RECEIVED: 'received' },
        eventSource: { on: (name, listener) => handlers.set(name, listener), removeListener: name => handlers.delete(name) } };
    const tracker = createGemini4SignatureTracker({ context, getContext: () => context });
    return { tracker, handlers, get context() { return context; }, switchChat() { context = { ...context, chat: [], getCurrentChatId: () => 'chat-B' }; } };
}
const data = { stream: false, chat_completion_source: 'vertexai', model: 'gemini-4-argon' };
const message = () => ({ mes: 'answer', extra: { api: 'vertexai', model: 'gemini-4-argon', reasoning_signature: null },
    swipe_id: 1, swipe_info: [{ extra: {} }, { extra: {} }] });
const response = () => Response.json({ nativeGeminiSignature: 'st-vertex-paygo-text:v1:fixture' });

test('non-streaming signature is saved during exact message event and copied to its swipe', async () => {
    const f = fixture();
    const token = f.tracker.capture(data, false);
    await f.tracker.observe(token, response());
    f.context.chat.push(message());
    f.handlers.get('received')(0);
    assert.equal(f.context.chat[0].extra.reasoning_signature, 'st-vertex-paygo-text:v1:fixture');
    assert.equal(f.context.chat[0].swipe_info[1].extra.reasoning_signature, 'st-vertex-paygo-text:v1:fixture');
    assert.equal(f.context.chat[0].swipe_info[0].extra.reasoning_signature, undefined);
    f.tracker.cleanup();
    assert.equal(f.handlers.size, 0);
});

test('chat switches, later generations and background requests never borrow a signature', async () => {
    for (const change of ['chat', 'generation']) {
        const f = fixture();
        const token = f.tracker.capture(data, false);
        if (change === 'chat') f.switchChat();
        else f.handlers.get('start')();
        await f.tracker.observe(token, response());
        f.context.chat.push(message());
        f.handlers.get('received')(0);
        assert.equal(f.context.chat[0].extra.reasoning_signature, null);
        assert.equal(f.tracker.capture(data, true), null);
        assert.equal(f.tracker.capture({ ...data, stream: true }, false), null);
        f.tracker.cleanup();
    }
});
