/* Copyright (c) 2026 Mana Nekoha; MPL-2.0 */
import { normalizePrice } from './cost-model.js';
const NS = 'vertex-paygo';
const MAX_CAPTURE = 1024 * 1024;
const COUNTS = ['promptTokenCount', 'cachedContentTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'toolUsePromptTokenCount'];
const DETAILS = ['promptTokensDetails', 'cacheTokensDetails', 'candidatesTokensDetails'];

function method(store, name) {
    if (typeof store?.[name] !== 'function') throw new TypeError(`TauriTavern store is missing ${name}.`);
    return store[name].bind(store);
}
function table(chatId) {
    if (typeof chatId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) throw new TypeError('A valid conversation usage ID is required.');
    return `chat-${chatId}`;
}
function metadata(value, idFactory) {
    const out = {};
    for (const key of ['id', 'chatId', 'source', 'model', 'tier', 'paygoOnly', 'stream', 'startedAt']) if (value?.[key] !== undefined) out[key] = value[key];
    const price = normalizePrice(value?.price);
    if (price) out.price = price;
    out.id ||= idFactory?.();
    if (typeof out.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(out.id)) throw new TypeError('Usage metadata requires a safe id.');
    table(out.chatId);
    return out;
}
function code(error, fallback = 'REQUEST_FAILED') {
    if (error?.name === 'AbortError') return 'CLIENT_ABORTED';
    return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code) ? error.code : fallback;
}
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function details(value) {
    if (!Array.isArray(value)) return undefined;
    return value.flatMap(item => {
        const modality = typeof item?.modality === 'string' ? item.modality : undefined;
        const tokenCount = integer(item?.tokenCount ?? item?.token_count);
        return modality !== undefined && tokenCount !== undefined ? [{ modality, tokenCount }] : [];
    });
}
function exactUsage(value) {
    const source = value?.usageMetadata ?? value?.usage;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const out = {};
    for (const key of COUNTS) { const count = integer(source[key]); if (count !== undefined) out[key] = count; }
    if (typeof source.trafficType === 'string') out.trafficType = source.trafficType;
    for (const key of DETAILS) { const clean = details(source[key]); if (clean !== undefined) out[key] = clean; }
    return Object.keys(out).length ? out : null;
}
function normalizedUsage(value) {
    const source = value?.usage;
    if (!source || typeof source !== 'object') return null;
    const pick = (...keys) => keys.map(key => integer(source[key])).find(item => item !== undefined);
    const nestedCached = integer(source.prompt_tokens_details?.cached_tokens)
        ?? (Array.isArray(source.prompt_tokens_details)
            ? source.prompt_tokens_details.reduce((sum, item) => sum + (integer(item?.cached_tokens) ?? 0), 0) : undefined);
    const out = {
        promptTokenCount: pick('promptTokenCount', 'inputTokens', 'input_tokens', 'prompt_tokens'),
        cachedContentTokenCount: pick('cachedContentTokenCount', 'cachedInputTokens', 'cached_input_tokens', 'cache_read_input_tokens') ?? nestedCached,
        candidatesTokenCount: pick('candidatesTokenCount', 'outputTokens', 'output_tokens', 'completion_tokens'),
        thoughtsTokenCount: pick('thoughtsTokenCount', 'thoughtTokens', 'thought_tokens', 'reasoning_tokens'),
    };
    for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
    return out.promptTokenCount !== undefined || out.candidatesTokenCount !== undefined ? out : null;
}
function merge(current, value) {
    const next = exactUsage(value);
    if (!next) return current;
    const out = { ...(current ?? {}) };
    for (const [key, item] of Object.entries(next)) out[key] = Number.isSafeInteger(item) && Number.isSafeInteger(out[key]) ? Math.max(item, out[key]) : item;
    return out;
}
function parseEvent(event, consume) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    try { consume(JSON.parse(data)); } catch { /* Response bytes remain untouched. */ }
}
function preserveMetadata(target, source) {
    for (const key of ['url', 'redirected', 'type']) try { Object.defineProperty(target, key, { configurable: true, value: source[key] }); } catch { /* host restriction */ }
    return target;
}

