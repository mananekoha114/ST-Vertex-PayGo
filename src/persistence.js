/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { DEFAULT_STATE, EXTENSION_ID, isGoogleSource, VERTEX_SOURCE } from './constants.js';
import { normalizeRegion, normalizeState } from './state-machine.js';

const presetWriteQueues = new WeakMap();

function copyState(state) {
    return { ...normalizeState(state) };
}

export function getActiveProfile(context) {
    const manager = context?.extensionSettings?.connectionManager;
    if (!manager || !manager.selectedProfile || !Array.isArray(manager.profiles)) {
        return null;
    }

    const profile = manager.profiles.find(candidate => candidate?.id === manager.selectedProfile) ?? null;
    return profile?.mode === 'cc' && isGoogleSource(profile?.api) ? profile : null;
}

export function readPersistedState(context) {
    const profile = getActiveProfile(context);
    if (profile && Object.hasOwn(profile, EXTENSION_ID)) {
        return copyState(profile[EXTENSION_ID]);
    }

    const presetState = context?.chatCompletionSettings?.extensions?.[EXTENSION_ID];
    return presetState ? copyState(presetState) : { ...DEFAULT_STATE };
}

export function writePersistedState(context, state, { save = true } = {}) {
    const value = copyState(state);
    const profile = getActiveProfile(context);
    if (profile) {
        profile[EXTENSION_ID] = { ...value };
        if (save) {
            context.saveSettingsDebounced();
        }
        return value;
    }

    const chatSettings = context.chatCompletionSettings;
    chatSettings.extensions ??= {};
    chatSettings.extensions[EXTENSION_ID] = { ...value };

    if (!save) return value;
    const presetManager = context.getPresetManager?.('openai');
    if (typeof presetManager?.writePresetExtensionField === 'function') {
        const presetName = presetManager.getSelectedPresetName?.() || undefined;
        const previous = presetWriteQueues.get(context) ?? Promise.resolve();
        const write = previous.then(() => presetManager.writePresetExtensionField({
            name: presetName,
            path: EXTENSION_ID,
            value: { ...value },
        })).catch(error => {
            context.saveSettingsDebounced();
            console.warn('[Vertex PayGo] Preset Manager write failed; saved only current settings.', error);
        });
        presetWriteQueues.set(context, write);
        return write.then(() => value);
    }

    context.saveSettingsDebounced();
    console.warn('[Vertex PayGo] Preset Manager API unavailable; saved only current settings.');
    return value;
}

export function attachStateToProfile(profile, state) {
    if (profile && typeof profile === 'object') {
        profile[EXTENSION_ID] = copyState(state);
    }
    return profile;
}

export function writeActiveProfileRegion(context, region, { save = true } = {}) {
    const profile = getActiveProfile(context);
    if (!profile || profile.api !== VERTEX_SOURCE || profile.exclude?.includes('api-url')) {
        return false;
    }

    profile['api-url'] = normalizeRegion(region);
    if (save) {
        context.saveSettingsDebounced();
    }
    return true;
}

export function normalizeImportedPreset(event) {
    const extensions = event?.data?.extensions;
    if (extensions && Object.hasOwn(extensions, EXTENSION_ID)) {
        extensions[EXTENSION_ID] = copyState(extensions[EXTENSION_ID]);
    }
}

export function normalizeExportedPreset(preset) {
    const extensions = preset?.extensions;
    if (extensions && Object.hasOwn(extensions, EXTENSION_ID)) {
        extensions[EXTENSION_ID] = copyState(extensions[EXTENSION_ID]);
    }
    return preset;
}
