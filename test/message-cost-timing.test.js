import test from 'node:test';
import assert from 'node:assert/strict';
import { observeGenerationResponse } from '../src/message-cost-timing.js';

const encoder = new TextEncoder();

function responseFrom(chunks, { errorAt = -1, cancel = null } = {}) {
    let index = 0;
    return new Response(new ReadableStream({
        pull(controller) {
            if (index === errorAt) {
                controller.error(new Error('stream failed'));
                return;
            }
            if (index === chunks.length) {
                controller.close();
                return;
            }
            controller.enqueue(encoder.encode(chunks[index++]));
        },
        cancel,
    }), { status: 200, headers: { 'x-fixture': 'timing' } });
}

function clock(...values) {
    let index = 0;
    return () => values[Math.min(index++, values.length - 1)];
}

test('stream passthrough preserves bytes and ignores role-only frames before split text content', async () => {
    const chunks = [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
            'data: {"choices":[{"delta":{"cont',
        'ent":"hello"}}]}\n',
        '\ndata: [DONE]\n\n',
    ];
    const timings = [];
    const wrapped = observeGenerationResponse(responseFrom(chunks), {
        stream: true,
        startedAt: 100,
        now: clock(125, 190),
        onTiming: timing => timings.push(timing),
    });

    const output = new Uint8Array(await wrapped.arrayBuffer());
    assert.deepEqual(output, encoder.encode(chunks.join('')));
    assert.equal(wrapped.headers.get('x-fixture'), 'timing');
    assert.deepEqual(timings, [{ stream: true, durationMs: 90, firstTokenMs: 25, interrupted: false }]);
});

test('reasoning content counts as the first generated token', async () => {
    const timings = [];
    const wrapped = observeGenerationResponse(responseFrom([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
    ]), { stream: true, startedAt: 10, now: clock(17, 31), onTiming: value => timings.push(value) });
    await wrapped.text();
    assert.equal(timings[0].firstTokenMs, 7);
    assert.equal(timings[0].durationMs, 21);
});

test('non-streaming responses report duration without a first-token time', async () => {
    const timings = [];
    const response = responseFrom(['{"choices":[{"message":{"content":"complete"}}]}']);
    const wrapped = observeGenerationResponse(response, {
        stream: false, startedAt: 50, now: () => 125, onTiming: value => timings.push(value),
    });
    assert.equal(await wrapped.text(), '{"choices":[{"message":{"content":"complete"}}]}');
    assert.deepEqual(timings, [{ stream: false, durationMs: 75, firstTokenMs: null, interrupted: false }]);
});

test('consumer cancellation reports one interrupted timing and cancels the source', async () => {
    const timings = [];
    const reasons = [];
    const wrapped = observeGenerationResponse(responseFrom(['first', 'second'], { cancel: reason => reasons.push(reason) }), {
        stream: true, startedAt: 0, now: () => 40, onTiming: value => timings.push(value),
    });
    const reader = wrapped.body.getReader();
    await reader.read();
    await reader.cancel('unused');
    assert.deepEqual(reasons, ['unused']);
    assert.deepEqual(timings, [{ stream: true, durationMs: 40, firstTokenMs: null, interrupted: true }]);
});

test('abort and stream errors each report interrupted timing exactly once', async () => {
    const aborted = [];
    const controller = new AbortController();
    const abortWrapped = observeGenerationResponse(responseFrom(['data: {}\n\n']), {
        stream: true, startedAt: 0, now: () => 12, signal: controller.signal,
        onTiming: value => aborted.push(value),
    });
    controller.abort();
    await abortWrapped.text();
    assert.equal(aborted.length, 1);
    assert.equal(aborted[0].interrupted, true);

    const errored = [];
    const errorWrapped = observeGenerationResponse(responseFrom(['unused'], { errorAt: 0 }), {
        stream: true, startedAt: 0, now: () => 23, onTiming: value => errored.push(value),
    });
    await assert.rejects(errorWrapped.text(), /stream failed/);
    assert.equal(errored.length, 1);
    assert.equal(errored[0].interrupted, true);
});

test('timing callback failures do not change successful response consumption', async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        const wrapped = observeGenerationResponse(responseFrom(['payload']), {
            stream: false, startedAt: 0, now: () => 1,
            onTiming: () => { throw new Error('observer failed'); },
        });
        assert.equal(await wrapped.text(), 'payload');
    } finally {
        console.warn = originalWarn;
    }
});
