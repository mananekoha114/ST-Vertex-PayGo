/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'yaml';

import { createTauriConnections } from '../src/tauri-connections.js';


function fixture(overrides = {}) {
    let saves = 0;
    const target = {
        kind: 'tauritavern.modelTarget',
        id: 'vertex-main',
        name: 'Vertex main',
        mode: 'cc',
        api: 'vertex-ai',
        model: 'gemini-3.8-flash',
        'api-url': 'us-central1',
        secretRef: { key: 'vertexai_service_account_json', id: 'secret-1' },
        adapterHints: {
            customIncludeHeaders: JSON.stringify({ 'X-Unrelated': 'keep' }),
            customIncludeBody: JSON.stringify({ temperature: 0.3 }),
            customExcludeBody: JSON.stringify(['seed']),
            futureHint: 'preserved',
        },
        futureTargetField: { preserved: true },
        ...overrides,
    };
    const context = {
        extensionSettings: { connectionManager: { modelTargets: [target] } },
        saveSettingsDebounced: async () => { saves += 1; },
        get saves() { return saves; },
    };
    const synced = [];
    const api = { llmConnections: { save: async value => synced.push(value) } };
    const buildConnection = async savedTarget => ({
        kind: 'tauritavern.llmConnection',
        id: `model-target-${savedTarget.id}`,
        adapterHints: structuredClone(savedTarget.adapterHints),
    });
    return { context, target, api, synced, buildConnection };
}

test('lists all Google Model Targets and normalizes source aliases', () => {
    const item = fixture();
    item.context.extensionSettings.connectionManager.modelTargets.push(
        { kind: 'tauritavern.modelTarget', id: 'studio', name: 'Studio', mode: 'cc', api: 'google', model: 'gemini-2.5-flash' },
        { kind: 'tauritavern.modelTarget', id: 'claude', mode: 'cc', api: 'vertexai', model: 'claude-3-7-sonnet' },
        { kind: 'other', id: 'other', mode: 'cc', api: 'makersuite', model: 'gemini-2.5-pro' },
    );
    const connections = createTauriConnections({
        getContext: () => item.context, api: item.api, yaml, buildConnection: item.buildConnection,
    });
    assert.deepEqual(connections.list().map(({ id, source }) => ({ id, source })), [
        { id: 'claude', source: 'vertexai' },
        { id: 'studio', source: 'makersuite' },
        { id: 'vertex-main', source: 'vertexai' },
    ]);
    assert.equal(connections.read('missing'), null);
});

test('saves the original target hints, preserves unrelated data, and synchronizes the materialized connection', async () => {
    const item = fixture({ 'api-url': 'global' });
    const connections = createTauriConnections({
        getContext: () => item.context, api: item.api, yaml, buildConnection: item.buildConnection,
    });
    const saved = await connections.save('vertex-main', { tier: 'priority', paygoOnly: true });
    const persisted = item.context.extensionSettings.connectionManager.modelTargets[0];

    assert.equal(saved.state.tier, 'priority');
    assert.equal(saved.data.custom_include_headers, persisted.adapterHints.customIncludeHeaders);
    assert.deepEqual(persisted.futureTargetField, { preserved: true });
    assert.equal(persisted.adapterHints.futureHint, 'preserved');
    assert.deepEqual(yaml.parse(persisted.adapterHints.customIncludeBody), { temperature: 0.3 });
    assert.deepEqual(yaml.parse(persisted.adapterHints.customExcludeBody), ['seed']);
    assert.equal(yaml.parse(persisted.adapterHints.customIncludeHeaders)['X-Unrelated'], 'keep');
    assert.equal(item.context.saves, 1);
    assert.deepEqual(item.synced[0].connection.adapterHints, persisted.adapterHints);
});

test('isolates malformed YAML in list and blocks saving only that target', async () => {
    const item = fixture({ adapterHints: { customIncludeHeaders: 'not: [valid' } });
    item.context.extensionSettings.connectionManager.modelTargets.push({
        kind: 'tauritavern.modelTarget', id: 'studio', name: 'Studio', mode: 'cc',
        api: 'makersuite', model: 'gemini-3.8-flash',
    });
    const connections = createTauriConnections({
        getContext: () => item.context, api: item.api, yaml, buildConnection: item.buildConnection,
    });

    const listed = connections.list();
    assert.equal(listed.length, 2);
    assert.match(listed.find(entry => entry.id === 'vertex-main').error, /parse/i);
    assert.deepEqual(listed.find(entry => entry.id === 'vertex-main').state,
        { version: 1, tier: 'standard', paygoOnly: false });
    assert.equal(listed.find(entry => entry.id === 'studio').error, undefined);
    await assert.rejects(
        connections.save('vertex-main', { tier: 'standard', paygoOnly: false }),
        /parse/i,
    );
    assert.equal(item.context.saves, 0);
});

