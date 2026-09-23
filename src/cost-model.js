/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0.
 */

const PRICE_FIELDS = [
    'input', 'cachedInput', 'output', 'longContextThreshold',
    'longInput', 'longCachedInput', 'longOutput',
];

function finiteNonNegative(value) {
    if (value === '' || value === null || value === undefined) return undefined;
    if (typeof value === 'boolean') return undefined;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function priceKey({ source, model, tier } = {}) {
    return JSON.stringify([String(source ?? ''), String(model ?? ''), String(tier ?? '')]);
}

export function normalizePrice(price) {
    if (!price || typeof price !== 'object') return null;
    const normalized = {};
    for (const field of PRICE_FIELDS) {
        const supplied = price[field] !== '' && price[field] !== null && price[field] !== undefined;
        const value = finiteNonNegative(price[field]);
        if (supplied && value === undefined) return null;
        if (value !== undefined) normalized[field] = value;
    }
    if (!['input', 'cachedInput', 'output'].every(field => normalized[field] !== undefined)) return null;
    if (normalized.longContextThreshold !== undefined
        && (!Number.isSafeInteger(normalized.longContextThreshold) || normalized.longContextThreshold <= 0)) return null;
    const longFields = ['longInput', 'longCachedInput', 'longOutput'];
    const longCount = longFields.filter(field => normalized[field] !== undefined).length;
    if (longCount !== 0 && (longCount !== longFields.length || normalized.longContextThreshold === undefined)) return null;
    return normalized;
}

function tokenCount(usage, name) {
    const value = usage?.[name];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function hasUnsupportedModalities(usage) {
    const values = [];
    for (const [key, value] of Object.entries(usage ?? {})) {
        if (!/modalit/i.test(key)
            && !['promptTokensDetails', 'cacheTokensDetails', 'candidatesTokensDetails'].includes(key)) continue;
        if (value == null) continue;
        if (Array.isArray(value)) {
            for (const entry of value) {
                values.push(entry && typeof entry === 'object' && 'modality' in entry ? entry.modality : entry);
            }
        }
        else if (typeof value === 'object') values.push(...Object.keys(value));
        else values.push(value);
    }
    return values.some(value => !['text', 'TEXT'].includes(String(value)));
}

/** Estimate one request. Prices are USD per million tokens. */
export function estimateRecord(record, currentPrice = null) {
    const usage = record?.usage;
    if (!usage || typeof usage !== 'object') {
        return { status: 'unknown', amount: null, reason: 'usage_missing', priceSource: null };
    }
    if (String(usage.trafficType ?? '').toUpperCase() === 'PROVISIONED_THROUGHPUT') {
        return { status: 'unknown', amount: null, reason: 'provisioned_throughput', priceSource: null };
    }

    const prompt = tokenCount(usage, 'promptTokenCount');
    const cachedPresent = usage.cachedContentTokenCount !== undefined && usage.cachedContentTokenCount !== null;
    const cachedRaw = cachedPresent ? tokenCount(usage, 'cachedContentTokenCount') : 0;
    const candidates = tokenCount(usage, 'candidatesTokenCount');
    const thoughtsPresent = usage.thoughtsTokenCount !== undefined && usage.thoughtsTokenCount !== null;
    const thoughts = thoughtsPresent ? tokenCount(usage, 'thoughtsTokenCount') : 0;
    if (prompt === undefined || cachedRaw === undefined || candidates === undefined || thoughts === undefined) {
        return { status: 'unknown', amount: null, reason: 'usage_incomplete', priceSource: null };
    }
    if (cachedRaw > prompt) {
        return { status: 'unknown', amount: null, reason: 'cache_exceeds_prompt', priceSource: null };
    }
    const cached = cachedRaw;
    const traffic = String(usage.trafficType ?? '').toUpperCase();
    const trafficTier = traffic.includes('FLEX') ? 'flex'
        : traffic.includes('PRIORITY') ? 'priority'
            : ['ON_DEMAND', 'PAYGO', 'STANDARD'].includes(traffic) ? 'standard' : null;
    const fallbackAllowed = !trafficTier || trafficTier === record?.tier;
    if (!fallbackAllowed) {
        return {
            status: 'unknown', amount: null, reason: 'traffic_tier_mismatch', priceSource: null,
            tokens: { prompt, cached, candidates, thoughts },
        };
    }
    if (hasUnsupportedModalities(usage)) {
        return {
            status: 'unknown', amount: null, reason: 'unsupported_modality', priceSource: null,
            tokens: { prompt, cached, candidates, thoughts },
        };
    }
    const snapshot = normalizePrice(record?.price);
    const fallback = fallbackAllowed ? normalizePrice(currentPrice) : null;
    const price = snapshot ?? fallback;
    if (!price) {
        return {
            status: 'unpriced', amount: null,
            reason: 'price_missing', priceSource: null,
            tokens: { prompt, cached, candidates, thoughts },
        };
    }

    const exceedsLongThreshold = price.longContextThreshold !== undefined && prompt > price.longContextThreshold;
    const hasLongRates = ['longInput', 'longCachedInput', 'longOutput'].every(field => price[field] !== undefined);
    if (exceedsLongThreshold && !hasLongRates) {
        return {
            status: 'unpriced', amount: null, reason: 'long_price_missing',
            priceSource: snapshot ? 'snapshot' : 'current', tokens: { prompt, cached, candidates, thoughts },
        };
    }
    const long = exceedsLongThreshold;
    const rates = long
        ? { input: price.longInput, cachedInput: price.longCachedInput, output: price.longOutput }
        : price;
    const amount = ((prompt - cached) * rates.input
        + cached * rates.cachedInput
        + (candidates + thoughts) * rates.output) / 1_000_000;
    if (!Number.isFinite(amount)) return { status: 'unknown', amount: null, reason: 'amount_out_of_range', priceSource: null };
    const partialReasons = [];
    if (record?.usageAccuracy === 'tauri-normalized') partialReasons.push('tauri_normalized');
    if ((tokenCount(usage, 'toolUsePromptTokenCount') ?? 0) > 0) partialReasons.push('tool_use');
    if (record?.status !== 'complete') partialReasons.push(`request_${record?.status ?? 'unknown'}`);
    return {
        status: partialReasons.length ? 'partial' : 'estimated',
        amount,
        reason: partialReasons[0] ?? null,
        reasons: partialReasons,
        priceSource: snapshot ? 'snapshot' : 'current',
        longContext: long,
        tokens: { prompt, cached, candidates, thoughts },
    };
}

export function summarizeUsage(records, prices = {}) {
    const unique = new Map();
    for (const record of Array.isArray(records) ? records : []) {
        if (!record || typeof record !== 'object') continue;
        const id = String(record.id ?? '');
        if (!id || unique.has(id)) continue;
        unique.set(id, record);
    }
    const details = [];
    let amount = 0;
    let cachedTokenCount = 0;
    let unpricedCount = 0;
    let incompleteCount = 0;
    let estimatedCount = 0;
    for (const record of unique.values()) {
        const fallback = prices?.[priceKey(record)];
        const estimate = estimateRecord(record, fallback);
        details.push({ record, estimate });
        if (estimate.amount !== null) amount += estimate.amount;
        if (estimate.amount !== null) estimatedCount += 1;
        const cached = tokenCount(record.usage, 'cachedContentTokenCount');
        const prompt = tokenCount(record.usage, 'promptTokenCount');
        if (cached !== undefined && prompt !== undefined && cached <= prompt) cachedTokenCount += cached;
        if (estimate.status === 'unpriced') unpricedCount += 1;
        if (estimate.status === 'unknown' || estimate.status === 'partial' || record.status !== 'complete') incompleteCount += 1;
    }
    return { amount, estimatedCount, cachedTokenCount, unpricedCount, incompleteCount, requestCount: details.length, details };
}
