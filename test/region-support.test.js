/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_STATE, TIER } from '../src/constants.js';
import { BUNDLED_MODEL_POLICY, getActiveModelPolicy, getRegionSupport } from '../src/model-policy.js';
import { parseModelPolicyDocument, refreshModelPolicyFromGitHub, restoreBundledModelPolicy } from '../src/model-policy-updater.js';
import { planPersistedReconciliation } from '../src/reconciliation.js';
import { localizeValidation } from '../src/i18n.js';
import { resolveRegionChange, resolveRegionSupport, validatePluginState } from '../src/state-machine.js';

const shiftDate = (date, days) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
const regionsDate = days => shiftDate(BUNDLED_MODEL_POLICY.regions.updatedAt, days);
const now = Math.max(...[BUNDLED_MODEL_POLICY.updatedAt, BUNDLED_MODEL_POLICY.aiStudio.updatedAt,
    BUNDLED_MODEL_POLICY.pricing.updatedAt, BUNDLED_MODEL_POLICY.regions.updatedAt].map(date => Date.parse(date))) + 86_400_000;
const priority = { version: 1, tier: TIER.PRIORITY, paygoOnly: false };

function regions(standard, overrides = {}) {
    return { updatedAt: regionsDate(1), sourceUrl: BUNDLED_MODEL_POLICY.regions.sourceUrl, standard, ...overrides };
}
function refresh(document) {
    return refreshModelPolicyFromGitHub({ fetchImpl: async () => new Response(JSON.stringify(document)),
        storage: { getItem: () => null, setItem() {} }, logger: { warn() {} }, now });
}

test.afterEach(restoreBundledModelPolicy);

test('listed models are checked per region while unlisted and AI Studio models are not', () => {
    const unsupported = getRegionSupport('Gemini-4-Hydrogen', 'US-Central1');
    assert.deepEqual(
        { allowed: unsupported.allowed, level: unsupported.level, model: unsupported.model, region: unsupported.region,
            regions: unsupported.regions, suggestedRegion: unsupported.suggestedRegion },
        { allowed: false, level: 'unsupported', model: 'gemini-4-hydrogen', region: 'us-central1',
            regions: ['global', 'us', 'eu'], suggestedRegion: 'global' },
    );
    for (const region of ['global', 'us', 'eu']) assert.equal(getRegionSupport('gemini-4-hydrogen', region).level, 'known');
    // An empty region is the host's us-central1 default.
    assert.equal(getRegionSupport('gemini-4-carbon', '').region, 'us-central1');
    assert.equal(getRegionSupport('gemini-2.5-pro', 'europe-west4').level, 'unverified');
    assert.equal(getRegionSupport('gemini-4-neon', 'us-central1').level, 'unverified');
    assert.equal(getRegionSupport('gemini-4-hydrogen', 'us-central1', 'makersuite').allowed, true);
});

