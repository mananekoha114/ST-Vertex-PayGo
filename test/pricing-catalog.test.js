import test from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED_MODEL_POLICY, getActiveModelPolicy } from '../src/model-policy.js';
import { MODEL_POLICY_CACHE_KEY, parseModelPolicyDocument, refreshModelPolicyFromGitHub,
    restoreBundledModelPolicy, restoreCachedModelPolicy } from '../src/model-policy-updater.js';
import { createCostContext } from '../src/cost-context.js';
import { estimateRecord, priceKey } from '../src/cost-model.js';

const key = { source: 'vertexai', model: 'gemini-test', tier: 'standard' };
const entry = { ...key, input: 2, cachedInput: 0.2, output: 12, sourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/pricing' };
function catalog(overrides = {}) {
    return { updatedAt: '2026-09-23', currency: 'USD', unit: 'per_million_tokens', entries: [entry], ...overrides };
}
function policy(pricing = catalog()) { return { ...BUNDLED_MODEL_POLICY, pricing }; }
const logger = { warn() {} };
const now = Date.parse('2026-09-23T12:00:00Z');
function storage() {
    let text = JSON.stringify(BUNDLED_MODEL_POLICY);
    return { getItem: () => text, setItem: (_key, value) => { text = value; } };
}
function refresh(document, cache = storage()) {
    return refreshModelPolicyFromGitHub({ fetchImpl: async () => new Response(JSON.stringify(document)), storage: cache, logger, now });
}
test.afterEach(restoreBundledModelPolicy);

test('price-only update is installed with policy and survives cache restoration and legacy publishers', async () => {
    const cache = storage();
    const result = await refresh(policy(), cache);
    assert.equal(result.changed, true);
    assert.equal(result.pricingSnapshot, '2026-09-23');
    assert.deepEqual(getActiveModelPolicy().pricing, catalog());
    const legacy = { ...BUNDLED_MODEL_POLICY };
    delete legacy.pricing;
    assert.equal((await refresh(legacy, cache)).changed, false);
    assert.deepEqual(JSON.parse(cache.getItem(MODEL_POLICY_CACHE_KEY)).pricing, catalog());
    restoreBundledModelPolicy();
    assert.equal(restoreCachedModelPolicy({ storage: cache, logger, now }).applied, true);
    assert.deepEqual(getActiveModelPolicy().pricing, catalog());
});

test('invalid pricing rejects the entire support update without modifying active state or cache', async () => {
    const cache = storage();
    const original = cache.getItem();
    const invalid = [null, catalog({ currency: 'EUR' }), catalog({ unit: 'per_token' }), catalog({ updatedAt: '2026-02-30' }),
        catalog({ entries: [{ ...entry, input: '2' }] }), catalog({ entries: [{ ...entry, cachedInput: -1 }] }),
        catalog({ entries: [{ ...entry, longInput: 1 }] }), catalog({ entries: [{ ...entry, source: 'openai' }] }),
        catalog({ entries: [{ ...entry, model: 'Gemini-Test' }] }), catalog({ entries: [{ ...entry, tier: 'batch' }] }),
        catalog({ entries: [{ ...entry, validUntil: '2026-09-22' }] }),
        catalog({ entries: [{ ...entry, sourceUrl: 'javascript:alert(1)' }] }),
        catalog({ entries: [entry, entry] }), catalog({ entries: Array(257).fill(entry) }),
        catalog({ updatedAt: '2026-09-21' }), catalog({ updatedAt: '2027-01-01' })];
    for (const pricing of invalid) {
        const document = policy(pricing);
        document.updatedAt = '2026-09-23';
        const result = await refresh(document, cache);
        assert.equal(result.applied, false, JSON.stringify(pricing));
        assert.deepEqual(getActiveModelPolicy(), BUNDLED_MODEL_POLICY);
        assert.equal(cache.getItem(), original);
    }
});

test('empty catalog explicitly removes auto prices, while absence preserves them', async () => {
    assert.equal((await refresh(policy(catalog({ entries: [] })))).applied, true);
    assert.deepEqual(getActiveModelPolicy().pricing.entries, []);
    const legacy = { ...BUNDLED_MODEL_POLICY };
    delete legacy.pricing;
    assert.equal(Object.hasOwn(parseModelPolicyDocument(legacy), 'pricing'), false);
});

test('manual overrides stay independent from automatic catalog and request snapshots', () => {
    let prices = catalog();
    let date = now;
    const context = { extensionSettings: {}, saveSettingsDebounced() {} };
    const api = createCostContext({ getContext: () => context, getPricing: () => prices, now: () => date });
    const data = { chat_completion_source: key.source, model: key.model };
    const captured = api.getUsagePrice(data, key);
    assert.equal(captured.input, 2);
    assert.equal(api.getPriceInfo(key).source, 'catalog');
    context.extensionSettings['vertex-paygo-costs'].prices[priceKey(key)] = { input: -1 };
    assert.equal(api.getUsagePrice(data, key).input, 2, 'invalid legacy override must not hide valid catalog');
    assert.equal(api.getPriceInfo(key).source, 'catalog');
    api.setPrice(key, { input: 3, cachedInput: 0.3, output: 15 });
    prices = catalog({ entries: [{ ...entry, input: 4 }, { ...entry, model: 'gemini-other' }] });
    assert.equal(api.getUsagePrice(data, key).input, 3);
    assert.equal(api.getPriceInfo(key).source, 'manual');
    assert.equal(Object.keys(context.extensionSettings['vertex-paygo-costs'].prices).length, 1);
    api.resetPrice(key);
    assert.equal(api.getUsagePrice(data, key).input, 4);
    assert.equal(captured.input, 2);
    const record = { status: 'complete', price: captured, usage: { promptTokenCount: 1_000_000, candidatesTokenCount: 0 } };
    assert.equal(estimateRecord(record, api.getPrices()[priceKey(key)]).amount, 2);
    prices = catalog({ entries: [{ ...entry, validUntil: '2026-09-23' }] });
    assert.equal(api.getUsagePrice(data, key).input, 2);
    date = Date.parse('2026-09-24T00:00:00Z');
    assert.equal(api.getUsagePrice(data, key), null);
    assert.equal(api.getPriceInfo(key).source, 'missing');
    api.setPrice(key, { input: 0, cachedInput: 0, output: 0 });
    assert.equal(api.getUsagePrice(data, key).input, 0);
});
