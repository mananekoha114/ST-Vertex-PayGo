/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMessageCostLabel as formatLabel, summarizeMessageCost } from '../src/message-cost-view.js';
import { readFile } from 'node:fs/promises';
import { createLocalizer } from '../src/i18n.js';

const chinese = JSON.parse(await readFile(new URL('../locales/zh-cn.json', import.meta.url), 'utf8'));
const localize = createLocalizer((fallback, key) => chinese[key] ?? fallback);
const formatMessageCostLabel = summary => formatLabel(summary, localize);

test('message labels use English fallback and editable templates with reordered placeholders', () => {
    assert.equal(formatLabel({ pending: true }), 'Estimating cost');
    assert.equal(formatLabel({ awaitingPrice: true }), 'Price needed');
    assert.equal(formatLabel({}), 'Cost unknown');
    const custom = createLocalizer((fallback, key) => key.endsWith('.label_partial') ? '{amount} (custom partial)' : fallback);
    assert.equal(formatLabel({ hasAmount: true, partial: true, amount: .5 }, custom), '$0.50000 (custom partial)');
});

const complete = (id, overrides = {}) => ({
    id, chatId: 'chat', source: 'vertexai', model: 'gemini-test', tier: 'standard', status: 'complete',
    price: { input: 1, cachedInput: .1, output: 2 },
    usage: { promptTokenCount: 1_000, cachedContentTokenCount: 200, candidatesTokenCount: 100, thoughtsTokenCount: 50 },
    ...overrides,
});

test('native normalized usage preserves known counts without inventing reasoning or cache totals', () => {
    const request = { id: 'native', record: complete('native', {
        usageAccuracy: 'tauri-normalized', usage: { promptTokenCount: 100, candidatesTokenCount: 20 },
    }), timing: { stream: false, durationMs: 1000 } };
    const result = summarizeMessageCost({ requests: [request] });
    assert.equal(result.partial, true);
    assert.equal(result.hasAmount, true);
    assert.equal(result.promptTokens, 100);
    assert.equal(result.outputTokens, 20);
    assert.equal(result.thinkingTokens, null);
    assert.equal(result.cachedTokens, null);
    assert.equal(result.cacheHitRate, null);
    assert.equal(result.uncachedTokens, null);
    assert.equal(result.endToEndTps, null);
    assert.ok(result.reasons.includes('tauri_normalized'));
    request.record.usage.cachedContentTokenCount = 30;
    const cached = summarizeMessageCost({ requests: [request] });
    assert.equal(cached.cachedTokens, 30);
    assert.equal(cached.uncachedTokens, 70);
    assert.equal(cached.cacheHitRate, .3);
    request.record.price = null;
    assert.equal(summarizeMessageCost({ requests: [request] }).awaitingPrice, true);
});

test('zero-duration observations never show Infinity TPS', () => {
    const result = summarizeMessageCost({ version: 1, requests: [{ id: 'instant', record: complete('instant'),
        timing: { durationMs: 0, firstTokenMs: 0, stream: true } }] });
    assert.equal(result.durationMs, 0);
    assert.equal(result.endToEndTps, null);
    assert.equal(result.generationTps, null);
});

test('a positive sub-precision cost is not formatted as a free request', () => {
    const summary = summarizeMessageCost({ version: 1, requests: [{ id: 'tiny', record: complete('tiny', {
        usage: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }) }] });
    assert.equal(summary.amount, .000003);
    assert.equal(formatMessageCostLabel(summary), '≈ < $0.00001');
});

test('deduplicates continuation requests and aggregates cost, usage, models and timing', () => {
    const first = { id: 'a', record: complete('a'), timing: { stream: true, durationMs: 2_000, firstTokenMs: 500 } };
    const summary = summarizeMessageCost({ version: 1, requests: [first, first, {
        id: 'b',
        record: complete('b', {
            model: 'gemini-next', tier: 'flex',
            usage: { promptTokenCount: 500, candidatesTokenCount: 50 },
        }),
        timing: { stream: true, durationMs: 1_000, firstTokenMs: 250 },
    }] });
    assert.equal(summary.requestCount, 2);
    assert.equal(summary.amount, .00112 + .0006);
    assert.equal(summary.promptTokens, 1_500);
    assert.equal(summary.outputTokens, 150);
    assert.equal(summary.thinkingTokens, 50);
    assert.equal(summary.cachedTokens, 200);
    assert.equal(summary.cacheHitRate, 200 / 1_500);
    assert.equal(summary.uncachedTokens, 1_300);
    assert.deepEqual(summary.models, ['gemini-test', 'gemini-next']);
    assert.deepEqual(summary.tiers, ['standard', 'flex']);
    assert.equal(summary.firstTokenMs, 500);
    assert.equal(summary.durationMs, 3_000);
    assert.equal(summary.generationTps, 200 / 2.25);
    assert.equal(summary.endToEndTps, 200 / 3);
    assert.equal(summary.complete, true);
    assert.equal(formatMessageCostLabel(summary), '≈ $0.00172');
});