test('generation validation refuses a region the model is not served in, after tier checks', () => {
    const blocked = validatePluginState({ state: DEFAULT_STATE, region: 'us-central1', model: 'gemini-4-hydrogen' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'MODEL_REGION_UNSUPPORTED');
    assert.deepEqual(blocked.regionSupport.regions, ['global', 'us', 'eu']);
    const localize = (key, parameters) => `${key}|${JSON.stringify(parameters)}`;
    assert.equal(localizeValidation(localize, blocked), `vertex_paygo.validation.region_unsupported|${JSON.stringify({
        model: 'gemini-4-hydrogen', region: 'us-central1', regions: 'global, us, eu' })}`);
    // Flex and Priority keep their own global requirement first.
    assert.equal(validatePluginState({ state: priority, region: 'us-central1', model: 'gemini-4-hydrogen' }).code,
        'TIER_REQUIRES_GLOBAL');
    assert.equal(validatePluginState({ state: priority, region: 'global', model: 'gemini-4-hydrogen' }).ok, true);
    assert.equal(validatePluginState({ state: DEFAULT_STATE, region: 'eu', model: 'gemini-3.8-flash' }).ok, true);
    assert.equal(validatePluginState({ state: DEFAULT_STATE, region: 'europe-west4', model: 'gemini-2.5-pro' }).ok, true);
    assert.equal(validatePluginState({ state: DEFAULT_STATE, region: 'us-central1', model: 'gemini-4-hydrogen',
        source: 'makersuite' }).ok, true);
    // Unverified tier support still warns once the region passes.
    assert.equal(validatePluginState({ state: priority, region: 'global', model: 'gemini-9.0-future' }).warning !== undefined, true);
});

test('saved state reconciliation reports the region conflict instead of a tier conflict', () => {
    const plan = planPersistedReconciliation({ state: DEFAULT_STATE, source: 'vertexai', model: 'gemini-4-carbon', region: 'us-central1' });
    assert.equal(plan.type, 'conflict');
    assert.equal(plan.validation.code, 'MODEL_REGION_UNSUPPORTED');
    assert.deepEqual(plan.state, DEFAULT_STATE);
});

test('region support offers the suggested region and keeps a declined region on Standard', () => {
    assert.equal(resolveRegionSupport({ state: DEFAULT_STATE, model: 'gemini-4-hydrogen', region: 'global' }).type, 'apply');
    assert.equal(resolveRegionSupport({ state: DEFAULT_STATE, model: 'gemini-2.5-pro', region: 'asia-east1' }).type, 'apply');
    assert.equal(resolveRegionSupport({ state: DEFAULT_STATE, model: 'gemma-3-27b-it', region: 'asia-east1' }).type, 'apply');

    const standard = resolveRegionSupport({ state: DEFAULT_STATE, model: 'gemini-4-hydrogen', region: 'us-central1' });
    assert.equal(standard.code, 'MODEL_REGION_UNSUPPORTED');
    assert.deepEqual(standard.accept, { state: DEFAULT_STATE, region: 'global' });
    assert.deepEqual(standard.decline, { state: DEFAULT_STATE, region: 'us-central1' });

    const tiered = resolveRegionSupport({ state: priority, model: 'gemini-4-hydrogen', region: 'us-central1' });
    assert.deepEqual(tiered.accept, { state: priority, region: 'global' });
    assert.deepEqual(tiered.decline, { state: { ...priority, tier: TIER.STANDARD }, region: 'us-central1' });
});

test('a region change that the model does not serve takes precedence over the Standard fallback', () => {
    const change = resolveRegionChange({ state: priority, requestedRegion: 'europe-west4', model: 'gemini-4-argon' });
    assert.equal(change.type, 'conflict');
    assert.equal(change.code, 'REGION_MODEL_UNSUPPORTED');
    assert.deepEqual(change.accept, { state: priority, region: 'global' });
    assert.deepEqual(change.decline, { state: { ...priority, tier: TIER.STANDARD }, region: 'europe-west4' });

    // A served region keeps the existing tier conflict; unlisted models keep the old behavior.
    assert.equal(resolveRegionChange({ state: priority, requestedRegion: 'eu', model: 'gemini-4-argon' }).code,
        'REGION_REQUIRES_STANDARD');
    assert.equal(resolveRegionChange({ state: priority, requestedRegion: 'europe-west4', model: 'gemini-2.5-pro' }).code,
        'REGION_REQUIRES_STANDARD');
    assert.equal(resolveRegionChange({ state: DEFAULT_STATE, requestedRegion: 'eu', model: 'gemini-4-argon' }).type, 'apply');
    assert.equal(resolveRegionChange({ state: DEFAULT_STATE, requestedRegion: 'europe-west4' }).type, 'apply');
});

test('the region list is validated and replaced only by a current or newer document', async () => {
    const valid = parseModelPolicyDocument({ ...BUNDLED_MODEL_POLICY, regions: regions({ 'gemini-test': ['global', 'europe-west4'] }) });
    assert.deepEqual(valid.regions.standard, { 'gemini-test': ['global', 'europe-west4'] });
    for (const invalid of [
        null,
        regions({ 'gemini-test': [] }),
        regions({ 'gemini-test': ['global', 'global'] }),
        regions({ 'gemini-test': ['Global'] }),
        regions({ 'gemini-test': ['us central'] }),
        regions({ 'gemini-test': 'global' }),
        regions({ 'Gemini-Test': ['global'] }),
        regions({ 'gpt-test': ['global'] }),
        regions({ 'gemini-test': ['global'] }, { updatedAt: '2026-02-30' }),
        regions({ 'gemini-test': ['global'] }, { sourceUrl: 'https://example.com/locations' }),
        regions({ 'gemini-test': ['global'] }, { standard: [] }),
    ]) {
        assert.throws(() => parseModelPolicyDocument({ ...BUNDLED_MODEL_POLICY, regions: invalid }),
            error => error.code === 'INVALID_REGIONS', JSON.stringify(invalid));
    }

    assert.equal((await refresh({ ...BUNDLED_MODEL_POLICY, regions: regions({ 'gemini-4-hydrogen': ['global', 'us-central1'] }) })).applied, true);
    assert.equal(getRegionSupport('gemini-4-hydrogen', 'us-central1').level, 'known');
    assert.equal(getRegionSupport('gemini-4-carbon', 'us-central1').level, 'unverified');

    const stale = await refresh({ ...BUNDLED_MODEL_POLICY, regions: regions({}, { updatedAt: regionsDate(0) }) });
    assert.equal(stale.applied, false);
    assert.equal(stale.error.code, 'STALE_REGIONS');
    const future = await refresh({ ...BUNDLED_MODEL_POLICY, regions: regions({}, { updatedAt: regionsDate(30) }) });
    assert.equal(future.error.code, 'FUTURE_REGIONS');

    // A publisher from before region lists keeps the active list.
    const legacy = { ...BUNDLED_MODEL_POLICY };
    delete legacy.regions;
    assert.equal(Object.hasOwn(parseModelPolicyDocument(legacy), 'regions'), false);
    assert.equal((await refresh(legacy)).applied, true);
    assert.deepEqual(getActiveModelPolicy().regions.standard, { 'gemini-4-hydrogen': ['global', 'us-central1'] });
});
