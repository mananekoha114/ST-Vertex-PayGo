/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/ */

import { createConversationId } from './cost-context.js';
import { observeGenerationResponse } from './message-cost-timing.js';

export const MESSAGE_COST_KEY = 'vertex_paygo_cost';
const allowedTypes = new Set([undefined, null, '', 'normal', 'regenerate', 'swipe', 'continue', 'append', 'appendFinal']);
const clone = value => structuredClone(value);

export function getMessageCost(message) {
    const value = message?.extra?.[MESSAGE_COST_KEY];
    return value?.version === 1 && Array.isArray(value.requests) ? value : null;
}

/** Correlate exact requests with the message/variant they produce. No timestamp
 * matching or historical ledger backfill: snapshots exist only for observed requests. */
export function createMessageCosts({
    getContext, getChatId, serverClient, onChange = () => {},
    documentRef = globalThis.document, now = () => performance.now(), idFactory = createConversationId,
    retryMs = 1500, maxRetries = 12,
}) {
    const entries = new Map();
    const listeners = [];
    let epoch = 0;
    let generation = null;
    let destroyed = false;
    let refreshTimer = null;
    let saveTimer = null;
    let inFlight = null;
    let attempts = 0;
    const initial = getContext();
    const liveChat = () => getChatId?.();
    const changed = () => { if (!destroyed) onChange(); };

    function saveSoon(chatId) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            if (destroyed || liveChat() !== chatId) return;
            Promise.resolve().then(() => {
                if (!destroyed && liveChat() === chatId) return getContext().saveChat?.();
            }).catch(error =>
                console.warn('[Vertex PayGo] Could not save message cost details.', error));
        }, 150);
    }

    function writeVariant(message, swipeId, snapshot) {
        if ((message.swipe_id ?? 0) === swipeId) {
            message.extra ??= {};
            message.extra[MESSAGE_COST_KEY] = clone(snapshot);
        }
        // Don't fabricate swipe_info while ST is building a new swipe. The host
        // copies message.extra at that point; existing variants need an explicit copy.
        const info = message.swipe_info?.[swipeId];
        if (info) {
            info.extra ??= {};
            info.extra[MESSAGE_COST_KEY] = clone(snapshot);
        }
    }

    function entryIsCurrent(entry) {
        return !destroyed && entry.epoch === epoch && liveChat() === entry.chatId
            && getContext().chat === entry.chat;
    }

    function storeEntry(entry) {
        if (!entryIsCurrent(entry) || !entry.message || !entry.chat.includes(entry.message)) return;
        let requests = [...entry.previous, clone(entry.request)];
        if (entry.storedId) {
            const current = (entry.message.swipe_id ?? 0) === entry.swipeId
                ? getMessageCost(entry.message)
                : entry.message.swipe_info?.[entry.swipeId]?.extra?.[MESSAGE_COST_KEY];
            // A later continuation may already have appended its own request.
            // Update only this entry, never restore an earlier whole snapshot.
            if (!current?.requests?.some(request => request.id === entry.storedId)) return;
            requests = current.requests.map(request => request.id === entry.storedId ? clone(entry.request) : request);
        }
        const snapshot = { version: 1, requests };
        writeVariant(entry.message, entry.swipeId, snapshot);
        entry.storedId = entry.request.id;
        changed();
        saveSoon(entry.chatId);
    }

    function bind(entry, messageId) {
        if (!entryIsCurrent(entry) || entry.message || entry.session !== generation?.session) return false;
        const context = getContext();
        const message = context.chat[entry.index];
        if (messageId !== undefined && messageId !== entry.index) return false;
        if (!message || message.is_user || message.is_system) return false;
        if (entry.target && entry.target !== message) return false;
        if (!entry.target && entry.before && context.chat[entry.index - 1] !== entry.before) return false;
        // StreamingProcessor is the exact host object captured before this fetch.
        if (entry.processor && entry.processor.messageId !== entry.index) return false;
        if ((message.swipe_id ?? 0) !== entry.swipeId) return false;
        entry.message = message;
        storeEntry(entry);
        return true;
    }

    function reconcile(messageId) {
        for (const entry of entries.values()) bind(entry, messageId);
    }

    function capture(data, chatId) {
        if (destroyed || !chatId || !generation || !allowedTypes.has(data.type)) return null;
        const context = getContext();
        if (generation.chat !== context.chat || generation.epoch !== epoch) return null;
        const existing = ['swipe', 'continue', 'append', 'appendFinal'].includes(data.type);
        const index = existing ? context.chat.length - 1 : context.chat.length;
        const target = existing ? context.chat[index] : null;
        if (existing && (!target || target.is_user || target.is_system)) return null;
        const token = idFactory();
        const isContinue = ['continue', 'append', 'appendFinal'].includes(data.type);
        const previous = isContinue ? clone(getMessageCost(target)?.requests ?? []) : [];
        // Tool-only turns can be removed by ST before a recursive Generate.
        // Their exact request references follow the same uninterrupted generation
        // session into its next visible reply, rather than matching by timestamp.
        for (const [key, donor] of entries) {
            if (donor.session === generation.session && donor.finished
                && (!donor.message || !context.chat.includes(donor.message))) {
                previous.push(...clone(donor.previous), clone(donor.request));
                entries.delete(key);
            }
        }
        const entry = {
            epoch, session: generation.session, chatId, chat: context.chat,
            index, target, before: context.chat[index - 1], message: null,
            processor: data.stream ? context.streamingProcessor : null,
            swipeId: target?.swipe_id ?? 0,
            previous: [...new Map(previous.map(request => [request.id, request])).values()],
            request: { id: `pending-${token}`, chatId, status: 'pending' },
            stream: Boolean(data.stream), startedAt: null,
        };
        entries.set(token, entry);
        // Existing continuation/swipe messages can show pending immediately.
        // For a new streaming message, its placeholder will be bound by the DOM
        // observer or STREAM_TOKEN_RECEIVED, after the processor obtains its id.
        if (target && !entry.processor) bind(entry);
        return token;
    }

    function prepared(token, usageId, details) {
        const entry = entries.get(token);
        if (!entry || !entryIsCurrent(entry)) return;
        entry.request.id = usageId || entry.request.id;
        entry.request.status = usageId ? 'pending' : 'unavailable';
        entry.request.record = { ...clone(details), id: entry.request.id,
            status: 'pending', usage: null, createdAt: new Date().toISOString() };
        entry.hasUsageId = Boolean(usageId);
        if (entry.message) storeEntry(entry);
        else reconcile();
    }

    function started(token) {
        const entry = entries.get(token);
        if (entry) entry.startedAt = now();
    }

    function finished(entry, timing) {
        if (!entryIsCurrent(entry)) return;
        entry.request.timing = timing;
        entry.finished = true;
        reconcile();
        storeEntry(entry);
        if (entry.hasUsageId) scheduleRefresh(0);
    }

    function response(token, result, signal) {
        const entry = entries.get(token);
        if (!entry || entry.startedAt === null || !entryIsCurrent(entry)) return result;
        if (!result?.ok) { failed(token); return result; }
        return observeGenerationResponse(result, {
            stream: entry.stream, startedAt: entry.startedAt, now, signal,
            onTiming: timing => finished(entry, timing),
        });
    }

    function failed(token) {
        const entry = entries.get(token);
        if (!entry) return;
        finished(entry, { stream: entry.stream, durationMs: entry.startedAt === null ? null : Math.max(0, now() - entry.startedAt),
            firstTokenMs: null, interrupted: true });
    }

    function snapshots() {
        const result = [];
        for (const message of getContext().chat ?? []) {
            const active = getMessageCost(message);
            if (active) result.push(active);
            for (const info of message.swipe_info ?? []) {
                const value = info?.extra?.[MESSAGE_COST_KEY];
                if (value?.version === 1 && Array.isArray(value.requests)) result.push(value);
            }
        }
        // Body completion can precede MESSAGE_RECEIVED in non-streaming mode.
        for (const entry of entries.values()) if (entryIsCurrent(entry)) result.push({ requests: [...entry.previous, entry.request] });
        return result;
    }

    function needsRefresh(request) {
        if (request?.chatId !== liveChat() || typeof request.id !== 'string' || request.id.startsWith('pending-')
            || (request.record && request.record.status !== 'pending')) return false;
        // Streaming usage is normally returned only at completion; do not spend
        // the retry budget (or query a long ledger repeatedly) while generating.
        return ![...entries.values()].some(entry => entry.request.id === request.id && !entry.finished);
    }

    function recoverUnprepared() {
        let recovered = false;
        for (const snapshot of snapshots()) for (const request of snapshot.requests) {
            if (typeof request?.id === 'string' && request.id.startsWith('pending-') && request.status === 'pending') {
                request.status = 'unavailable';
                recovered = true;
            }
        }
        if (recovered) saveSoon(liveChat());
    }

    function scheduleRefresh(delay = retryMs) {
        if (destroyed || refreshTimer !== null) return;
        refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, delay);
    }

    async function refresh({ retry = false } = {}) {
        if (destroyed) return;
        if (retry) attempts = 0;
        const chatId = liveChat();
        if (!chatId || !snapshots().some(snapshot => snapshot.requests.some(needsRefresh))) return;
        if (inFlight?.chatId === chatId && inFlight.epoch === epoch) return inFlight.promise;
        const task = { chatId, epoch };
        task.promise = (async () => {
            let updated = false;
            try {
                const result = await serverClient.readUsage(chatId);
                if (destroyed || epoch !== task.epoch || liveChat() !== chatId) return;
                if (!result?.ok) throw new Error('Usage is unavailable');
                const records = new Map((result.records ?? []).filter(record => record.chatId === chatId).map(record => [record.id, record]));
                for (const snapshot of snapshots()) for (const request of snapshot.requests) {
                    if (!needsRefresh(request)) continue;
                    const record = records.get(request.id);
                    if (record && record.status !== 'pending') {
                        request.record = clone(record);
                        delete request.status;
                        updated = true;
                    }
                }
            } catch (error) {
                if (epoch === task.epoch) console.warn('[Vertex PayGo] Could not refresh message cost.', error);
            } finally {
                if (inFlight === task) inFlight = null;
                if (destroyed || epoch !== task.epoch || liveChat() !== chatId) return;
                attempts += 1;
                if (attempts >= maxRetries) {
                    for (const snapshot of snapshots()) for (const request of snapshot.requests) {
                        if (needsRefresh(request)) { request.status = 'unavailable'; updated = true; }
                    }
                } else if (snapshots().some(snapshot => snapshot.requests.some(needsRefresh))) scheduleRefresh();
                if (updated) { changed(); saveSoon(chatId); }
            }
        })();
        inFlight = task;
        return task.promise;
    }

    function listen(name, callback) {
        const event = initial.eventTypes?.[name];
        if (!event) return;
        initial.eventSource?.on(event, callback);
        listeners.push([event, callback]);
    }
    listen('GENERATION_AFTER_COMMANDS', (type, _options, dryRun) => {
        if (dryRun || !allowedTypes.has(type)) return;
        if (!generation || generation.closed || generation.epoch !== epoch || generation.chat !== getContext().chat) {
            generation = { epoch, chat: getContext().chat, session: idFactory(), closed: false };
            for (const [key, entry] of entries) if (!entry.message || entry.finished) entries.delete(key);
        }
        attempts = 0;
    });
    listen('MESSAGE_RECEIVED', (id, type) => { if (allowedTypes.has(type)) reconcile(Number(id)); });
    listen('CHARACTER_MESSAGE_RENDERED', (id, type) => {
        if (allowedTypes.has(type)) reconcile(Number(id));
        changed();
    });
    listen('STREAM_TOKEN_RECEIVED', () => reconcile());
    listen('GENERATION_STOPPED', () => { reconcile(); if (generation) generation.closed = true; changed(); });
    // ENDED may precede MESSAGE_RECEIVED. It must not clear correlation entries.
    listen('GENERATION_ENDED', () => { reconcile(); if (generation) generation.closed = true; changed(); });
    listen('MESSAGE_SWIPED', id => {
        const message = getContext().chat?.[Number(id)];
        if (message && message.swipe_id >= (message.swipes?.length ?? 0)) {
            if (message.extra) delete message.extra[MESSAGE_COST_KEY];
        }
        changed();
    });
    for (const name of ['MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED']) listen(name, changed);
    listen('CHAT_CHANGED', () => {
        epoch += 1;
        generation = null;
        entries.clear();
        clearTimeout(refreshTimer); refreshTimer = null;
        clearTimeout(saveTimer); saveTimer = null;
        attempts = 0;
        recoverUnprepared();
        changed();
        scheduleRefresh(0);
    });
    const Observer = documentRef?.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    const chatElement = documentRef?.getElementById?.('chat');
    const observer = Observer && chatElement ? new Observer(() => reconcile()) : null;
    observer?.observe(chatElement, { childList: true });
    recoverUnprepared();
    scheduleRefresh(0);

    return { capture, prepared, started, response, failed, refresh, reconcile, getMessageCost,
        destroy() {
            destroyed = true;
            epoch += 1;
            clearTimeout(refreshTimer);
            clearTimeout(saveTimer);
            observer?.disconnect();
            for (const [event, callback] of listeners) initial.eventSource?.removeListener?.(event, callback);
            entries.clear();
        },
    };
}
