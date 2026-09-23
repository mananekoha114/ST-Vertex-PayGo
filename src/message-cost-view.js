/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0.
 */

import { estimateRecord, priceKey } from './cost-model.js';
import { createLocalizer } from './i18n.js';

function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function milliseconds(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function uniqueRequests(snapshot) {
    const requests = new Map();
    let missingIdCount = 0;
    for (const request of Array.isArray(snapshot?.requests) ? snapshot.requests : []) {
        if (!request || typeof request !== 'object') continue;
        const id = String(request.id ?? '');
        if (!id) {
            requests.set(Symbol(), request);
            missingIdCount += 1;
        } else if (!requests.has(id)) requests.set(id, request);
    }
    return { requests: [...requests.values()], missingIdCount };
}

/** Build the display model for one assistant message and all of its continuations. */
export function summarizeMessageCost(snapshot, prices = {}) {
    const unique = uniqueRequests(snapshot);
    const { requests } = unique;
    const summary = {
        requestCount: requests.length,
        pricedRequestCount: 0,
        missingRequestCount: 0,
        pending: false,
        unavailable: false,
        partial: false,
        amount: 0,
        priceSource: null,
        promptTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cachedTokens: 0,
        uncachedTokens: 0,
        firstTokenMs: null,
        durationMs: null,
        generationTps: null,
        endToEndTps: null,
        models: [],
        tiers: [],
        reasons: [],
        awaitingPrice: false,
    };
    const models = new Set();
    const tiers = new Set();
    const reasons = new Set();
    let knownUsageCount = 0;
    let currentPriceUsed = false;
    let snapshotPriceUsed = false;
    let streamDuration = 0;
    let streamOutput = 0;
    let totalDuration = 0;
    let durationCount = 0;
    let streamTimingCount = 0;
    let firstTokenObserved = null;
    let thinkingUnknown = false;
    let cacheUnknown = false;

    for (let index = 0; index < requests.length; index += 1) {
        const request = requests[index];
        const record = request.record;
        const unavailable = request.status === 'unavailable';
        const pending = !unavailable && (request.status === 'pending' || record?.status === 'pending');
        summary.unavailable ||= unavailable;
        summary.pending ||= pending;
        if (unavailable) reasons.add('unavailable');
        else if (pending) reasons.add('pending');

        const duration = milliseconds(request.timing?.durationMs);
        const firstToken = milliseconds(request.timing?.firstTokenMs);
        if (duration !== null) {
            totalDuration += duration;
            durationCount += 1;
        } else {
            reasons.add('timing_missing');
        }
        if (request.timing?.stream === true && duration !== null && firstToken !== null && duration > firstToken) {
            streamDuration += duration - firstToken;
            streamTimingCount += 1;
            if (index === 0) firstTokenObserved = firstToken;
        } else if (request.timing?.stream === true) {
            reasons.add('timing_missing');
        }

        if (!record || typeof record !== 'object') {
            summary.missingRequestCount += 1;
            if (!pending && !unavailable) {
                summary.unavailable = true;
                reasons.add('usage_missing');
            }
            continue;
        }
        if (record.model) models.add(String(record.model));
        if (record.tier) tiers.add(String(record.tier));
        const estimate = estimateRecord(record, prices?.[priceKey(record)]);
        if (estimate.reason && !(pending && estimate.reason === 'usage_missing')) reasons.add(estimate.reason);
        for (const reason of estimate.reasons ?? []) reasons.add(reason);
        if (record.usageAccuracy === 'tauri-normalized') reasons.add('tauri_normalized');
        if (estimate.amount !== null) {
            summary.amount += estimate.amount;
            summary.pricedRequestCount += 1;
            currentPriceUsed ||= estimate.priceSource === 'current';
            snapshotPriceUsed ||= estimate.priceSource === 'snapshot';
        } else {
            summary.missingRequestCount += 1;
        }
        summary.partial ||= estimate.status === 'partial' || estimate.status === 'unknown'
            || estimate.status === 'unpriced' || record.status !== 'complete';

        const prompt = count(record.usage?.promptTokenCount);
        const output = count(record.usage?.candidatesTokenCount);
        // The native non-streaming adapter drops optional Gemini usage fields.
        // Absence in that normalized shape is not evidence of zero usage.
        if (record.usageAccuracy === 'tauri-normalized') {
            thinkingUnknown ||= record.usage?.thoughtsTokenCount == null;
            cacheUnknown ||= record.usage?.cachedContentTokenCount == null;
        }
        const thinking = record.usage?.thoughtsTokenCount == null ? 0 : count(record.usage.thoughtsTokenCount);
        const cached = record.usage?.cachedContentTokenCount == null ? 0 : count(record.usage.cachedContentTokenCount);
        if (prompt === null || output === null || thinking === null || cached === null || cached > prompt) {
            summary.partial = true;
            continue;
        }
        knownUsageCount += 1;
        summary.promptTokens += prompt;
        summary.outputTokens += output;
        summary.thinkingTokens += thinking;
        summary.cachedTokens += cached;
        summary.uncachedTokens += prompt - cached;

        if (request.timing?.stream === true && duration !== null && firstToken !== null && duration > firstToken) {
            streamOutput += output + thinking;
        }
    }

    summary.models = [...models];
    summary.tiers = [...tiers];
    summary.firstTokenMs = firstTokenObserved;
    summary.durationMs = requests.length > 0 && durationCount === requests.length ? totalDuration : null;
    summary.generationTps = !thinkingUnknown && requests.length > 0 && streamTimingCount === requests.length && knownUsageCount === requests.length
        ? streamOutput / (streamDuration / 1000) : null;
    summary.endToEndTps = !thinkingUnknown && summary.durationMs > 0 && knownUsageCount === requests.length
        ? (summary.outputTokens + summary.thinkingTokens) / (summary.durationMs / 1000) : null;
    if (thinkingUnknown) summary.thinkingTokens = null;
    if (cacheUnknown) summary.cachedTokens = summary.uncachedTokens = null;
    summary.partial ||= summary.pending || summary.unavailable || unique.missingIdCount > 0
        || summary.missingRequestCount > 0 || knownUsageCount < requests.length;
    summary.complete = requests.length > 0 && !summary.pending && !summary.unavailable && !summary.partial;
    summary.hasAmount = summary.pricedRequestCount > 0;
    summary.hasUsage = knownUsageCount > 0;
    summary.awaitingPrice = !summary.hasAmount && summary.hasUsage
        && [...reasons].some(reason => reason === 'price_missing' || reason === 'long_price_missing')
        && ![...reasons].some(reason => !['price_missing', 'long_price_missing', 'timing_missing', 'tauri_normalized'].includes(reason));
    summary.reasons = [...reasons];
    summary.priceSource = currentPriceUsed ? (snapshotPriceUsed ? 'mixed' : 'current')
        : snapshotPriceUsed ? 'snapshot' : null;
    return summary;
}

export function formatMessageMoney(amount) {
    return amount > 0 && amount < .00001 ? '< $0.00001' : `$${amount.toFixed(5)}`;
}

export function formatMessageCostLabel(summary, localize = createLocalizer()) {
    const key = 'vertex_paygo.message_cost.';
    if (summary?.hasAmount) return localize(`${key}${summary.partial ? 'label_partial' : 'label_amount'}`, {
        amount: formatMessageMoney(summary.amount),
    });
    if (summary?.pending) return localize(`${key}label_pending`);
    if (summary?.awaitingPrice) return localize(`${key}label_unpriced`);
    return localize(`${key}label_unknown`);
}
