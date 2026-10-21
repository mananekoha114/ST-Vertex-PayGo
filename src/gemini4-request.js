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
