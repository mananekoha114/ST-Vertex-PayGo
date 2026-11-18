/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AI_STUDIO_SOURCE, TIER, VERTEX_SOURCE } from './constants.js';
import { BUNDLED_PRICING } from './bundled-pricing.js';

// Source-specific support snapshots, also used when the GitHub policy and
// last-known-good cache are unavailable. Keep data/model-support.json in sync.
export const BUNDLED_MODEL_POLICY = Object.freeze({
    schemaVersion: 1,
    pricing: BUNDLED_PRICING,
    updatedAt: '2026-11-18',
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
            'gemini-4-hydrogen',
            'gemini-4-carbon',
            'gemini-4-argon',
            'gemini-4-argon-cyber-permissive',
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
        'gemini-4-hydrogen',
        'gemini-4-carbon',
        'gemini-4-argon',
        'gemini-4-argon-cyber-permissive',
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
    // Vertex Standard PayGo locations from each model card. Models without a
    // list are not checked; Google performs the final validation for them.
    regions: Object.freeze({
        updatedAt: '2026-11-18',
        sourceUrl: 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations',
        standard: Object.freeze({
            'gemini-4-hydrogen': Object.freeze(['global', 'us', 'eu']),
            'gemini-4-carbon': Object.freeze(['global', 'us', 'eu']),
            'gemini-4-argon': Object.freeze(['global', 'us', 'eu']),
            'gemini-4-argon-cyber-permissive': Object.freeze(['global', 'us', 'eu']),
            'gemini-3.8-flash': Object.freeze(['global', 'us', 'eu']),
            'gemini-3.7-flash': Object.freeze(['global', 'us', 'eu']),
            'gemini-3.6-flash': Object.freeze(['global', 'us', 'eu']),
            'gemini-3.5-flash': Object.freeze(['global', 'us', 'eu']),
            'gemini-3.5-flash-lite': Object.freeze(['global', 'us', 'eu']),
        }),
    }),
    aiStudio: Object.freeze({
        updatedAt: '2026-11-13',
        tiers: Object.freeze({
            flex: Object.freeze([
                'gemini-4-hydrogen',
                'gemini-4-carbon',
                'gemini-4-argon',
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
        knownModels: Object.freeze([
            'gemini-4-hydrogen',
            'gemini-4-carbon',
            'gemini-4-argon',
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
    }),
});

// These bindings stay live so existing synchronous policy consumers see an
// atomically installed GitHub snapshot without doing network I/O themselves.
export let MODEL_POLICY_SNAPSHOT = BUNDLED_MODEL_POLICY.updatedAt;
export const KNOWN_FLEX_MODELS = new Set(BUNDLED_MODEL_POLICY.tiers.flex);
export const KNOWN_PRIORITY_MODELS = new Set(BUNDLED_MODEL_POLICY.tiers.priority);

const KNOWN_TIER_MODELS = new Set(BUNDLED_MODEL_POLICY.knownModels);

let aiStudioSnapshot = BUNDLED_MODEL_POLICY.aiStudio.updatedAt;
let pricingSnapshot = BUNDLED_PRICING;
let regionsSnapshot = BUNDLED_MODEL_POLICY.regions;
const AI_STUDIO_FLEX_MODELS = new Set(BUNDLED_MODEL_POLICY.aiStudio.tiers.flex);
const AI_STUDIO_KNOWN_MODELS = new Set(BUNDLED_MODEL_POLICY.aiStudio.knownModels);

function replaceSet(target, values) {
    target.clear();
    for (const value of values) target.add(value);
}

/**
 * Installs an already validated policy document. The updater owns validation;
 * keeping this operation synchronous preserves request-time fail-closed checks.
 */
export function installModelPolicy(policy) {
    const nextPricing = policy.pricing ? structuredClone(policy.pricing) : pricingSnapshot;
    // Documents from before region lists keep the current list.
    const nextRegions = policy.regions ? structuredClone(policy.regions) : regionsSnapshot;
    const flexModels = [...policy.tiers.flex];
    const priorityModels = [...policy.tiers.priority];
    const allModels = new Set(policy.knownModels);
    const aiStudioFlexModels = policy.aiStudio ? [...policy.aiStudio.tiers.flex] : null;
    const aiStudioKnownModels = policy.aiStudio ? [...policy.aiStudio.knownModels] : null;

    replaceSet(KNOWN_FLEX_MODELS, flexModels);
    replaceSet(KNOWN_PRIORITY_MODELS, priorityModels);
    replaceSet(KNOWN_TIER_MODELS, allModels);
    MODEL_POLICY_SNAPSHOT = policy.updatedAt;
    pricingSnapshot = nextPricing;
    regionsSnapshot = nextRegions;
    // Older schema-v1 documents lack aiStudio. Preserve its current policy
    // instead of replacing a fetched roster with the bundled fallback.
    if (policy.aiStudio) {
        replaceSet(AI_STUDIO_FLEX_MODELS, aiStudioFlexModels);
        replaceSet(AI_STUDIO_KNOWN_MODELS, aiStudioKnownModels);
        aiStudioSnapshot = policy.aiStudio.updatedAt;
    }
}

export function getKnownModelIds(source = VERTEX_SOURCE) {
    return [...(source === AI_STUDIO_SOURCE ? AI_STUDIO_KNOWN_MODELS : KNOWN_TIER_MODELS)];
}

export function getActiveModelPolicy() {
    return {
        schemaVersion: BUNDLED_MODEL_POLICY.schemaVersion,
        pricing: getActivePricing(),
        updatedAt: MODEL_POLICY_SNAPSHOT,
        tiers: {
            flex: [...KNOWN_FLEX_MODELS],
            priority: [...KNOWN_PRIORITY_MODELS],
        },
        knownModels: getKnownModelIds(),
        regions: getActiveRegions(),
        aiStudio: {
            updatedAt: aiStudioSnapshot,
            tiers: { flex: [...AI_STUDIO_FLEX_MODELS] },
            knownModels: getKnownModelIds(AI_STUDIO_SOURCE),
        },
    };
}

export function getActivePricing() {
    return structuredClone(pricingSnapshot);
}

export function getActiveRegions() {
    return structuredClone(regionsSnapshot);
}

/**
 * Whether a Vertex region serves the model on Standard PayGo. Flex and
 * Priority already require global, which every listed model supports.
 */
export function getRegionSupport(model, region, source = VERTEX_SOURCE) {
    const modelId = normalizeModelId(model);
    const regionId = String(region ?? '').trim().toLowerCase() || 'us-central1';
    if (source !== VERTEX_SOURCE) return { allowed: true, level: 'not_applicable', model: modelId, region: regionId };
    const regions = Object.hasOwn(regionsSnapshot.standard, modelId) ? regionsSnapshot.standard[modelId] : null;
    if (!regions) return { allowed: true, level: 'unverified', model: modelId, region: regionId };
    const allowed = regions.includes(regionId);
    return {
        allowed,
        level: allowed ? 'known' : 'unsupported',
        model: modelId,
        region: regionId,
        regions: [...regions],
        // ST reaches global through the same URL scheme it always uses.
        suggestedRegion: regions.includes('global') ? 'global' : regions[0],
        snapshot: regionsSnapshot.updatedAt,
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
export function getTierSupport(model, tier, source = VERTEX_SOURCE) {
    const modelId = normalizeModelId(model);
    const gemini = isGeminiModel(modelId);
    const aiStudio = source === AI_STUDIO_SOURCE;
    const snapshot = aiStudio ? aiStudioSnapshot : MODEL_POLICY_SNAPSHOT;

    if (aiStudio && tier === TIER.PRIORITY) {
        return {
            allowed: false,
            level: 'unavailable',
            model: modelId,
            reason: 'This extension supports Standard and Flex for Google AI Studio.',
        };
    }

    if (!gemini) {
        return {
            allowed: tier === TIER.STANDARD,
            level: 'excluded',
            model: modelId,
            reason: 'PayGo tier controls are available only for native Gemini model IDs (gemini-*).',
        };
    }

    if (tier === TIER.STANDARD) {
        return {
            allowed: true,
            level: 'native',
            model: modelId,
            reason: 'Standard uses SillyTavern’s native Google route unless Vertex PayGo-only is enabled.',
        };
    }

    const selectedSet = aiStudio ? AI_STUDIO_FLEX_MODELS
        : tier === TIER.FLEX ? KNOWN_FLEX_MODELS : KNOWN_PRIORITY_MODELS;
    if (selectedSet.has(modelId)) {
        return {
            allowed: true,
            level: 'known',
            model: modelId,
            snapshot,
            reason: `Supported for ${tier} PayGo as of ${snapshot}.`,
        };
    }

    const knownModel = (aiStudio ? AI_STUDIO_KNOWN_MODELS : KNOWN_TIER_MODELS).has(modelId);
    if (knownModel) {
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
        reason: `This Gemini model is not in the ${snapshot} snapshot; Google will perform the final validation.`,
    };
}

export function getModelPolicy(model, source = VERTEX_SOURCE) {
    return {
        model: normalizeModelId(model),
        isGemini: isGeminiModel(model),
        flex: getTierSupport(model, TIER.FLEX, source),
        priority: getTierSupport(model, TIER.PRIORITY, source),
    };
}
