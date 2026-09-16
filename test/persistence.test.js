/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { EXTENSION_ID, TIER } from '../src/constants.js';
import {
    attachStateToProfile,
    getActiveProfile,
    normalizeImportedPreset,
    normalizeExportedPreset,
    readPersistedState,
    writeActiveProfileRegion,
    writePersistedState,
} from '../src/persistence.js';

function makeContext() {
    let saves = 0;
    const profile = { id: 'active', mode: 'cc', api: 'vertexai', name: 'Vertex', 'api-url': 'us-central1' };
    return {
        chatCompletionSettings: { extensions: {} },
        extensionSettings: { connectionManager: { selectedProfile: 'active', profiles: [profile] } },
        saveSettingsDebounced: () => saves++,
        get saves() { return saves; },
        profile,
    };
}

test('active connection profile takes precedence over preset state', () => {
    const context = makeContext();
    context.chatCompletionSettings.extensions[EXTENSION_ID] = { tier: TIER.FLEX, paygoOnly: false };
    context.profile[EXTENSION_ID] = { tier: TIER.PRIORITY, paygoOnly: true };
    assert.deepEqual(readPersistedState(context), { version: 1, tier: TIER.PRIORITY, paygoOnly: true });
});

test('falls back to API preset extension state without an active profile value', () => {
    const context = makeContext();
    context.chatCompletionSettings.extensions[EXTENSION_ID] = { tier: TIER.FLEX, paygoOnly: true };
    assert.deepEqual(readPersistedState(context), { version: 1, tier: TIER.FLEX, paygoOnly: true });
});

test('selected non-Vertex profiles are ignored and never become authoritative', () => {
    const context = makeContext();
    context.profile.api = 'custom';
    context.profile[EXTENSION_ID] = { tier: TIER.PRIORITY, paygoOnly: true };
    context.chatCompletionSettings.extensions[EXTENSION_ID] = { tier: TIER.FLEX, paygoOnly: false };
    assert.equal(getActiveProfile(context), null);
    assert.deepEqual(readPersistedState(context), { version: 1, tier: TIER.FLEX, paygoOnly: false });

    writePersistedState(context, { tier: TIER.STANDARD, paygoOnly: true });
    assert.deepEqual(context.profile[EXTENSION_ID], { tier: TIER.PRIORITY, paygoOnly: true });
});

test('writes only the active profile when one is selected', () => {
    const context = makeContext();
    context.chatCompletionSettings.extensions[EXTENSION_ID] = { version: 1, tier: TIER.STANDARD, paygoOnly: false };
    const state = { tier: TIER.PRIORITY, paygoOnly: true };
    writePersistedState(context, state);
    assert.deepEqual(context.profile[EXTENSION_ID], { version: 1, tier: TIER.PRIORITY, paygoOnly: true });
    assert.deepEqual(context.chatCompletionSettings.extensions[EXTENSION_ID], { version: 1, tier: TIER.STANDARD, paygoOnly: false });
    assert.equal(context.saves, 1);
});

test('uses the public Preset Manager field API when no profile is active', async () => {
    const context = makeContext();
    context.extensionSettings.connectionManager.selectedProfile = null;
    const writes = [];
    context.getPresetManager = apiId => ({
        getSelectedPresetName: () => 'Vertex preset',
        writePresetExtensionField: async value => writes.push({ apiId, ...value }),
    });
    await writePersistedState(context, { tier: TIER.FLEX, paygoOnly: true });
    assert.deepEqual(writes, [{
        apiId: 'openai',
        name: 'Vertex preset',
        path: EXTENSION_ID,
        value: { version: 1, tier: TIER.FLEX, paygoOnly: true },
    }]);
    assert.deepEqual(context.chatCompletionSettings.extensions[EXTENSION_ID], { version: 1, tier: TIER.FLEX, paygoOnly: true });
    assert.equal(context.saves, 0);
});

