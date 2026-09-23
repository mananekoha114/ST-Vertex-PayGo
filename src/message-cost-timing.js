/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/ */

function hasContent(value) {
    if (typeof value === 'string') return value.length > 0;
    if (Array.isArray(value)) return value.some(part => hasContent(part?.text));
    return false;
}

function hasGeneratedContent(data) {
    return data?.choices?.some(choice => {
        const delta = choice.delta ?? choice.message ?? {};
        return [delta.content, delta.reasoning, delta.reasoning_content, choice.text].some(hasContent)
            || delta.reasoning_details?.some(part => hasContent(part?.text));
    }) || data?.candidates?.some(candidate => candidate.content?.parts?.some(part => hasContent(part.text)));
}

/** Pass through the response without teeing/buffering it. Only inspect bounded
 * SSE frames until the first actual content arrives; role/usage frames don't count.
 * Timings are browser-observed wall times, not server-side model inference time. */
export function observeGenerationResponse(response, {
    stream, startedAt, now = () => performance.now(), onTiming = () => {}, signal,
} = {}) {
    if (!response?.body?.getReader || !response.ok) return response;
    const reader = response.body.getReader();
    let firstTokenMs = null;
    let finished = false;
    let buffer = '';
    let frame = '';
    let discardFrame = false;
    let decoder = stream ? new TextDecoder() : null;
    const maxFrame = 131072;
    const report = (interrupted = false) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', aborted);
        try { onTiming({ stream: Boolean(stream), durationMs: Math.max(0, now() - startedAt), firstTokenMs, interrupted }); }
        catch (error) { console.warn('[Vertex PayGo] Could not record response timing.', error); }
    };
    const aborted = () => report(true);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();

    function inspect(bytes) {
        if (!decoder) return;
        buffer += decoder.decode(bytes, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            if (!line) {
                if (!discardFrame && frame) {
                    try {
                        if (hasGeneratedContent(JSON.parse(frame))) {
                            firstTokenMs = Math.max(0, now() - startedAt);
                            decoder = null;
                            buffer = '';
                            frame = '';
                            return;
                        }
                    } catch { /* Metadata, malformed frames and [DONE] aren't content. */ }
                }
                frame = '';
                discardFrame = false;
            } else if (line.startsWith('data:') && !discardFrame) {
                frame += `${line.slice(5).trimStart()}\n`;
                if (frame.length > maxFrame) { frame = ''; discardFrame = true; }
            }
        }
        if (buffer.length > maxFrame) { buffer = ''; frame = ''; discardFrame = true; }
    }

    const body = new ReadableStream({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) { report(); controller.close(); reader.releaseLock(); return; }
                inspect(value);
                controller.enqueue(value);
            } catch (error) {
                report(true);
                controller.error(error);
                reader.releaseLock();
            }
        },
        async cancel(reason) {
            report(true);
            try { await reader.cancel(reason); } finally { reader.releaseLock(); }
        },
    });
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    // Keep the observable fetch response metadata for host/extensions.
    for (const key of ['url', 'redirected', 'type']) Object.defineProperty(wrapped, key, { value: response[key] });
    return wrapped;
}
