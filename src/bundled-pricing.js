/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0.
 * Pricing verified 2026-11-13. Vertex AI entries use the published Global base rates.
 * Gemini 4 Hydrogen is not on the Vertex pricing page yet. Its Standard input
 * and output rates come from Cloud Billing SKU C1CE-B525-5A70; cached input
 * follows the 5% of input that every other Gemini 4 model charges, and
 * Priority is 1.8x Standard like every other Vertex model. All three match
 * the Google AI Studio published Hydrogen rates, which have no end date.
 * Gemini 4 Carbon and Argon rates end 2026-11-30 and double on 2026-12-01;
 * replace them with the published December rates instead of letting them
 * lapse unpriced.
 * Gemini 4 Carbon on Vertex AI mirrors the Google AI Studio published rates,
 * which match Vertex for every other model, until it appears on the Vertex
 * pricing page.
 * Google AI Studio serves gemini-3.7-flash as gemini-3.8-flash and
 * gemini-3.5-flash as gemini-3.6-flash, so those AI Studio IDs keep their
 * Flex support and are priced at the routed model's rates.
 */

export const BUNDLED_PRICING = {
    updatedAt: '2026-11-13',
    currency: 'USD',
    unit: 'per_million_tokens',
    entries: [
        { source: 'vertexai', model: 'gemini-4-hydrogen', tier: 'standard', input: 1.5, cachedInput: 0.075, output: 7.5, sourceUrl: 'https://cloud.google.com/skus?filter=C1CE-B525-5A70' },
        { source: 'vertexai', model: 'gemini-4-hydrogen', tier: 'priority', input: 2.7, cachedInput: 0.135, output: 13.5, sourceUrl: 'https://cloud.google.com/skus?filter=C1CE-B525-5A70' },
        { source: 'vertexai', model: 'gemini-4-carbon', tier: 'standard', input: 2, cachedInput: 0.1, output: 10, validUntil: '2026-11-30', sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-4-carbon', tier: 'priority', input: 3.6, cachedInput: 0.18, output: 18, validUntil: '2026-11-30', sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-4-argon', tier: 'standard', input: 2, cachedInput: 0.1, output: 10, validUntil: '2026-11-30', sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-4-argon', tier: 'priority', input: 3.6, cachedInput: 0.18, output: 18, validUntil: '2026-11-30', sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-4-argon-cyber-permissive', tier: 'standard', input: 4, cachedInput: 0.2, output: 20, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-4-argon-cyber-permissive', tier: 'priority', input: 7.2, cachedInput: 0.36, output: 36, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.8-flash', tier: 'standard', input: 0.75, cachedInput: 0.075, output: 3.75, validUntil: '2026-12-31', sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.8-flash', tier: 'flex', input: 0.375, cachedInput: 0.0375, output: 1.875, validUntil: '2026-12-31', sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.8-flash', tier: 'priority', input: 1.35, cachedInput: 0.135, output: 6.75, validUntil: '2026-12-31', sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.7-flash', tier: 'standard', input: 0.75, cachedInput: 0.075, output: 3.75, validUntil: '2026-12-31', sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.7-flash', tier: 'flex', input: 0.375, cachedInput: 0.0375, output: 1.875, validUntil: '2026-12-31', sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.7-flash', tier: 'priority', input: 1.35, cachedInput: 0.135, output: 6.75, validUntil: '2026-12-31', sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.6-flash', tier: 'standard', input: 0.75, cachedInput: 0.075, output: 3.75, validUntil: '2026-12-31', sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.6-flash', tier: 'flex', input: 0.375, cachedInput: 0.0375, output: 1.875, validUntil: '2026-12-31', sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.6-flash', tier: 'priority', input: 1.35, cachedInput: 0.135, output: 6.75, validUntil: '2026-12-31', sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.5-flash', tier: 'standard', input: 1.5, cachedInput: 0.15, output: 9, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.5-flash', tier: 'flex', input: 0.75, cachedInput: 0.075, output: 4.5, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.5-flash', tier: 'priority', input: 2.7, cachedInput: 0.27, output: 16.2, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.5-flash-lite', tier: 'standard', input: 0.3, cachedInput: 0.03, output: 2.5, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.5-flash-lite', tier: 'flex', input: 0.15, cachedInput: 0.015, output: 1.25, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.5-flash-lite', tier: 'priority', input: 0.54, cachedInput: 0.054, output: 4.5, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.1-flash-lite', tier: 'standard', input: 0.25, cachedInput: 0.025, output: 1.5, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.1-flash-lite', tier: 'flex', input: 0.125, cachedInput: 0.0125, output: 0.75, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.1-flash-lite', tier: 'priority', input: 0.45, cachedInput: 0.045, output: 2.7, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.1-pro-preview', tier: 'standard', input: 2, cachedInput: 0.2, output: 12, longContextThreshold: 200000, longInput: 4, longCachedInput: 0.4, longOutput: 18, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3.1-pro-preview', tier: 'priority', input: 3.6, cachedInput: 0.36, output: 21.6, longContextThreshold: 200000, longInput: 7.2, longCachedInput: 0.72, longOutput: 32.4, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3-flash-preview', tier: 'standard', input: 0.5, cachedInput: 0.05, output: 3, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-3-flash-preview', tier: 'priority', input: 0.9, cachedInput: 0.09, output: 5.4, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-2.5-pro', tier: 'standard', input: 1.25, cachedInput: 0.125, output: 10, longContextThreshold: 200000, longInput: 2.5, longCachedInput: 0.25, longOutput: 15, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-2.5-pro', tier: 'priority', input: 2.25, cachedInput: 0.225, output: 18, longContextThreshold: 200000, longInput: 4.5, longCachedInput: 0.45, longOutput: 27, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-2.5-flash', tier: 'standard', input: 0.3, cachedInput: 0.03, output: 2.5, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-2.5-flash', tier: 'priority', input: 0.54, cachedInput: 0.054, output: 4.5, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-2.5-flash-lite', tier: 'standard', input: 0.1, cachedInput: 0.01, output: 0.4, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'vertexai', model: 'gemini-2.5-flash-lite', tier: 'priority', input: 0.18, cachedInput: 0.018, output: 0.72, sourceUrl: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing' },
        { source: 'makersuite', model: 'gemini-4-hydrogen', tier: 'standard', input: 1.5, cachedInput: 0.075, output: 7.5, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-4-hydrogen', tier: 'flex', input: 0.75, cachedInput: 0.0375, output: 3.75, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-4-hydrogen', tier: 'priority', input: 2.7, cachedInput: 0.135, output: 13.5, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-4-carbon', tier: 'standard', input: 2, cachedInput: 0.1, output: 10, validUntil: '2026-11-30', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-4-carbon', tier: 'flex', input: 1, cachedInput: 0.05, output: 5, validUntil: '2026-11-30', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-4-carbon', tier: 'priority', input: 3.6, cachedInput: 0.18, output: 18, validUntil: '2026-11-30', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-4-argon', tier: 'standard', input: 2, cachedInput: 0.1, output: 10, validUntil: '2026-11-30', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-4-argon', tier: 'flex', input: 1, cachedInput: 0.05, output: 5, validUntil: '2026-11-30', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-4-argon', tier: 'priority', input: 3.6, cachedInput: 0.18, output: 18, validUntil: '2026-11-30', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.8-flash', tier: 'standard', input: 0.75, cachedInput: 0.075, output: 3.75, validUntil: '2026-12-31', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.8-flash', tier: 'flex', input: 0.375, cachedInput: 0.0375, output: 1.875, validUntil: '2026-12-31', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.8-flash', tier: 'priority', input: 1.35, cachedInput: 0.135, output: 6.75, validUntil: '2026-12-31', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.7-flash', tier: 'standard', input: 0.75, cachedInput: 0.075, output: 3.75, validUntil: '2026-12-31', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.7-flash', tier: 'flex', input: 0.375, cachedInput: 0.0375, output: 1.875, validUntil: '2026-12-31', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.7-flash', tier: 'priority', input: 1.35, cachedInput: 0.135, output: 6.75, validUntil: '2026-12-31', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.6-flash', tier: 'standard', input: 0.75, cachedInput: 0.075, output: 3.75, validUntil: '2026-12-31', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.6-flash', tier: 'flex', input: 0.375, cachedInput: 0.0375, output: 1.875, validUntil: '2026-12-31', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.6-flash', tier: 'priority', input: 1.35, cachedInput: 0.135, output: 6.75, validUntil: '2026-12-31', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.5-flash', tier: 'standard', input: 0.75, cachedInput: 0.075, output: 3.75, validUntil: '2026-12-31', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.5-flash', tier: 'flex', input: 0.375, cachedInput: 0.0375, output: 1.875, validUntil: '2026-12-31', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.5-flash', tier: 'priority', input: 1.35, cachedInput: 0.135, output: 6.75, validUntil: '2026-12-31', sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.5-flash-lite', tier: 'standard', input: 0.3, cachedInput: 0.03, output: 2.5, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.5-flash-lite', tier: 'flex', input: 0.15, cachedInput: 0.02, output: 1.25, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.5-flash-lite', tier: 'priority', input: 0.54, cachedInput: 0.05, output: 4.5, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.1-flash-lite', tier: 'standard', input: 0.25, cachedInput: 0.025, output: 1.5, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.1-flash-lite', tier: 'flex', input: 0.125, cachedInput: 0.0125, output: 0.75, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.1-flash-lite', tier: 'priority', input: 0.45, cachedInput: 0.045, output: 2.7, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.1-pro-preview', tier: 'standard', input: 2, cachedInput: 0.2, output: 12, longContextThreshold: 200000, longInput: 4, longCachedInput: 0.4, longOutput: 18, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.1-pro-preview', tier: 'flex', input: 1, cachedInput: 0.2, output: 6, longContextThreshold: 200000, longInput: 2, longCachedInput: 0.4, longOutput: 9, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3.1-pro-preview', tier: 'priority', input: 3.6, cachedInput: 0.36, output: 21.6, longContextThreshold: 200000, longInput: 7.2, longCachedInput: 0.72, longOutput: 32.4, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3-flash-preview', tier: 'standard', input: 0.5, cachedInput: 0.05, output: 3, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3-flash-preview', tier: 'flex', input: 0.25, cachedInput: 0.05, output: 1.5, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-3-flash-preview', tier: 'priority', input: 0.9, cachedInput: 0.09, output: 5.4, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-2.5-pro', tier: 'standard', input: 1.25, cachedInput: 0.125, output: 10, longContextThreshold: 200000, longInput: 2.5, longCachedInput: 0.25, longOutput: 15, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-2.5-pro', tier: 'flex', input: 0.625, cachedInput: 0.125, output: 5, longContextThreshold: 200000, longInput: 1.25, longCachedInput: 0.25, longOutput: 7.5, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-2.5-pro', tier: 'priority', input: 2.25, cachedInput: 0.225, output: 18, longContextThreshold: 200000, longInput: 4.5, longCachedInput: 0.45, longOutput: 27, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-2.5-flash', tier: 'standard', input: 0.3, cachedInput: 0.03, output: 2.5, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-2.5-flash', tier: 'flex', input: 0.15, cachedInput: 0.03, output: 1.25, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-2.5-flash', tier: 'priority', input: 0.54, cachedInput: 0.054, output: 4.5, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-2.5-flash-lite', tier: 'standard', input: 0.1, cachedInput: 0.01, output: 0.4, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-2.5-flash-lite', tier: 'flex', input: 0.05, cachedInput: 0.01, output: 0.2, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
        { source: 'makersuite', model: 'gemini-2.5-flash-lite', tier: 'priority', input: 0.18, cachedInput: 0.018, output: 0.72, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing' },
    ],
};