export function createTauriUsageClient({ store, notifyWarning = () => {}, idFactory } = {}) {
    const setJson = method(store, 'setJson');
    const listKeys = method(store, 'listKeys');
    const getJson = typeof store?.tryGetJson === 'function' ? store.tryGetJson.bind(store) : method(store, 'getJson');
    let writes = Promise.resolve();
    let writeError = null;
    let destroyed = false;
    const activeCleanups = new Set();
    function warn(error) {
        try { notifyWarning('This request could not be added to the usage ledger. Conversation costs will be incomplete.', error); }
        catch (notificationError) { console.warn('[Vertex PayGo] Usage warning failed.', notificationError); }
        console.warn('[Vertex PayGo] Usage ledger write failed.', error);
    }
    function persist(record) {
        if (destroyed) return Promise.reject(new Error('Usage client has been destroyed.'));
        const task = writes.then(() => setJson({ namespace: NS, table: table(record.chatId), key: record.id, value: record }));
        writes = task.catch(error => { writeError = error; warn(error); });
        return task;
    }
    const base = value => { const clean = metadata(value, idFactory); return { ...clean, createdAt: new Date(clean.startedAt ?? Date.now()).toISOString() }; };
    function recordFailure(meta, error) {
        const record = { ...base(meta), status: 'failed', errorCode: code(error), usage: null };
        void persist(record).catch(() => {}); return record;
    }
    function observeResponse(response, meta, { signal } = {}) {
        if (!(response instanceof Response)) throw new TypeError('A Response is required.');
        const recordBase = base(meta);
        if (!response.ok) { void persist({ ...recordBase, status: 'failed', errorCode: `UPSTREAM_HTTP_${response.status}`, usage: null }).catch(() => {}); return response; }
        if (!response.body) { void persist({ ...recordBase, status: 'incomplete', errorCode: 'USAGE_METADATA_MISSING', usage: null }).catch(() => {}); return response; }
        const streaming = meta?.stream === true || /text\/event-stream/i.test(response.headers.get('content-type') ?? '');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', captured = 0, limited = false, discardEvent = false, discardTail = '';
        let usage = null, responseError = false, finished = false, aborted = false;
        const cleanup = () => { signal?.removeEventListener('abort', abort); activeCleanups.delete(cleanup); };
        activeCleanups.add(cleanup);
        const finalize = (status, errorCode = null) => {
            if (finished) return;
            finished = true;
            let finalUsage = usage, accuracy;
            if (!streaming && !limited && status === 'complete') {
                try {
                    const value = JSON.parse(buffer);
                    responseError ||= Boolean(value?.error);
                    finalUsage = value?.usageMetadata ? exactUsage(value) : normalizedUsage(value);
                    if (finalUsage && !value?.usageMetadata) accuracy = 'tauri-normalized';
                } catch { finalUsage = null; }
            }
            if (responseError) { status = 'failed'; errorCode = 'UPSTREAM_RESPONSE_ERROR'; }
            if (limited) { status = 'incomplete'; errorCode = 'USAGE_CAPTURE_LIMIT'; }
            const hasUsage = finalUsage && Object.keys(finalUsage).length;
            void persist({ ...recordBase, status: hasUsage ? status : status === 'failed' ? 'failed' : 'incomplete',
                errorCode: hasUsage ? errorCode : errorCode ?? 'USAGE_METADATA_MISSING', usage: hasUsage ? finalUsage : null,
                ...(accuracy ? { usageAccuracy: accuracy } : {}) }).catch(() => {});
        };
        const abort = () => { aborted = true; void reader.cancel(signal?.reason).catch(() => {}); finalize('incomplete', 'CLIENT_ABORTED'); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const body = new ReadableStream({
            async pull(controller) {
                try {
                    if (aborted) throw signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
                    const result = await reader.read();
                    if (aborted) throw signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
                    if (result.done) {
                        if (!limited || (streaming && !discardEvent)) buffer += decoder.decode();
                        if (streaming && buffer.trim() && !discardEvent) parseEvent(buffer, value => { usage = merge(usage, value); responseError ||= Boolean(value?.error); });
                        finalize('complete'); cleanup(); controller.close(); return;
                    }
                    const decoded = decoder.decode(result.value, { stream: true });
                    if (streaming) {
                        let piece = decoded;
                        if (discardEvent) {
                            piece = discardTail + piece;
                            const boundary = piece.search(/\r?\n\r?\n/);
                            if (boundary < 0) { discardTail = piece.slice(-3); piece = ''; }
                            else { piece = piece.slice(boundary).replace(/^\r?\n\r?\n/, ''); discardEvent = false; discardTail = ''; }
                        }
                        buffer += piece;
                        const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() ?? '';
                        for (const event of events) {
                            if (event.length > MAX_CAPTURE) { limited = true; continue; }
                            parseEvent(event, value => { usage = merge(usage, value); responseError ||= Boolean(value?.error); });
                        }
                        if (buffer.length > MAX_CAPTURE) { limited = true; discardEvent = true; discardTail = buffer.slice(-3); buffer = ''; }
                    } else {
                        captured += result.value.byteLength;
                        if (!limited && captured <= MAX_CAPTURE) buffer += decoded;
                        else { limited = true; buffer = ''; }
                    }
                    controller.enqueue(result.value);
                } catch (error) { finalize('incomplete', code(error, 'UPSTREAM_RESPONSE_STREAM_FAILED')); cleanup(); controller.error(error); }
            },
            async cancel(reason) { try { await reader.cancel(reason); } finally { finalize('incomplete', signal?.aborted ? 'CLIENT_ABORTED' : 'CLIENT_DISCONNECTED'); cleanup(); } },
        });
        return preserveMetadata(new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }), response);
    }
    async function flush() { await writes; if (writeError) { const error = writeError; writeError = null; throw error; } }
    async function readUsage(chatId) {
        await flush();
        const tableName = table(chatId);
        const keys = await listKeys({ namespace: NS, table: tableName });
        if (!Array.isArray(keys)) throw new TypeError('Invalid TauriTavern usage key list.');
        const records = [];
        let truncated = false;
        let cursor = 0;
        async function worker() {
            while (cursor < keys.length) {
                const key = keys[cursor++];
                const result = await getJson({ namespace: NS, table: tableName, key });
                const value = result && typeof result === 'object' && typeof result.found === 'boolean'
                    ? (result.found ? result.value : null) : result;
                if (value && typeof value === 'object' && value.id === key && value.chatId === chatId) records.push(value);
                else truncated = true;
            }
        }
        await Promise.all(Array.from({ length: Math.min(8, keys.length) }, worker));
        records.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
        return { ok: true, records, truncated };
    }
    function destroy() { destroyed = true; for (const cleanup of activeCleanups) cleanup(); activeCleanups.clear(); }
    return { observeResponse, recordFailure, readUsage, flush, destroy };
}
