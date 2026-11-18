/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { BUNDLED_MODEL_POLICY } from '../src/model-policy.js';
import { parseModelPolicyDocument } from '../src/model-policy-updater.js';
import { createCostContext } from '../src/cost-context.js';
import { lookupPrice, priceKey, regionalPriceKey, summarizeUsage } from '../src/cost-model.js';
import { summarizeMessageCost } from '../src/message-cost-view.js';
import { installRequestTransport } from '../src/request-transport.js';
import { installTauriTransport } from '../src/tauri-transport.js';
import * as yaml from 'yaml';

const key = { source: 'vertexai', model: 'gemini-test', tier: 'standard' };
const global = { input: 2, cachedInput: 0.2, output: 10 };
const regional = { input: 2.2, cachedInput: 0.22, output: 11 };
const entry = { ...key, ...global, regional, sourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/pricing' };
const catalog = (entries = [entry]) => ({ updatedAt: BUNDLED_MODEL_POLICY.pricing.updatedAt, currency: 'USD',
    unit: 'per_million_tokens', entries });
const million = { promptTokenCount: 1_000_000, candidatesTokenCount: 0 };

function costs(entries) {
    const context = { extensionSettings: {}, saveSettingsDebounced() {} };
    return createCostContext({ getContext: () => context, getPricing: () => catalog(entries) });
}

test('non-global Vertex endpoints use the regional rate and everything else the global rate', () => {
    const prices = { [priceKey(key)]: global, [regionalPriceKey(key)]: regional };
    for (const region of ['us-central1', 'US', 'eu', 'europe-west4']) assert.equal(lookupPrice(prices, { ...key, region }), regional);
    for (const region of ['global', 'GLOBAL', '', undefined]) assert.equal(lookupPrice(prices, { ...key, region }), global);
    assert.equal(lookupPrice(prices, { ...key, source: 'makersuite', region: 'us-central1' }), undefined);
    // Models without a regional rate cost the same everywhere.
    assert.equal(lookupPrice({ [priceKey(key)]: global }, { ...key, region: 'us-central1' }), global);
});

test('usage summaries and message costs fall back to the regional rate recorded with the request', () => {
    const prices = costs().getPrices();
    const records = [
        { id: 'a', status: 'complete', ...key, region: 'us-central1', usage: million },
        { id: 'b', status: 'complete', ...key, region: 'global', usage: million },
        { id: 'c', status: 'complete', ...key, usage: million },
    ];
    assert.deepEqual(summarizeUsage(records, prices).details.map(detail => detail.estimate.amount), [2.2, 2, 2]);
    assert.equal(summarizeMessageCost({ requests: [{ id: 'a', record: records[0] }] }, prices).amount, 2.2);
    // A captured snapshot still wins over the current regional rate.
    const captured = { ...records[0], id: 'd', price: { input: 3, cachedInput: 0.3, output: 15 } };
    assert.equal(summarizeUsage([captured], prices).details[0].estimate.amount, 3);
});

test('request prices follow the region, while a manual price applies to every region', () => {
    const api = costs();
    const data = { chat_completion_source: 'vertexai', model: key.model, vertexai_region: 'us-central1' };
    assert.deepEqual(api.getUsagePrice(data, key), regional);
    assert.deepEqual(api.getUsagePrice({ ...data, vertexai_region: 'global' }, key), global);
    // The caller's validated region overrides a missing or stale request field.
    assert.deepEqual(api.getUsagePrice({ ...data, vertexai_region: undefined }, key, { region: 'eu' }), regional);
    assert.deepEqual(api.getPriceInfo(key).regional, regional);

    api.setPrice(key, { input: 5, cachedInput: 0.5, output: 25 });
    assert.equal(api.getUsagePrice(data, key).input, 5);
    assert.equal(api.getUsagePrice({ ...data, vertexai_region: 'global' }, key).input, 5);
    assert.equal(Object.hasOwn(api.getPrices(), regionalPriceKey(key)), false);
    assert.deepEqual(api.getPriceInfo(key), { source: 'manual' });
    api.resetPrice(key);
    assert.deepEqual(api.getUsagePrice(data, key), regional);
});

test('regional rates are accepted only as valid nested Vertex Standard rates', () => {
    const parse = entries => parseModelPolicyDocument({ ...BUNDLED_MODEL_POLICY, pricing: catalog(entries) });
    assert.deepEqual(parse([entry]).pricing.entries[0].regional, regional);
    for (const invalid of [
        { ...entry, regional: { input: 2.2, output: 11 } },
        { ...entry, regional: { ...regional, input: '2.2' } },
        { ...entry, regional: { ...regional, input: -1 } },
        { ...entry, regional: { ...regional, region: 'us' } },
        { ...entry, regional: [2.2, 0.22, 11] },
        { ...entry, tier: 'priority' },
        { ...entry, source: 'makersuite' },
    ]) {
        assert.throws(() => parse([invalid]), error => error.code === 'INVALID_PRICING', JSON.stringify(invalid));
    }
});

test('the published catalog nests regional rates without adding entries clients from before regional pricing reject', async () => {
    const document = JSON.parse(await readFile(new URL('../data/model-support.json', import.meta.url), 'utf8'));
    const keys = document.pricing.entries.map(item => priceKey(item));
    assert.equal(new Set(keys).size, keys.length);
    const withRegional = document.pricing.entries.filter(item => item.regional);
    assert.ok(withRegional.length > 0);
    for (const item of withRegional) {
        assert.equal(item.source, 'vertexai');
        assert.equal(item.tier, 'standard');
        for (const field of ['input', 'cachedInput', 'output']) {
            assert.equal(item.regional[field], Math.round(item[field] * 1.1 * 1e10) / 1e10, `${item.model} ${field}`);
        }
    }
    assert.ok(new TextEncoder().encode(JSON.stringify(document)).byteLength < 48 * 1024, 'keep headroom below the 64 KiB limit');
});

test('Vertex requests are priced in the region the prepare payload targets', async () => {
    const calls = [];
    const target = { location: { origin: 'http://localhost:8000' }, fetch: async () => new Response('{}') };
    const context = { chatCompletionSettings: { vertexai_region: 'europe-west4' } };
    installRequestTransport({ context, target, stateProvider: () => ({ tier: 'standard', paygoOnly: false }),
        getUsagePrice: (data, state, options) => { calls.push(options); return null; },
        logger: { error() {} }, serverClient: { prepare: async () => ({ proxyUrl: 'http://127.0.0.1:1/proxy/t', proxySecret: 's' }) } });
    const send = body => target.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(body) });
    await send({ chat_completion_source: 'vertexai', model: 'gemini-2.5-pro', vertexai_region: 'US-Central1' });
    await send({ chat_completion_source: 'vertexai', model: 'gemini-2.5-pro' });
    await send({ chat_completion_source: 'makersuite', model: 'gemini-2.5-pro' });
    assert.deepEqual(calls, [{ region: 'us-central1' }, { region: 'europe-west4' }, {}]);
});

test('TauriTavern prices Vertex requests in the region its validation checks', () => {
    const calls = [];
    const target = { location: { origin: 'http://localhost:8000' }, fetch: async () => new Response('{}') };
    const transport = installTauriTransport({ context: {}, target, yaml,
        stateProvider: () => ({ tier: 'standard', paygoOnly: true }), captureUsageContext: () => null,
        getUsagePrice: (data, state, options) => { calls.push(options); return null; } });
    for (const vertexai_region of ['US-Central1', '', 'global']) {
        transport({ chat_completion_source: 'vertexai', model: 'gemini-2.5-pro', stream: false, vertexai_region });
    }
    // An empty region is the host default, as in validation.
    assert.deepEqual(calls, [{ region: 'us-central1' }, { region: 'us-central1' }, { region: 'global' }]);
});
