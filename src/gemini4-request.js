/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/ */

import { isGoogleSource } from './constants.js';

export const GEMINI4_NATIVE_ROUTE = '/api/plugins/vertex-paygo/native-gemini/generate';
export const GEMINI4_MODEL_LIMIT = 1048576;
const models = ['gemini-4-argon', 'gemini-4-argon-cyber-permissive'];

export async function enrichGemini4ModelList(response) {
    if (!response?.ok || typeof response.clone !== 'function') return response;
    let data;
    try { data = await response.clone().json(); } catch { return response; }
    if (!Array.isArray(data?.data)) return response;
    for (const id of models) {
        let record = data.data.find(record => record.id === id);
        if (!record) data.data.push(record = { id });
        record.inputTokenLimit ??= GEMINI4_MODEL_LIMIT;
        record.outputTokenLimit ??= GEMINI4_MODEL_LIMIT;
    }
    const headers = new Headers(response.headers);
    for (const name of ['content-length', 'content-encoding', 'etag']) headers.delete(name);
    const result = new Response(JSON.stringify(data), { status: response.status, statusText: response.statusText, headers });
    for (const key of ['url', 'redirected', 'type']) Object.defineProperty(result, key, { value: response[key] });
    return result;
}

const ERROR_KEYS = {
    GEMINI4_OUTPUT_BUDGET_EXHAUSTED: () => ['vertex_paygo.gemini4.budget_exhausted', {}],
    NATIVE_GEMINI_EMPTY_RESPONSE: details => ['vertex_paygo.gemini4.no_output', { reason: details.reason ?? 'UNKNOWN' }],
    GEMINI4_UPSTREAM_HTTP_ERROR: details => (details.upstreamMessage || details.googleStatus) && Number.isInteger(details.upstreamStatus)
        ? ['vertex_paygo.gemini4.upstream_error', { status: details.upstreamStatus, message: details.upstreamMessage || details.googleStatus }]
        : null,
};

function localizeError(error, localize) {
    if (!error || typeof error !== 'object' || !Object.hasOwn(ERROR_KEYS, error.code)) return null;
    const entry = ERROR_KEYS[error.code](error.details && typeof error.details === 'object' ? error.details : {});
    return entry ? { ...error, message: localize(...entry) } : null;
}

function rebuildResponse(response, body) {
    const headers = new Headers(response.headers);
    for (const name of ['content-length', 'content-encoding', 'etag']) headers.delete(name);
    const result = new Response(body, { status: response.status, statusText: response.statusText, headers });
    for (const key of ['url', 'redirected', 'type']) Object.defineProperty(result, key, { value: response[key] });
    return result;
}

/**
 * The host shows data.error.message from failed responses and SSE events
 * verbatim. Translate the server's English diagnoses for known error codes.
 */
export async function localizeGemini4Response(response, localize) {
    if (typeof localize !== 'function' || !response) return response;
    if (!response.ok) {
        let data;
        try { data = await response.clone().json(); } catch { return response; }
        const error = localizeError(data?.error, localize);
        return error ? rebuildResponse(response, JSON.stringify({ ...data, error, message: error.message })) : response;
    }
    if (!response.body || !/^text\/event-stream/iu.test(response.headers.get('content-type') ?? '')) return response;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    const rewrite = frame => {
        const data = frame.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data.startsWith('{"error"')) return frame;
        try {
            const parsed = JSON.parse(data);
            const error = localizeError(parsed.error, localize);
            return error ? `data: ${JSON.stringify({ ...parsed, error })}` : frame;
        } catch { return frame; }
    };
    return rebuildResponse(response, response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            const frames = buffer.split(/\r?\n\r?\n/u);
            buffer = frames.pop();
            for (const frame of frames) controller.enqueue(encoder.encode(`${rewrite(frame)}\n\n`));
        },
        flush(controller) {
            buffer += decoder.decode();
            if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
        },
    })));
}

export function isNativeGemini4Request(data) {
    return isGoogleSource(data?.chat_completion_source)
        && /^gemini-4-argon(?:-cyber-permissive)?$/u.test(data?.model ?? '');
}

// Keep Request headers, credentials and cancellation when only its destination
// changes. The caller replaces the body with the final prepared JSON payload.
export function getGemini4RequestTarget(input, origin) {
    const url = new URL(GEMINI4_NATIVE_ROUTE, origin);
    return typeof input?.clone === 'function' ? new Request(url, input) : url.toString();
}
