/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getModelPolicy,
    getTierSupport,
    isGeminiModel,
    normalizeModelId,
} from '../src/model-policy.js';
import { TIER } from '../src/constants.js';

test('recognizes only native gemini-* model IDs', () => {
    assert.equal(isGeminiModel(' gemini-2.5-flash '), true);
    assert.equal(isGeminiModel('gemma-3-27b-it'), false);
    assert.equal(isGeminiModel('google/gemini-2.5-flash'), false);
    assert.equal(normalizeModelId(' GEMINI-3.1-PRO-PREVIEW '), 'gemini-3.1-pro-preview');
});

test('recognizes models listed for each tier', () => {
    assert.deepEqual(
        { allowed: getTierSupport('gemini-3.1-pro-preview', TIER.FLEX).allowed, level: getTierSupport('gemini-3.1-pro-preview', TIER.FLEX).level },
        { allowed: true, level: 'known' },
    );
    assert.equal(getTierSupport('gemini-2.5-pro', TIER.PRIORITY).level, 'known');
    assert.equal(getTierSupport('gemini-3.8-flash', TIER.FLEX).level, 'known');
    assert.equal(getTierSupport('gemini-3.8-flash', TIER.PRIORITY).level, 'known');
    assert.equal(getTierSupport('gemini-3.7-flash', TIER.PRIORITY).level, 'known');
});

test('keeps tier-specific support boundaries for Flex-only image models', () => {
    const priority = getTierSupport('gemini-3-pro-image', TIER.PRIORITY);
    assert.equal(priority.allowed, false);
    assert.equal(priority.level, 'unsupported');
});

test('disables a model known only for the other tier', () => {
    const support = getTierSupport('gemini-2.5-pro', TIER.FLEX);
    assert.equal(support.allowed, false);
    assert.equal(support.level, 'unsupported');
});

test('allows unknown future Gemini IDs with an unverified warning', () => {
    const policy = getModelPolicy('gemini-9.0-future');
    assert.equal(policy.flex.allowed, true);
    assert.equal(policy.flex.level, 'unverified');
    assert.equal(policy.priority.level, 'unverified');
});

test('excludes non-Gemini IDs from non-standard tiers', () => {
    assert.equal(getTierSupport('gemma-4-31b-it', TIER.STANDARD).allowed, true);
    assert.equal(getTierSupport('gemma-4-31b-it', TIER.FLEX).allowed, false);
    assert.equal(getTierSupport('claude-sonnet-4', TIER.PRIORITY).level, 'excluded');
});
