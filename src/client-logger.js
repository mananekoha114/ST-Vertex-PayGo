/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

const LOG_LEVELS = new Set(['info', 'warn', 'error']);
const EVENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const MODEL_PATTERN = IDENTIFIER_PATTERN;
const REGION_PATTERN = /^(?:global|[a-z0-9][a-z0-9-]{0,62})$/u;
const MAX_PENDING_ENTRIES = 100;

const STRING_CONTEXT_PATTERNS = Object.freeze({
    clientVersion: CODE_PATTERN,
    phase: CODE_PATTERN,
    errorCode: ERROR_CODE_PATTERN,
    model: MODEL_PATTERN,
    provider: /^(?:vertexai|makersuite)$/u,
    tier: /^(?:standard|flex|priority)$/u,
    region: REGION_PATTERN,
    serverStatus: CODE_PATTERN,
    supportLevel: CODE_PATTERN,
    component: CODE_PATTERN,
    result: CODE_PATTERN,
    requestId: IDENTIFIER_PATTERN,
    clientSessionId: IDENTIFIER_PATTERN,
});

const BOOLEAN_CONTEXT_KEYS = new Set(['stream', 'paygoOnly', 'online']);
const INTEGER_CONTEXT_KEYS = new Set(['protocolVersion', 'statusCode', 'durationMs']);

function normalizeString(value, pattern) {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return pattern.test(normalized) ? normalized : undefined;
}

function normalizeInteger(value, key) {
    if (!Number.isSafeInteger(value) || value < 0) return undefined;
    if (key === 'statusCode' && (value < 100 || value > 599)) return undefined;
    if (key === 'durationMs' && value > 86_400_000) return undefined;
    return value;
}

export function normalizeClientLogContext(context = {}) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) return {};

    const normalized = {};
    for (const [key, value] of Object.entries(context)) {
        const pattern = STRING_CONTEXT_PATTERNS[key];
        if (pattern) {
            const stringValue = normalizeString(value, pattern);
            if (stringValue !== undefined) normalized[key] = stringValue;
            continue;
        }
        if (BOOLEAN_CONTEXT_KEYS.has(key)) {
            if (typeof value === 'boolean') normalized[key] = value;
            continue;
        }
        if (INTEGER_CONTEXT_KEYS.has(key)) {
            const integerValue = normalizeInteger(value, key);
            if (integerValue !== undefined) normalized[key] = integerValue;
        }
    }
    return normalized;
}

export function normalizeClientLogEntry(level, event, context = {}) {
    if (!LOG_LEVELS.has(level) || typeof event !== 'string' || !EVENT_PATTERN.test(event)) {
        return null;
    }
    const normalizedContext = normalizeClientLogContext(context);
    return Object.keys(normalizedContext).length > 0
        ? { level, event, context: normalizedContext }
        : { level, event };
}

export function getSafeErrorContext(error) {
    const context = {};
    const errorCode = normalizeString(error?.code ?? error?.name, CODE_PATTERN);
    if (errorCode) context.errorCode = errorCode;
    const statusCode = normalizeInteger(error?.status, 'statusCode');
    if (statusCode !== undefined) context.statusCode = statusCode;
    return context;
}

function createIdentifier(prefix, randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
    try {
        const value = typeof randomUUID === 'function' ? randomUUID() : '';
        const identifier = normalizeString(value, IDENTIFIER_PATTERN);
        if (identifier) return identifier;
    } catch {
        // Fall through to a local, non-secret correlation identifier.
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function createClientLogger({
    sendEntry = async () => {},
    consoleImpl = console,
    clientVersion,
    protocolVersion,
    sessionId = createIdentifier('session'),
    maxPendingEntries = MAX_PENDING_ENTRIES,
    randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
    deliveryEnabled = true,
} = {}) {
    const baseContext = normalizeClientLogContext({
        clientVersion,
        protocolVersion,
        clientSessionId: sessionId,
    });
    const boundedPendingEntries = Number.isSafeInteger(maxPendingEntries) && maxPendingEntries > 0
        ? maxPendingEntries
        : MAX_PENDING_ENTRIES;
    const pendingEntries = [];
    let delivery = null;
    let deliveryState = deliveryEnabled ? 'enabled' : 'pending';

    function mirror(level, args) {
        try {
            const method = consoleImpl?.[level];
            if (typeof method === 'function') method.apply(consoleImpl, args);
        } catch {
            // Logging must never affect the extension's control flow.
        }
    }

    function drain() {
        if (deliveryState !== 'enabled') return Promise.resolve();
        if (delivery) return delivery;
        let failed = false;
        delivery = (async () => {
            while (pendingEntries.length > 0) {
                const entry = pendingEntries[0];
                try {
                    await sendEntry(entry);
                } catch {
                    // Retain the failed entry. A later event or flush() retries it.
                    failed = true;
                    break;
                }
                if (pendingEntries[0] === entry) pendingEntries.shift();
            }
        })()
            .catch(() => undefined)
            .finally(() => {
                delivery = null;
                if (!failed && pendingEntries.length > 0) void drain();
            });
        return delivery;
    }

    function event(level, eventName, context = {}) {
        let entry;
        try {
            entry = normalizeClientLogEntry(level, eventName, { ...context, ...baseContext });
        } catch {
            return null;
        }
        if (!entry || deliveryState === 'disabled' || pendingEntries.length >= boundedPendingEntries) return entry;

        pendingEntries.push(entry);
        if (deliveryState === 'enabled') void drain();
        return entry;
    }

    return Object.freeze({
        event,
        debug: (...args) => mirror('debug', args),
        info: (...args) => mirror('info', args),
        warn: (...args) => mirror('warn', args),
        error: (...args) => mirror('error', args),
        createRequestId: () => createIdentifier('request', randomUUID),
        setDeliveryEnabled: enabled => {
            deliveryState = enabled === true ? 'enabled' : 'disabled';
            if (deliveryState === 'disabled') {
                pendingEntries.length = 0;
            } else {
                void drain();
            }
        },
        flush: async () => {
            try {
                await drain();
            } catch {
                // drain() is defensive, but flush must remain non-throwing.
            }
        },
        getPendingCount: () => pendingEntries.length,
        sessionId: baseContext.clientSessionId,
    });
}
