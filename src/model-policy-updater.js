/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
    BUNDLED_MODEL_POLICY,
    MODEL_POLICY_SNAPSHOT,
    getActiveModelPolicy,
    installModelPolicy,
    normalizeModelId,
} from './model-policy.js';
import { normalizePrice, priceKey } from './cost-model.js';

export const MODEL_POLICY_SCHEMA_VERSION = 1;
export const MODEL_POLICY_GITHUB_URL =
    'https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/data/model-support.json';
export const MODEL_POLICY_CACHE_KEY = 'vertex-paygo.model-policy.v1';
export const MODEL_POLICY_FETCH_TIMEOUT_MS = 5_000;
export const MODEL_POLICY_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const MODEL_POLICY_MAX_FUTURE_SKEW_MS = 7 * 24 * 60 * 60 * 1_000;

const MAX_POLICY_BYTES = 64 * 1024;
const MAX_MODELS_PER_TIER = 256;
const MODEL_ID_PATTERN = /^gemini-[a-z0-9][a-z0-9._-]{0,127}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export class ModelPolicyUpdateError extends Error {
    constructor(code, message, options = undefined) {
        super(message, options);
        this.name = 'ModelPolicyUpdateError';
        this.code = code;
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCalendarDate(value) {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

function normalizeModelList(value, name, { allowEmpty = false } = {}) {
    const minimum = allowEmpty ? 0 : 1;
    if (!Array.isArray(value) || value.length < minimum || value.length > MAX_MODELS_PER_TIER) {
        throw new ModelPolicyUpdateError(
            'INVALID_MODELS',
            `${name} must contain between ${minimum} and ${MAX_MODELS_PER_TIER} model IDs.`,
        );
    }

    const models = value.map(model => {
        if (typeof model !== 'string') {
            throw new ModelPolicyUpdateError('INVALID_MODEL_ID', `${name} contains a non-string model ID.`);
        }
        const normalized = normalizeModelId(model);
        if (!MODEL_ID_PATTERN.test(normalized)) {
            throw new ModelPolicyUpdateError('INVALID_MODEL_ID', `${name} contains an invalid Gemini model ID.`);
        }
        return normalized;
    });

    if (new Set(models).size !== models.length) {
        throw new ModelPolicyUpdateError('DUPLICATE_MODEL_ID', `${name} contains duplicate model IDs.`);
    }
    return Object.freeze(models);
}

function parseProviderPolicy(document, tierNames, { allowEmptyTiers = false } = {}) {
    if (!isPlainObject(document)) {
        throw new ModelPolicyUpdateError('INVALID_DOCUMENT', 'Model policy must be a JSON object.');
    }
    if (!isCalendarDate(document.updatedAt)) {
        throw new ModelPolicyUpdateError('INVALID_DATE', 'Model policy updatedAt must be a valid YYYY-MM-DD date.');
    }
    if (!isPlainObject(document.tiers)) {
        throw new ModelPolicyUpdateError('INVALID_TIERS', 'Model policy tiers must be a JSON object.');
    }

    const knownModels = normalizeModelList(document.knownModels, 'knownModels');
    const tiers = Object.fromEntries(tierNames.map(tier => [
        tier, normalizeModelList(document.tiers[tier], tier, { allowEmpty: allowEmptyTiers }),
    ]));
    const knownModelSet = new Set(knownModels);
    if (Object.values(tiers).flat().some(model => !knownModelSet.has(model))) {
        throw new ModelPolicyUpdateError(
            'INCOMPLETE_KNOWN_MODELS',
            'Every tier model must also be present in knownModels.',
        );
    }

    return Object.freeze({
        updatedAt: document.updatedAt,
        tiers: Object.freeze(tiers),
        knownModels,
    });
}

export function parseModelPolicyDocument(document) {
    if (!isPlainObject(document)) {
        throw new ModelPolicyUpdateError('INVALID_DOCUMENT', 'Model policy must be a JSON object.');
    }
    if (document.schemaVersion !== MODEL_POLICY_SCHEMA_VERSION) {
        throw new ModelPolicyUpdateError(
            'UNSUPPORTED_SCHEMA',
            `Model policy schema v${MODEL_POLICY_SCHEMA_VERSION} is required.`,
        );
    }
    return Object.freeze({
        schemaVersion: MODEL_POLICY_SCHEMA_VERSION,
        ...parseProviderPolicy(document, ['flex', 'priority']),
        ...(Object.hasOwn(document, 'aiStudio') ? {
            aiStudio: parseProviderPolicy(document.aiStudio, ['flex'], { allowEmptyTiers: true }),
        } : {}),
        ...(Object.hasOwn(document, 'pricing') ? { pricing: parsePricing(document.pricing) } : {}),
    });
}

function parsePricing(pricing) {
    const invalid = () => { throw new ModelPolicyUpdateError('INVALID_PRICING', 'Invalid USD text token pricing catalog.'); };
    if (!isPlainObject(pricing) || !isCalendarDate(pricing.updatedAt)
        || pricing.currency !== 'USD' || pricing.unit !== 'per_million_tokens'
        || !Array.isArray(pricing.entries) || pricing.entries.length > 256) invalid();
    const keys = new Set();
    const rateFields = ['input', 'cachedInput', 'output', 'longContextThreshold', 'longInput', 'longCachedInput', 'longOutput'];
    const entries = pricing.entries.map(entry => {
        if (!isPlainObject(entry) || !['vertexai', 'makersuite'].includes(entry.source)
            || !['standard', 'flex', 'priority'].includes(entry.tier)
            || typeof entry.model !== 'string' || !MODEL_ID_PATTERN.test(entry.model)
            || rateFields.some(field => Object.hasOwn(entry, field) && typeof entry[field] !== 'number')) invalid();
        const rate = normalizePrice(entry);
        if (!rate) invalid();
        if (Object.hasOwn(entry, 'validUntil') && (!isCalendarDate(entry.validUntil) || entry.validUntil < pricing.updatedAt)) invalid();
        let url;
        try { url = new URL(entry.sourceUrl); } catch { invalid(); }
        if (url.protocol !== 'https:' || url.username || url.password || url.port
            || !['ai.google.dev', 'cloud.google.com', 'docs.cloud.google.com'].includes(url.hostname)) invalid();
        const key = priceKey(entry);
        if (keys.has(key)) invalid();
        keys.add(key);
        return Object.freeze({ source: entry.source, model: entry.model, tier: entry.tier,
            ...rate, ...(entry.validUntil ? { validUntil: entry.validUntil } : {}), sourceUrl: entry.sourceUrl });
    });
    return Object.freeze({ updatedAt: pricing.updatedAt, currency: 'USD', unit: 'per_million_tokens', entries: Object.freeze(entries) });
}

function getUtf8Size(text) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength;
    return text.length;
}

function parseModelPolicyText(text) {
    if (typeof text !== 'string' || text.length === 0 || getUtf8Size(text) > MAX_POLICY_BYTES) {
        throw new ModelPolicyUpdateError('INVALID_SIZE', 'Model policy response has an invalid size.');
    }
    try {
        return parseModelPolicyDocument(JSON.parse(text));
    } catch (error) {
        if (error instanceof ModelPolicyUpdateError) throw error;
        throw new ModelPolicyUpdateError('INVALID_JSON', 'Model policy response is not valid JSON.', { cause: error });
    }
}

function requireCurrentOrNewerProviderPolicy(policy, active, now) {
    const updatedAt = Date.parse(`${policy.updatedAt}T00:00:00.000Z`);
    if (updatedAt > now + MODEL_POLICY_MAX_FUTURE_SKEW_MS) {
        throw new ModelPolicyUpdateError(
            'FUTURE_POLICY',
            `Model policy ${policy.updatedAt} is too far in the future.`,
        );
    }
    if (policy.updatedAt < active.updatedAt) {
        throw new ModelPolicyUpdateError(
            'STALE_POLICY',
            `Model policy ${policy.updatedAt} is older than the active ${active.updatedAt} snapshot.`,
        );
    }
    const nextKnownModels = new Set(policy.knownModels);
    if (active.knownModels.some(model => !nextKnownModels.has(model))) {
        throw new ModelPolicyUpdateError(
            'INCOMPLETE_MODEL_HISTORY',
            'Model policy knownModels must retain every model from the active snapshot.',
        );
    }
}

function requireCurrentOrNewerPolicy(policy, now) {
    const active = getActiveModelPolicy();
    requireCurrentOrNewerProviderPolicy(policy, active, now);
    if (policy.aiStudio) {
        requireCurrentOrNewerProviderPolicy(policy.aiStudio, active.aiStudio, now);
    }
    if (policy.pricing) {
        if (Date.parse(`${policy.pricing.updatedAt}T00:00:00.000Z`) > now + MODEL_POLICY_MAX_FUTURE_SKEW_MS) {
            throw new ModelPolicyUpdateError('FUTURE_PRICING', 'Pricing catalog is too far in the future.');
        }
        if (policy.pricing.updatedAt < active.pricing.updatedAt) {
            throw new ModelPolicyUpdateError('STALE_PRICING', 'Pricing catalog is older than the active snapshot.');
        }
    }
    return policy;
}

function getContentLength(response) {
    try {
        const value = response?.headers?.get?.('content-length');
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    } catch {
        return null;
    }
}

async function readPolicyResponse(response) {
    const contentLength = getContentLength(response);
    if (contentLength !== null && contentLength > MAX_POLICY_BYTES) {
        throw new ModelPolicyUpdateError('INVALID_SIZE', 'Model policy response exceeds the size limit.');
    }

    if (typeof TextDecoder !== 'function' || typeof response?.body?.getReader !== 'function') {
        return await response.text();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let receivedBytes = 0;
    let text = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
            throw new ModelPolicyUpdateError('INVALID_BODY', 'Model policy response body is not a byte stream.');
        }
        receivedBytes += value.byteLength;
        if (receivedBytes > MAX_POLICY_BYTES) {
            try {
                await reader.cancel();
            } catch {
                // The size error remains authoritative if cancellation fails.
            }
            throw new ModelPolicyUpdateError('INVALID_SIZE', 'Model policy response exceeds the size limit.');
        }
        text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
}

function resolveStorage(storage) {
    if (storage !== undefined) return storage;
    try {
        return globalThis.localStorage;
    } catch {
        return null;
    }
}

function warn(logger, message, error) {
    if (typeof logger?.warn === 'function') logger.warn(message, error);
}

function haveSameMembers(left, right) {
    if (left.length !== right.length) return false;
    const rightSet = new Set(right);
    return left.every(value => rightSet.has(value));
}

function hasProviderPolicyChanged(policy, active) {
    return policy.updatedAt !== active.updatedAt
        || Object.keys(active.tiers).some(tier => !haveSameMembers(policy.tiers[tier], active.tiers[tier]))
        || !haveSameMembers(policy.knownModels, active.knownModels);
}

function installModelPolicyIfChanged(policy) {
    const active = getActiveModelPolicy();
    const changed = hasProviderPolicyChanged(policy, active)
        || Boolean(policy.aiStudio && hasProviderPolicyChanged(policy.aiStudio, active.aiStudio))
        || Boolean(policy.pricing && JSON.stringify(policy.pricing) !== JSON.stringify(active.pricing));
    if (changed) installModelPolicy(policy);
    return changed;
}

export function restoreCachedModelPolicy({ storage = undefined, logger = console, now = Date.now() } = {}) {
    const resolvedStorage = resolveStorage(storage);
    if (typeof resolvedStorage?.getItem !== 'function') {
        return { applied: false, source: 'bundled', snapshot: MODEL_POLICY_SNAPSHOT };
    }

    try {
        const cached = resolvedStorage.getItem(MODEL_POLICY_CACHE_KEY);
        if (cached === null) {
            return { applied: false, source: 'bundled', snapshot: MODEL_POLICY_SNAPSHOT };
        }
        const policy = requireCurrentOrNewerPolicy(parseModelPolicyText(cached), now);
        const changed = installModelPolicyIfChanged(policy);
        return { applied: true, changed, source: 'cache', snapshot: policy.updatedAt, pricingSnapshot: getActiveModelPolicy().pricing.updatedAt };
    } catch (error) {
        warn(logger, '[Vertex PayGo] Ignoring invalid cached model policy.', error);
        return { applied: false, source: 'bundled', snapshot: MODEL_POLICY_SNAPSHOT, error };
    }
}

function cachePolicy(policy, storage, logger) {
    const resolvedStorage = resolveStorage(storage);
    if (typeof resolvedStorage?.setItem !== 'function') return;
    try {
        resolvedStorage.setItem(MODEL_POLICY_CACHE_KEY, JSON.stringify(policy));
    } catch (error) {
        warn(logger, '[Vertex PayGo] Could not cache the GitHub model policy.', error);
    }
}

export async function refreshModelPolicyFromGitHub({
    fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined,
    storage = undefined,
    logger = console,
    url = MODEL_POLICY_GITHUB_URL,
    timeoutMs = MODEL_POLICY_FETCH_TIMEOUT_MS,
    now = Date.now(),
} = {}) {
    if (typeof fetchImpl !== 'function') {
        const error = new ModelPolicyUpdateError('FETCH_UNAVAILABLE', 'Fetch API is unavailable.');
        warn(logger, '[Vertex PayGo] Could not refresh the model policy from GitHub.', error);
        return { applied: false, source: 'active', snapshot: MODEL_POLICY_SNAPSHOT, error };
    }

    let timeout;
    try {
        if (typeof globalThis.AbortController !== 'function') {
            throw new ModelPolicyUpdateError('ABORT_UNAVAILABLE', 'AbortController API is unavailable.');
        }
        const abortController = new AbortController();
        timeout = setTimeout(() => abortController.abort(), timeoutMs);
        const response = await fetchImpl(url, {
            cache: 'no-store',
            credentials: 'omit',
            headers: { Accept: 'application/json' },
            referrerPolicy: 'no-referrer',
            signal: abortController.signal,
        });
        if (!response?.ok) {
            throw new ModelPolicyUpdateError(
                'HTTP_ERROR',
                `GitHub model policy request failed with HTTP ${response?.status ?? 'unknown'}.`,
            );
        }
        const policy = requireCurrentOrNewerPolicy(parseModelPolicyText(await readPolicyResponse(response)), now);
        const changed = installModelPolicyIfChanged(policy);
        // Cache the effective document, retaining AI Studio and prices when
        // an older publisher omits either optional section.
        cachePolicy(getActiveModelPolicy(), storage, logger);
        return { applied: true, changed, source: 'github', snapshot: policy.updatedAt, pricingSnapshot: getActiveModelPolicy().pricing.updatedAt };
    } catch (error) {
        warn(logger, '[Vertex PayGo] Could not refresh the model policy from GitHub; keeping the active snapshot.', error);
        return { applied: false, source: 'active', snapshot: MODEL_POLICY_SNAPSHOT, error };
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
}

export function restoreBundledModelPolicy() {
    installModelPolicy(BUNDLED_MODEL_POLICY);
}