test('keeps a partial subtotal and labels current-price backfill without treating missing requests as zero', () => {
    const summary = summarizeMessageCost({ version: 1, requests: [{
        id: 'known', record: complete('known', { price: null }), timing: { durationMs: 2_000, stream: false },
    }, { id: 'pending', status: 'pending' }, { id: 'lost', status: 'unavailable' }] }, {
        '["vertexai","gemini-test","standard"]': { input: 1, cachedInput: .1, output: 2 },
    });
    assert.equal(summary.hasAmount, true);
    assert.equal(summary.amount, .00112);
    assert.equal(summary.priceSource, 'current');
    assert.equal(summary.pending, true);
    assert.equal(summary.unavailable, true);
    assert.equal(summary.partial, true);
    assert.equal(summary.missingRequestCount, 2);
    assert.equal(summary.cacheHitRate, null);
    assert.equal(summary.generationTps, null);
    assert.equal(summary.firstTokenMs, null);
    assert.equal(summary.durationMs, null);
    assert.equal(summary.endToEndTps, null);
    assert.equal(formatMessageCostLabel(summary), localize('vertex_paygo.message_cost.label_partial', { amount: '$0.00112' }));
});

test('missing required usage or price produces an unknown amount rather than $0', () => {
    const incomplete = summarizeMessageCost({ requests: [{ id: 'x', record: complete('x', {
        price: null, usage: { cachedContentTokenCount: 0, thoughtsTokenCount: 4 },
    }) }] });
    assert.equal(incomplete.hasAmount, false);
    assert.equal(incomplete.hasUsage, false);
    assert.equal(incomplete.amount, 0);
    assert.equal(formatMessageCostLabel(incomplete), localize('vertex_paygo.message_cost.label_unknown'));

    const pending = summarizeMessageCost({ requests: [{ id: 'x', status: 'pending' }] });
    assert.equal(formatMessageCostLabel(pending), localize('vertex_paygo.message_cost.label_pending'));
});

test('a request without an id is included but can never make the summary look complete', () => {
    const summary = summarizeMessageCost({ requests: [{ record: complete('record-only') }] });
    assert.equal(summary.requestCount, 1);
    assert.equal(summary.hasAmount, true);
    assert.equal(summary.partial, true);
    assert.equal(summary.complete, false);
    assert.equal(formatMessageCostLabel(summary), localize('vertex_paygo.message_cost.label_partial', { amount: '$0.00112' }));
});

test('recognizes prepared record placeholders and lets unavailable override their pending status', () => {
    const placeholder = complete('pending', { status: 'pending', usage: null });
    const pending = summarizeMessageCost({ requests: [{ id: 'pending', record: placeholder, status: 'pending' }] });
    assert.equal(pending.pending, true);
    assert.equal(pending.unavailable, false);
    assert.equal(formatMessageCostLabel(pending), localize('vertex_paygo.message_cost.label_pending'));

    const unavailable = summarizeMessageCost({ requests: [{ id: 'pending', record: placeholder, status: 'unavailable' }] });
    assert.equal(unavailable.pending, false);
    assert.equal(unavailable.unavailable, true);
    assert.equal(formatMessageCostLabel(unavailable), localize('vertex_paygo.message_cost.label_unknown'));
    assert.ok(unavailable.reasons.includes('unavailable'));
});

test('reports awaiting price separately and keeps timing independent from missing usage', () => {
    const unpriced = summarizeMessageCost({ requests: [{
        id: 'unpriced', record: complete('unpriced', { price: null }), timing: { durationMs: 800, stream: false },
    }] });
    assert.equal(unpriced.awaitingPrice, true);
    assert.equal(formatMessageCostLabel(unpriced), localize('vertex_paygo.message_cost.label_unpriced'));
    assert.ok(unpriced.reasons.includes('price_missing'));

    const timedWithoutUsage = summarizeMessageCost({ requests: [{
        id: 'timed', status: 'unavailable', record: complete('timed', { status: 'incomplete', usage: null }),
        timing: { durationMs: 1_250, stream: false },
    }] });
    assert.equal(timedWithoutUsage.hasUsage, false);
    assert.equal(timedWithoutUsage.durationMs, 1_250);
    assert.equal(timedWithoutUsage.endToEndTps, null);

    const incompleteTiming = summarizeMessageCost({ requests: [
        { id: 'a', record: complete('a'), timing: { durationMs: 500, stream: false } },
        { id: 'b', record: complete('b') },
    ] });
    assert.equal(incompleteTiming.durationMs, null);
    assert.equal(incompleteTiming.endToEndTps, null);
    assert.ok(incompleteTiming.reasons.includes('timing_missing'));
});
