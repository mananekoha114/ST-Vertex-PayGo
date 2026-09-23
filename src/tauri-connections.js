/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AI_STUDIO_SOURCE, DEFAULT_STATE, TIER, VERTEX_SOURCE } from './constants.js';
import { getTierSupport } from './model-policy.js';
import { applyTauriParameters, readTauriState } from './tauri-parameters.js';
import { normalizeState, validatePluginState } from './state-machine.js';

const MODEL_TARGET_KIND = 'tauritavern.modelTarget';
const GOOGLE_SOURCE_ALIASES = Object.freeze({
    vertexai: VERTEX_SOURCE,
    'vertex-ai': VERTEX_SOURCE,
    'vertex ai': VERTEX_SOURCE,
    makersuite: AI_STUDIO_SOURCE,
    google: AI_STUDIO_SOURCE,
    gemini: AI_STUDIO_SOURCE,
});

function normalizeSource(value) {
    return GOOGLE_SOURCE_ALIASES[String(value ?? '').trim().toLowerCase()] ?? '';
}

function requireContext(getContext) {
    const context = getContext?.();
    if (!context || typeof context !== 'object') {
        throw new Error('TauriTavern context is unavailable');
    }
    return context;
}

function modelTargets(context) {
    const targets = context.extensionSettings?.connectionManager?.modelTargets;
    return Array.isArray(targets) ? targets : [];
}

function isSupportedTarget(target) {
    return target?.kind === MODEL_TARGET_KIND
        && target.mode === 'cc'
        && Boolean(normalizeSource(target.api));
}

function toParameterData(target, source = normalizeSource(target.api)) {
    const hints = target.adapterHints ?? {};
    return {
        chat_completion_source: source,
        model: target.model,
        vertexai_region: source === VERTEX_SOURCE ? target['api-url'] : undefined,
        custom_include_headers: hints.customIncludeHeaders,
        custom_include_body: hints.customIncludeBody,
        custom_exclude_body: hints.customExcludeBody,
    };
}

function updateAdapterHints(target, data) {
    const hints = { ...(target.adapterHints ?? {}) };
    const mappings = [
        ['customIncludeHeaders', 'custom_include_headers'],
        ['customIncludeBody', 'custom_include_body'],
        ['customExcludeBody', 'custom_exclude_body'],
    ];
    for (const [hintKey, dataKey] of mappings) {
        const value = data[dataKey];
        if (typeof value === 'string' && value.trim()) hints[hintKey] = value;
        else delete hints[hintKey];
    }
    if (Object.keys(hints).length) target.adapterHints = hints;
    else delete target.adapterHints;
}

