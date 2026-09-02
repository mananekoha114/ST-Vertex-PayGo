/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TIER } from './constants.js';

// PayGo support snapshot maintained from Google documentation and verified
// Vertex AI availability on 2026-09-02. New Gemini IDs remain usable but are
// shown as unverified, while IDs known from the other tier are rejected.
export const MODEL_POLICY_SNAPSHOT = '2026-09-02';

export const KNOWN_FLEX_MODELS = new Set([
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite-image',
    'gemini-3-pro-image',
    'gemini-3.1-flash-image',
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
]);

export const KNOWN_PRIORITY_MODELS = new Set([
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
]);

const KNOWN_TIER_MODELS = new Set([...KNOWN_FLEX_MODELS, ...KNOWN_PRIORITY_MODELS]);

export function normalizeModelId(model) {
    return String(model ?? '').trim().toLowerCase();
}

export function isGeminiModel(model) {
    return /^gemini-/.test(normalizeModelId(model));
}

/**
 * Returns policy information for one service tier. Standard itself is native,
 * but PayGo-only still uses this extension and therefore remains Gemini-only.
 */
export function getTierSupport(model, tier) {
    const modelId = normalizeModelId(model);
    const gemini = isGeminiModel(modelId);

    if (!gemini) {
        return {
            allowed: tier === TIER.STANDARD,
            level: 'excluded',
            model: modelId,
            reason: 'PayGo tier controls are available only for native Vertex Gemini model IDs (gemini-*).',
        };
    }

    if (tier === TIER.STANDARD) {
        return {
            allowed: true,
            level: 'native',
            model: modelId,
            reason: 'Standard uses SillyTavern’s native Vertex AI route unless PayGo-only is enabled.',
        };
    }

    const selectedSet = tier === TIER.FLEX ? KNOWN_FLEX_MODELS : KNOWN_PRIORITY_MODELS;
    if (selectedSet.has(modelId)) {
        return {
            allowed: true,
            level: 'known',
            model: modelId,
            reason: `Supported for ${tier} PayGo as of ${MODEL_POLICY_SNAPSHOT}.`,
        };
    }

    if (KNOWN_TIER_MODELS.has(modelId)) {
        return {
            allowed: false,
            level: 'unsupported',
            model: modelId,
            reason: `This model is in the ${MODEL_POLICY_SNAPSHOT} PayGo snapshot, but not in the ${tier} list.`,
        };
    }

    return {
        allowed: true,
        level: 'unverified',
        model: modelId,
        reason: `This Gemini model is not in the ${MODEL_POLICY_SNAPSHOT} snapshot; Vertex AI will perform the final validation.`,
    };
}

export function getModelPolicy(model) {
    return {
        model: normalizeModelId(model),
        isGemini: isGeminiModel(model),
        flex: getTierSupport(model, TIER.FLEX),
        priority: getTierSupport(model, TIER.PRIORITY),
    };
}