test('keeps non-Gemini Google targets visible so Standard can remove stale managed parameters', async () => {
    const item = fixture({
        model: 'claude-3-7-sonnet',
        'api-url': 'us-central1',
        adapterHints: { customIncludeHeaders: JSON.stringify({
            'X-Vertex-AI-LLM-Shared-Request-Type': 'priority',
            'X-Unrelated': 'keep',
        }) },
    });
    const connections = createTauriConnections({
        getContext: () => item.context, api: item.api, yaml, buildConnection: item.buildConnection,
    });
    assert.equal(connections.list()[0].id, 'vertex-main');
    await assert.rejects(
        connections.save('vertex-main', { tier: 'flex', paygoOnly: false }),
        /only for native Gemini/,
    );
    await connections.save('vertex-main', { tier: 'standard', paygoOnly: false });
    assert.deepEqual(yaml.parse(item.context.extensionSettings.connectionManager.modelTargets[0]
        .adapterHints.customIncludeHeaders), { 'X-Unrelated': 'keep' });
});

test('requires explicit confirmation before changing a Vertex target to global', async () => {
    const item = fixture();
    const connections = createTauriConnections({
        getContext: () => item.context, api: item.api, yaml, buildConnection: item.buildConnection,
    });
    await assert.rejects(
        connections.save('vertex-main', { tier: 'flex', paygoOnly: false }),
        /requires the Vertex AI global region/,
    );
    assert.equal(item.target['api-url'], 'us-central1');
    assert.equal(item.context.saves, 0);

    const saved = await connections.save(
        'vertex-main', { tier: 'flex', paygoOnly: false }, { syncGlobal: true },
    );
    assert.equal(saved.region, 'global');
    assert.equal(item.context.extensionSettings.connectionManager.modelTargets[0]['api-url'], 'global');
});

test('rolls the source target back and persists the rollback when connection synchronization fails', async () => {
    const item = fixture({ 'api-url': 'global' });
    const before = structuredClone(item.target);
    item.api.llmConnections.save = async () => { throw new Error('native sync failed'); };
    const connections = createTauriConnections({
        getContext: () => item.context, api: item.api, yaml, buildConnection: item.buildConnection,
    });

    await assert.rejects(
        connections.save('vertex-main', { tier: 'priority', paygoOnly: false }),
        /native sync failed/,
    );
    assert.deepEqual(item.context.extensionSettings.connectionManager.modelTargets[0], before);
    assert.equal(item.context.saves, 2);
});

test('does not restore a target deleted or replaced while save is awaiting host persistence', async () => {
    for (const mutation of ['replace', 'replace-array', 'delete']) {
        const item = fixture({ 'api-url': 'global' });
        let release;
        item.context.saveSettingsDebounced = () => new Promise(resolve => { release = resolve; });
        const connections = createTauriConnections({
            getContext: () => item.context, api: item.api, yaml, buildConnection: item.buildConnection,
        });
        const saving = connections.save('vertex-main', { tier: 'priority', paygoOnly: false });
        await Promise.resolve();
        const userReplacement = { ...item.target, name: 'Edited elsewhere' };
        if (mutation === 'replace') item.context.extensionSettings.connectionManager.modelTargets[0] = userReplacement;
        else if (mutation === 'replace-array') {
            item.context.extensionSettings.connectionManager.modelTargets = [userReplacement];
        } else item.context.extensionSettings.connectionManager.modelTargets.splice(0, 1);
        release();
        await assert.rejects(saving, /changed while it was being saved/);
        assert.deepEqual(item.context.extensionSettings.connectionManager.modelTargets,
            mutation === 'delete' ? [] : [userReplacement]);
        assert.equal(item.synced.length, 0);
    }
});

test('rejects a concurrent save for the same target and emits the observed update contract after success', async () => {
    const item = fixture({ 'api-url': 'global' });
    let release;
    let call = 0;
    item.context.saveSettingsDebounced = () => {
        call += 1;
        return call === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
    };
    const events = [];
    item.context.eventTypes = { MODEL_TARGET_UPDATED: 'model-target-updated' };
    item.context.eventSource = { emit: async (...args) => events.push(args) };
    const connections = createTauriConnections({
        getContext: () => item.context, api: item.api, yaml, buildConnection: item.buildConnection,
    });
    const first = connections.save('vertex-main', { tier: 'priority', paygoOnly: false });
    await Promise.resolve();
    await assert.rejects(
        connections.save('vertex-main', { tier: 'standard', paygoOnly: false }),
        /already being saved/,
    );
    release();
    const saved = await first;
    assert.equal(saved.state.tier, 'priority');
    assert.equal(events.length, 1);
    assert.equal(events[0][0], 'model-target-updated');
    assert.equal(events[0][1].adapterHints.customIncludeHeaders.includes('priority'), false);
    assert.equal(events[0][2], item.context.extensionSettings.connectionManager.modelTargets[0]);
});

test('rejects unsupported tiers and missing targets without saving', async () => {
    const item = fixture({ api: 'gemini', model: 'gemini-2.5-pro' });
    const connections = createTauriConnections({
        getContext: () => item.context, api: item.api, yaml, buildConnection: item.buildConnection,
    });
    await assert.rejects(
        connections.save('vertex-main', { tier: 'priority', paygoOnly: false }),
        /Standard and Flex/,
    );
    await assert.rejects(
        connections.save('unknown', { tier: 'standard', paygoOnly: false }),
        /not found/,
    );
    assert.equal(item.context.saves, 0);
});