function targetSummary(target, yaml) {
    const source = normalizeSource(target.api);
    const data = toParameterData(target, source);
    const summary = {
        id: String(target.id),
        name: String(target.name || target.model || target.id),
        source,
        model: String(target.model),
        region: source === VERTEX_SOURCE ? String(target['api-url'] || '') : '',
        data: structuredClone(data),
    };
    try {
        return { ...summary, state: readTauriState(data, { yaml }) };
    } catch (error) {
        return {
            ...summary,
            state: { ...DEFAULT_STATE },
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function unchangedTarget(context, targets, index, target, expected) {
    return modelTargets(context) === targets
        && targets[index] === target
        && JSON.stringify(target) === expected;
}

function changedDuringSave(id) {
    return new Error(`Model Target changed while it was being saved: ${id}`);
}

async function defaultBuildConnection(target) {
    const module = await import('/scripts/tauritavern/agent/model-target-llm-connection.js');
    return module.buildLlmConnectionFromModelTarget(target);
}

function defaultGetContext() {
    return globalThis.SillyTavern?.getContext?.();
}

function defaultApi() {
    return globalThis.__TAURITAVERN__?.api;
}

/**
 * Adapts Connection Manager Model Targets to the Vertex PayGo state model.
 * The target remains the source of truth because TauriTavern rematerializes
 * Agent LLM connections from it before runs.
 */
export function createTauriConnections({
    getContext = defaultGetContext,
    api = defaultApi(),
    yaml,
    buildConnection = defaultBuildConnection,
} = {}) {
    const savingIds = new Set();
    const list = () => modelTargets(requireContext(getContext))
        .filter(isSupportedTarget)
        .map(target => targetSummary(target, yaml))
        .sort((left, right) => left.name.localeCompare(right.name));

    const read = id => {
        const target = modelTargets(requireContext(getContext))
            .find(candidate => isSupportedTarget(candidate) && String(candidate.id) === String(id));
        return target ? targetSummary(target, yaml) : null;
    };

    const save = async (id, requestedState, { syncGlobal = false } = {}) => {
        const saveId = String(id);
        if (savingIds.has(saveId)) {
            throw new Error(`Model Target is already being saved: ${id}`);
        }
        savingIds.add(saveId);
        try {
        const context = requireContext(getContext);
        const targets = modelTargets(context);
        const index = targets.findIndex(candidate => isSupportedTarget(candidate)
            && String(candidate.id) === saveId);
        if (index < 0) {
            throw new Error(`Google Gemini Model Target not found: ${id}`);
        }

        const original = structuredClone(targets[index]);
        const target = structuredClone(original);
        const source = normalizeSource(target.api);
        const state = normalizeState(requestedState);
        const support = getTierSupport(target.model, state.tier, source);
        if (!support.allowed) {
            throw new Error(support.reason || `${state.tier} is unavailable for ${target.model}`);
        }

        const needsGlobal = source === VERTEX_SOURCE
            && (state.tier === TIER.FLEX || state.tier === TIER.PRIORITY)
            && String(target['api-url'] || '').trim().toLowerCase() !== 'global';
        if (needsGlobal && !syncGlobal) {
            throw new Error(`${state.tier} requires the Vertex AI global region; retry with syncGlobal enabled`);
        }
        if (needsGlobal) target['api-url'] = 'global';

        const validation = validatePluginState({ source, model: target.model, region: target['api-url'], state });
        if (!validation.ok) throw new Error(validation.message);

        const data = applyTauriParameters(toParameterData(target, source), state, { yaml });
        updateAdapterHints(target, data);
        targets[index] = target;
        const expected = JSON.stringify(target);

        let settingsSaved = false;
        let connectionSaved = false;
        try {
            await context.saveSettingsDebounced?.();
            settingsSaved = true;
            if (!unchangedTarget(context, targets, index, target, expected)) throw changedDuringSave(id);
            if (typeof api?.llmConnections?.save !== 'function') {
                throw new Error('TauriTavern LLM Connection API is unavailable');
            }
            const connection = await buildConnection(structuredClone(target));
            if (!unchangedTarget(context, targets, index, target, expected)) throw changedDuringSave(id);
            await api.llmConnections.save({ connection });
            connectionSaved = true;
            if (!unchangedTarget(context, targets, index, target, expected)) throw changedDuringSave(id);
            const updateEvent = context.eventTypes?.MODEL_TARGET_UPDATED;
            if (updateEvent && typeof context.eventSource?.emit === 'function') {
                // Connection Manager emits (oldTarget, target) after edits. Agent
                // System and other consumers use this public event to refresh.
                await context.eventSource.emit(updateEvent, structuredClone(original), target);
            }
            return targetSummary(target, yaml);
        } catch (error) {
            // Never restore over a target that another editor replaced,
            // removed, or mutated while one of the awaited operations ran.
            if (!connectionSaved && unchangedTarget(context, targets, index, target, expected)) {
                targets[index] = original;
            } else {
                throw error;
            }
            if (settingsSaved) {
                try {
                    await context.saveSettingsDebounced?.();
                } catch (rollbackError) {
                    throw new AggregateError([error, rollbackError],
                        `Failed to save Model Target ${id} and to persist its rollback`);
                }
            }
            throw error;
        }
        } finally {
            savingIds.delete(saveId);
        }
    };

    return { list, read, save };
}
