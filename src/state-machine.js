/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AI_STUDIO_SOURCE, CONFIG_VERSION, DEFAULT_STATE, TIER, VERTEX_SOURCE } from './constants.js';
import { getTierSupport, isGeminiModel } from './model-policy.js';

const VALID_TIERS = new Set(Object.values(TIER));

export function normalizeTier(value) {
    const tier = String(value ?? '').trim().toLowerCase();
    return VALID_TIERS.has(tier) ? tier : TIER.STANDARD;
}

export function normalizeRegion(value) {
    return String(value ?? '').trim().toLowerCase() || 'us-central1';
}

export function normalizeState(value) {
    const candidate = value && typeof value === 'object' ? value : {};
    return {
        version: CONFIG_VERSION,
        tier: normalizeTier(candidate.tier),
        paygoOnly: candidate.paygoOnly === true,
    };
}

export function requiresPlugin(value, source = VERTEX_SOURCE, model) {
    const state = normalizeState(value);
    if (source !== VERTEX_SOURCE && source !== AI_STUDIO_SOURCE) return false;
    // Standard Gemini also passes through the proxy to collect provider usage.
    // Preserve native handling of models outside this extension's Gemini scope.
    return state.tier !== TIER.STANDARD || (source === VERTEX_SOURCE && state.paygoOnly)
        || model === undefined || isGeminiModel(model);
}

export function resolveTierSelection({ state, requestedTier, region, model, source = VERTEX_SOURCE }) {
    const current = normalizeState(state);
    const tier = normalizeTier(requestedTier);
    const currentRegion = normalizeRegion(region);
    const nextState = { ...current, tier };

    if (tier === TIER.STANDARD) {
        return { type: 'apply', state: nextState, region: currentRegion };
    }

    const support = getTierSupport(model, tier, source);
    if (!support.allowed) {
        return { type: 'reject', code: 'MODEL_UNSUPPORTED', support, state: current, region: currentRegion };
    }

    if (source === VERTEX_SOURCE && currentRegion !== 'global') {
        return {
            type: 'conflict',
            code: 'TIER_REQUIRES_GLOBAL',
            support,
            accept: { state: nextState, region: 'global' },
            decline: { state: { ...current, tier: TIER.STANDARD }, region: currentRegion },
        };
    }

    return { type: 'apply', support, state: nextState, region: currentRegion };
}

export function resolveRegionChange({ state, requestedRegion }) {
    const current = normalizeState(state);
    const region = normalizeRegion(requestedRegion);

    if (current.tier === TIER.STANDARD || region === 'global') {
        return { type: 'apply', state: current, region };
    }

    return {
        type: 'conflict',
        code: 'REGION_REQUIRES_STANDARD',
        accept: { state: { ...current, tier: TIER.STANDARD }, region },
        decline: { state: current, region: 'global' },
    };
}

export function resolveModelChange({ state, model, source = VERTEX_SOURCE }) {
    const current = normalizeState(state);
    if (!requiresPlugin(current, source, model)) {
        return { type: 'apply', state: current };
    }

    if (!isGeminiModel(model)) {
        return {
            type: 'conflict',
            code: 'PAYGO_REQUIRES_GEMINI',
            accept: { state: { ...DEFAULT_STATE } },
            decline: { state: current },
        };
    }

    if (current.tier !== TIER.STANDARD) {
        const support = getTierSupport(model, current.tier, source);
        if (!support.allowed) {
            return {
                type: 'conflict',
                code: 'MODEL_UNSUPPORTED',
                support,
                accept: { state: { ...DEFAULT_STATE } },
                decline: { state: current },
            };
        }
    }

    return { type: 'apply', state: current };
}

export function validatePluginState({ state, region, model, source = VERTEX_SOURCE }) {
    const current = normalizeState(state);
    if (source === AI_STUDIO_SOURCE) current.paygoOnly = false;
    if (!requiresPlugin(current, source, model)) {
        return { ok: true, state: current };
    }

    if (!isGeminiModel(model)) {
        return {
            ok: false,
            code: 'PAYGO_REQUIRES_GEMINI',
            message: 'Vertex PayGo routing was requested for a non-Gemini model.',
        };
    }

    if (current.tier !== TIER.STANDARD) {
        const support = getTierSupport(model, current.tier, source);
        if (!support.allowed) {
            return {
                ok: false,
                code: 'MODEL_UNSUPPORTED',
                message: support.reason,
                support,
            };
        }

        if (source === VERTEX_SOURCE && normalizeRegion(region) !== 'global') {
            return {
                ok: false,
                code: 'TIER_REQUIRES_GLOBAL',
                message: `${current.tier} PayGo requires the global Vertex AI endpoint.`,
            };
        }

        if (support.level === 'unverified') {
            return { ok: true, state: current, warning: support.reason, support };
        }
    }

    return { ok: true, state: current };
}
