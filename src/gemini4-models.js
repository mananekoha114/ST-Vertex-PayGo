/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/ */

/** Gemini 4 models that need the native compatibility route. */
export const GEMINI4_MODELS = Object.freeze(['gemini-4-hydrogen', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-4-argon-cyber-permissive']);
export const GEMINI4_MODEL_LIMIT = 1048576;
export const isGemini4Model = model => GEMINI4_MODELS.includes(model);

// Servers that predate nativeGemini4Models only accept Argon natively.
const LEGACY_SERVER_MODELS = Object.freeze(['gemini-4-argon', 'gemini-4-argon-cyber-permissive']);

/** Whether a prepare response comes from a server that natively serves this model. */
export function serverSupportsNativeGemini4(prepared, model) {
    if (prepared?.nativeGemini4 !== true) return false;
    const models = Array.isArray(prepared.nativeGemini4Models) ? prepared.nativeGemini4Models : LEGACY_SERVER_MODELS;
    return models.includes(model);
}
