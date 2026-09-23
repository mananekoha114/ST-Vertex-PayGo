/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateRecord, normalizePrice, priceKey, summarizeUsage } from '../src/cost-model.js';

const price = { input: 2, cachedInput: .5, output: 10 };

test('price keys preserve source, model and tier without collisions', () => {
    assert.equal(priceKey({ source: 'vertexai', model: 'gemini', tier: 'flex' }), '["vertexai","gemini","flex"]');
    assert.notEqual(
        priceKey({ source: 'vertexai', model: 'gemini', tier: 'flex' }),
        priceKey({ source: 'vertexai', model: 'gemini', tier: 'standard' }),
    );
});

test('normalizes complete prices and rejects partial long-context schedules', () => {
    assert.deepEqual(normalizePrice({ input: '2', cachedInput: 0, output: 10 }), { input: 2, cachedInput: 0, output: 10 });
    assert.equal(normalizePrice({ input: 2, output: 10 }), null);
    assert.equal(normalizePrice({ ...price, longContextThreshold: 100, longInput: 4 }), null);
    assert.equal(normalizePrice({ ...price, longContextThreshold: 1.5 }), null);
    assert.equal(normalizePrice({ ...price, longContextThreshold: true }), null);
    assert.equal(normalizePrice({ ...price, longInput: 'bad' }), null);
    assert.deepEqual(normalizePrice({
        ...price, longContextThreshold: 100, longInput: 4, longCachedInput: 1, longOutput: 20,
    }), { ...price, longContextThreshold: 100, longInput: 4, longCachedInput: 1, longOutput: 20 });
});

test('computes uncached input once and includes thoughts in output', () => {
    const result = estimateRecord({
        status: 'complete', price,
        usage: { promptTokenCount: 100, cachedContentTokenCount: 80, candidatesTokenCount: 20, thoughtsTokenCount: 30 },
    });
    assert.equal(result.amount, (20 * 2 + 80 * .5 + 50 * 10) / 1_000_000);
    assert.deepEqual(result.tokens, { prompt: 100, cached: 80, candidates: 20, thoughts: 30 });
    assert.equal(result.status, 'estimated');
    assert.equal(result.priceSource, 'snapshot');
});

test('rejects cache overflow and non-integer or coerced token counts', () => {
    assert.equal(estimateRecord({ status: 'complete', price, usage: {
        promptTokenCount: 10, cachedContentTokenCount: 11, candidatesTokenCount: 1,
    } }).reason, 'cache_exceeds_prompt');
    for (const promptTokenCount of ['10', true, 1.5]) {
        assert.equal(estimateRecord({ status: 'complete', price, usage: {
            promptTokenCount, candidatesTokenCount: 1,
        } }).reason, 'usage_incomplete');
    }
});

test('uses long-context rates only beyond the configured threshold', () => {
    const longPrice = { ...price, longContextThreshold: 100, longInput: 4, longCachedInput: 1, longOutput: 20 };
    const result = estimateRecord({ status: 'complete', price: longPrice, usage: {
        promptTokenCount: 101, cachedContentTokenCount: 1, candidatesTokenCount: 10,
    } });
    assert.equal(result.longContext, true);
    assert.equal(result.amount, (100 * 4 + 1 + 10 * 20) / 1_000_000);
});

test('does not fall back to short-context rates above a configured threshold', () => {
    const result = estimateRecord({ status: 'complete', price: {
        ...price, longContextThreshold: 100,
    }, usage: { promptTokenCount: 101, candidatesTokenCount: 1 } });
    assert.equal(result.status, 'unpriced');
    assert.equal(result.reason, 'long_price_missing');
    assert.equal(result.amount, null);
});

test('never treats missing usage, missing prices or provisioned throughput as zero cost', () => {
    assert.deepEqual(estimateRecord({ status: 'failed', usage: null }), {
        status: 'unknown', amount: null, reason: 'usage_missing', priceSource: null,
    });
    assert.equal(estimateRecord({ status: 'complete', usage: { promptTokenCount: 1, candidatesTokenCount: 1 } }).status, 'unpriced');
    assert.equal(estimateRecord({ status: 'complete', price, usage: {
        promptTokenCount: 1, candidatesTokenCount: 1, trafficType: 'PROVISIONED_THROUGHPUT',
    } }).status, 'unknown');
});

test('marks interrupted tool-use requests as partial', () => {
    const result = estimateRecord({ status: 'incomplete', price, usage: {
        promptTokenCount: 10, candidatesTokenCount: 2, toolUsePromptTokenCount: 1,
    } });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.reasons, ['tool_use', 'request_incomplete']);
    assert.ok(result.amount > 0);
});

test('keeps Tauri normalized usage calculable but marks the estimate partial', () => {
    const result = estimateRecord({ status: 'complete', usageAccuracy: 'tauri-normalized', price, usage: {
        promptTokenCount: 10, candidatesTokenCount: 2,
    } });
    assert.equal(result.status, 'partial');
    assert.equal(result.reason, 'tauri_normalized');
    assert.ok(result.amount > 0);
});

test('Google modality detail arrays make non-text usage unknown', () => {
    const result = estimateRecord({ status: 'complete', price, usage: {
        promptTokenCount: 10, candidatesTokenCount: 2,
        promptTokensDetails: [{ modality: 'TEXT', tokenCount: 8 }, { modality: 'IMAGE', tokenCount: 2 }],
        cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 1 }],
        candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 2 }],
    } });
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'unsupported_modality');
    assert.equal(result.amount, null);
});

test('current prices can estimate old records but mismatched traffic tiers cannot', () => {
    const base = { source: 'vertexai', model: 'm', tier: 'standard', status: 'complete', usage: {
        promptTokenCount: 10, candidatesTokenCount: 2,
    } };
    assert.equal(estimateRecord(base, price).priceSource, 'current');
    assert.equal(estimateRecord({ ...base, tier: 'flex', usage: { ...base.usage, trafficType: 'ON_DEMAND' } }, price).reason, 'traffic_tier_mismatch');
    assert.equal(estimateRecord({ ...base, tier: 'flex', price, usage: { ...base.usage, trafficType: 'ON_DEMAND' } }).amount, null);
});

test('summary deduplicates record ids and counts unpriced and partial records', () => {
    const records = [
        { id: 'a', source: 'vertexai', model: 'm', tier: 'standard', status: 'complete', price, usage: { promptTokenCount: 10, cachedContentTokenCount: 3, candidatesTokenCount: 2 } },
        { id: 'a', source: 'vertexai', model: 'm', tier: 'standard', status: 'complete', price, usage: { promptTokenCount: 999, candidatesTokenCount: 999 } },
        { id: 'b', source: 'vertexai', model: 'x', tier: 'standard', status: 'pending', usage: { promptTokenCount: 5, candidatesTokenCount: 1 } },
    ];
    const result = summarizeUsage(records);
    assert.equal(result.requestCount, 2);
    assert.equal(result.cachedTokenCount, 3);
    assert.equal(result.unpricedCount, 1);
    assert.equal(result.incompleteCount, 1);
});
