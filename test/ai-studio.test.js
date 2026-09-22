/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_STUDIO_SOURCE as source, EXTENSION_ID, TIER } from '../src/constants.js';
import { getTierSupport, BUNDLED_MODEL_POLICY, installModelPolicy } from '../src/model-policy.js';
import { resolveTierSelection, requiresPlugin, validatePluginState } from '../src/state-machine.js';
import { planPersistedReconciliation } from '../src/reconciliation.js';
import { createRequestHook } from '../src/request-hook.js';
import { readPersistedState, writePersistedState, writeActiveProfileRegion } from '../src/persistence.js';
import { resolveVertexModel } from '../src/ui.js';

test('AI Studio Flex accepts 2.5 models without changing the Vertex region or PayGo-only preference', () => {
    const state = { version: 1, tier: TIER.STANDARD, paygoOnly: true };
    const selection = resolveTierSelection({ state, source, model: 'gemini-2.5-pro', region: 'us-central1', requestedTier: TIER.FLEX });
    assert.equal(selection.type, 'apply');
    assert.equal(selection.region, 'us-central1');
    const plan = planPersistedReconciliation({ state: selection.state, source, model: 'gemini-2.5-pro', region: 'us-central1' });
    assert.equal(plan.type, 'valid');
    assert.equal(plan.validation.state.paygoOnly, false);
    assert.equal(selection.state.paygoOnly, true);
    assert.equal(requiresPlugin(state, source), true);
    assert.equal(getTierSupport('gemini-2.5-pro', TIER.FLEX).allowed, false);
});

test('AI Studio model support stays independent of Vertex policy updates', () => {
    try {
        installModelPolicy({ ...BUNDLED_MODEL_POLICY, tiers: { flex: [], priority: [] } });
        assert.equal(getTierSupport('gemini-2.5-flash', TIER.FLEX, source).level, 'known');
        assert.equal(getTierSupport('gemini-3.1-flash-image', TIER.FLEX, source).allowed, false);
        assert.equal(getTierSupport('gemini-2.5-pro', TIER.PRIORITY, source).allowed, false);
        assert.equal(getTierSupport('claude-sonnet-4', TIER.FLEX, source).allowed, false);
        assert.equal(getTierSupport('gemini-future', TIER.FLEX, source).level, 'unverified');
        assert.equal(validatePluginState({ state: { tier: TIER.PRIORITY }, source, model: 'gemini-2.5-pro' }).ok, false);
    } finally {
        installModelPolicy(BUNDLED_MODEL_POLICY);
    }
});

test('AI Studio reuses profile persistence and never writes a Vertex region into its profile', () => {
    const vertex = { id: 'vertex', mode: 'cc', api: 'vertexai', [EXTENSION_ID]: { tier: TIER.PRIORITY, paygoOnly: true } };
    const studio = { id: 'studio', mode: 'cc', api: source, 'api-url': 'keep-this-value' };
    const context = {
        chatCompletionSettings: { extensions: {} },
        extensionSettings: { connectionManager: { selectedProfile: 'studio', profiles: [vertex, studio] } },
        saveSettingsDebounced() {},
    };
    writePersistedState(context, { tier: TIER.FLEX });
    assert.equal(readPersistedState(context).tier, TIER.FLEX);
    assert.equal(writeActiveProfileRegion(context, 'global'), false);
    assert.equal(studio['api-url'], 'keep-this-value');
    context.extensionSettings.connectionManager.selectedProfile = 'vertex';
    assert.equal(readPersistedState(context).tier, TIER.PRIORITY);
    assert.equal(readPersistedState(context).paygoOnly, true);
    assert.equal(resolveVertexModel({ source, profile: { ...studio, model: 'gemini-2.5-pro' } }), 'gemini-2.5-pro');
    assert.equal(resolveVertexModel({ source, profile: { ...vertex, model: 'wrong-provider' }, selectValue: 'gemini-2.5-flash' }), 'gemini-2.5-flash');
});

test('AI Studio hook uses the same ticket preparation with a source-specific payload for both stream modes', async () => {
    for (const stream of [true, false]) {
        const data = { chat_completion_source: source, model: 'gemini-2.5-pro', stream, vertexai_region: 'us-central1' };
        let payload;
        const hook = createRequestHook({
            stateProvider: () => ({ tier: TIER.FLEX, paygoOnly: true }),
            origin: 'http://localhost:8000',
            serverClient: { prepare: async value => {
                assert.match(data.reverse_proxy, /\/rejected$/u);
                payload = value;
                return { proxyUrl: 'http://127.0.0.1:1234/proxy/test', proxySecret: 'disposable' };
            } },
        });
        await hook(data);
        assert.deepEqual(payload, { protocolVersion: 2, chat_completion_source: source, model: 'gemini-2.5-pro', stream, tier: TIER.FLEX, paygoOnly: false });
        assert.equal(data.proxy_password, 'disposable');
        assert.equal(data.vertexai_region, 'us-central1');
    }
});

test('AI Studio Standard and Flex failures cannot fall back to the native route', async () => {
    const data = () => ({ chat_completion_source: source, model: 'gemini-2.5-pro' });
    const serverClient = { prepare: async () => { throw new Error('unavailable'); } };
    const native = data();
    await createRequestHook({ stateProvider: () => ({ tier: TIER.STANDARD, paygoOnly: true }), serverClient,
        origin: 'http://localhost:8000', logger: { error() {} } })(native);
    assert.match(native.reverse_proxy, /\/rejected$/u);
    for (const overrides of [{}, { model: 'gemma-3' }, { reverse_proxy: 'https://custom.invalid' }]) {
        const request = { ...data(), ...overrides };
        const errors = [];
        await createRequestHook({
            stateProvider: () => ({ tier: TIER.FLEX }), serverClient,
            origin: 'http://localhost:8000', notifyError: message => errors.push(message), logger: { error() {} },
        })(request);
        assert.match(request.reverse_proxy, /\/rejected$/u);
        assert.equal(errors.length, 1);
    }
});