test('serializes preset writes and binds each write to the preset selected at invocation', async () => {
    const context = makeContext();
    context.extensionSettings.connectionManager.selectedProfile = null;
    const writes = [];
    const resolvers = [];
    let selectedName = 'Preset A';
    context.getPresetManager = () => ({
        getSelectedPresetName: () => selectedName,
        writePresetExtensionField: value => {
            writes.push(value);
            return new Promise(resolve => resolvers.push(resolve));
        },
    });

    const first = writePersistedState(context, { tier: TIER.FLEX, paygoOnly: false });
    selectedName = 'Preset B';
    const second = writePersistedState(context, { tier: TIER.PRIORITY, paygoOnly: true });
    await Promise.resolve();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].name, 'Preset A');
    resolvers.shift()();
    await first;
    await Promise.resolve();
    assert.equal(writes.length, 2);
    assert.equal(writes[1].name, 'Preset B');
    resolvers.shift()();
    await second;
});

test('rejects a failed preset write while allowing later queued writes to continue', async () => {
    const context = makeContext();
    context.extensionSettings.connectionManager.selectedProfile = null;
    const writes = [];
    let attempt = 0;
    context.getPresetManager = () => ({
        getSelectedPresetName: () => 'Vertex preset',
        writePresetExtensionField: value => {
            writes.push(value);
            attempt++;
            return attempt === 1 ? Promise.reject(new Error('write failed')) : Promise.resolve();
        },
    });

    const first = writePersistedState(context, { tier: TIER.FLEX, paygoOnly: false });
    const second = writePersistedState(context, { tier: TIER.PRIORITY, paygoOnly: true });

    await assert.rejects(first, /write failed/);
    await second;
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].value, { version: 1, tier: TIER.PRIORITY, paygoOnly: true });
    assert.equal(context.saves, 1);
});

test('clearly falls back to current settings when Preset Manager is unavailable', () => {
    const context = makeContext();
    context.extensionSettings.connectionManager.selectedProfile = null;
    writePersistedState(context, { tier: TIER.FLEX, paygoOnly: false });
    assert.equal(context.saves, 1);
});

test('updates profile api-url only when that setting is managed by the profile', () => {
    const context = makeContext();
    assert.equal(writeActiveProfileRegion(context, 'GLOBAL'), true);
    assert.equal(context.profile['api-url'], 'global');
    context.profile.exclude = ['api-url'];
    assert.equal(writeActiveProfileRegion(context, 'europe-west4'), false);
    assert.equal(context.profile['api-url'], 'global');

    context.profile.exclude = [];
    context.profile.api = 'custom';
    assert.equal(writeActiveProfileRegion(context, 'asia-northeast1'), false);
    assert.equal(context.profile['api-url'], 'global');
});

test('normalizes imported and exported preset-owned state without injecting runtime state', () => {
    const imported = { data: { extensions: { [EXTENSION_ID]: { tier: 'FLEX', paygoOnly: true } } } };
    normalizeImportedPreset(imported);
    assert.deepEqual(imported.data.extensions[EXTENSION_ID], { version: 1, tier: TIER.FLEX, paygoOnly: true });

    const emptyExport = {};
    normalizeExportedPreset(emptyExport);
    assert.deepEqual(emptyExport, {});

    const exported = { extensions: { [EXTENSION_ID]: { tier: 'PRIORITY', paygoOnly: false } } };
    normalizeExportedPreset(exported);
    assert.deepEqual(exported.extensions[EXTENSION_ID], { version: 1, tier: TIER.PRIORITY, paygoOnly: false });
});

test('attaches a normalized state to a newly created profile', () => {
    const profile = attachStateToProfile({ id: 'new' }, { tier: 'FLEX', paygoOnly: true });
    assert.deepEqual(profile[EXTENSION_ID], { version: 1, tier: TIER.FLEX, paygoOnly: true });
});
