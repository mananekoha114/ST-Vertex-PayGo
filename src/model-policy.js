/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { TIER } from './constants.js';

// PayGo support snapshot maintained from Google documentation and verified
// Vertex AI availability on 2026-09-03. It is also the fail-safe snapshot
// used whenever the GitHub policy and the last-known-good cache are unavailable.
export const BUNDLED_MODEL_POLICY = Object.freeze({
    schemaVersion: 1,
    updatedAt: '2026-09-03',
    tiers: Object.freeze({
        flex: Object.freeze([
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
        ]),
        priority: Object.freeze([
            'gemini-3.8-flash',
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
        ]),
    }),
    // Keep retired entries here as tombstones even after removing them from
    // both tier arrays, so they do not become "unknown" and fail open again.
    knownModels: Object.freeze([
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
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
    ]),
});

// These bindings stay live so existing synchronous policy consumers see an
// atomically installed GitHub snapshot without doing network I/O themselves.
export let MODEL_POLICY_SNAPSHOT = BUNDLED_MODEL_POLICY.updatedAt;
export const KNOWN_FLEX_MODELS = new Set(BUNDLED_MODEL_POLICY.tiers.flex);
export const KNOWN_PRIORITY_MODELS = new Set(BUNDLED_MODEL_POLICY.tiers.priority);

const KNOWN_TIER_MODELS = new Set(BUNDLED_MODEL_POLICY.knownModels);

function replaceSet(target, values) {
    target.clear();
    for (const value of values) target.add(value);
}

/**
 * Installs an already validated policy document. The updater owns validation;
 * keeping this operation synchronous preserves request-time fail-closed checks.
 */
export function installModelPolicy(policy) {
    const flexModels = [...policy.tiers.flex];
    const priorityModels = [...policy.tiers.priority];
    const allModels = new Set(policy.knownModels);

    replaceSet(KNOWN_FLEX_MODELS, flexModels);
    replaceSet(KNOWN_PRIORITY_MODELS, priorityModels);
    replaceSet(KNOWN_TIER_MODELS, allModels);
    MODEL_POLICY_SNAPSHOT = policy.updatedAt;
}

export function getKnownModelIds() {
    return [...KNOWN_TIER_MODELS];
}

export function getActiveModelPolicy() {
    return {
        schemaVersion: BUNDLED_MODEL_POLICY.schemaVersion,
        updatedAt: MODEL_POLICY_SNAPSHOT,
        tiers: {
            flex: [...KNOWN_FLEX_MODELS],
            priority: [...KNOWN_PRIORITY_MODELS],
        },
        knownModels: getKnownModelIds(),
    };
}

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
    const snapshot = MODEL_POLICY_SNAPSHOT;

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
            snapshot,
            reason: `Supported for ${tier} PayGo as of ${snapshot}.`,
        };
    }

    if (KNOWN_TIER_MODELS.has(modelId)) {
        return {
            allowed: false,
            level: 'unsupported',
            model: modelId,
            snapshot,
            reason: `This model is in the ${snapshot} PayGo snapshot, but not in the ${tier} list.`,
        };
    }

    return {
        allowed: true,
        level: 'unverified',
        model: modelId,
        snapshot,
        reason: `This Gemini model is not in the ${snapshot} snapshot; Vertex AI will perform the final validation.`,
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
