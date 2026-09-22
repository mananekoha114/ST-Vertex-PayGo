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
import {
    normalizeState,
    requiresPlugin,
    resolveModelChange,
    resolveRegionChange,
    resolveTierSelection,
    validatePluginState,
} from '../src/state-machine.js';

test('normalizes invalid persisted values', () => {
    assert.deepEqual(normalizeState({ version: 99, tier: 'nonsense', paygoOnly: 'true' }), DEFAULT_STATE);
    assert.deepEqual(normalizeState({ tier: 'FLEX', paygoOnly: true }), { version: 1, tier: 'flex', paygoOnly: true });
});

test('requires the plugin for Standard Gemini usage as well as other tiers', () => {
    assert.equal(requiresPlugin(DEFAULT_STATE), true);
    assert.equal(requiresPlugin(DEFAULT_STATE, 'makersuite', 'gemini-2.5-pro'), true);
    assert.equal(requiresPlugin(DEFAULT_STATE, 'vertexai', 'gemma-3-27b-it'), false);
    assert.equal(requiresPlugin({ tier: TIER.STANDARD, paygoOnly: true }), true);
    assert.equal(requiresPlugin({ tier: TIER.PRIORITY, paygoOnly: false }), true);
});

test('selecting Flex in a regional endpoint yields two atomic valid branches', () => {
    const result = resolveTierSelection({
        state: DEFAULT_STATE,
        requestedTier: TIER.FLEX,
        region: 'us-central1',
        model: 'gemini-3.1-pro-preview',
    });
    assert.equal(result.type, 'conflict');
    assert.deepEqual(result.accept, { state: { version: 1, tier: 'flex', paygoOnly: false }, region: 'global' });
    assert.deepEqual(result.decline, { state: DEFAULT_STATE, region: 'us-central1' });
});

test('changing away from global while Priority is active yields symmetric branches', () => {
    const state = { version: 1, tier: TIER.PRIORITY, paygoOnly: true };
    const result = resolveRegionChange({ state, requestedRegion: 'europe-west4' });
    assert.equal(result.type, 'conflict');
    assert.equal(result.accept.state.tier, TIER.STANDARD);
    assert.equal(result.accept.state.paygoOnly, true);
    assert.equal(result.decline.region, 'global');
    assert.deepEqual(result.decline.state, state);
});

test('known tier/model mismatch is rejected while unknown Gemini is allowed', () => {
    const rejected = resolveTierSelection({
        state: DEFAULT_STATE,
        requestedTier: TIER.FLEX,
        region: 'global',
        model: 'gemini-2.5-pro',
    });
    assert.equal(rejected.type, 'reject');

    const future = resolveTierSelection({
        state: DEFAULT_STATE,
        requestedTier: TIER.FLEX,
        region: 'global',
        model: 'gemini-9.0-future',
    });
    assert.equal(future.type, 'apply');
    assert.equal(future.support.level, 'unverified');
});

test('model changes identify PayGo incompatibilities', () => {
    const state = { version: 1, tier: TIER.PRIORITY, paygoOnly: false };
    assert.equal(resolveModelChange({ state, model: 'gemma-3-27b-it' }).code, 'PAYGO_REQUIRES_GEMINI');
    assert.equal(resolveModelChange({ state, model: 'gemini-3-pro-image' }).code, 'MODEL_UNSUPPORTED');
    assert.equal(resolveModelChange({ state, model: 'gemini-3.1-pro-preview' }).type, 'apply');
});

test('generation validation fails closed for illegal combinations', () => {
    assert.equal(validatePluginState({
        state: { tier: TIER.FLEX },
        region: 'us-central1',
        model: 'gemini-3.1-pro-preview',
    }).code, 'TIER_REQUIRES_GLOBAL');

    assert.equal(validatePluginState({
        state: { tier: TIER.STANDARD, paygoOnly: true },
        region: 'global',
        model: 'gemma-3-27b-it',
    }).code, 'PAYGO_REQUIRES_GEMINI');

    assert.equal(validatePluginState({ state: DEFAULT_STATE, region: 'us-central1', model: 'gemma-3-27b-it' }).ok, true);
});
