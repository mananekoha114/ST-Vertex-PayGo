/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiBridgeUi } from '../src/openai-bridge-ui.js';
import { validateBridgeState } from '../src/openai-bridge-model.js';
import { createLocalizer } from '../src/i18n.js';
import { nativeContext, nativeDocument } from './helpers/native-dom.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const disabled = { ok: true, enabled: false, baseUrl: null, apiKey: null, connection: null, model: 'st-current' };
const vertex = { source: 'vertexai', model: 'gemini-2.5-flash', authMode: 'full', region: 'global' };
const active = { ok: true, enabled: true, baseUrl: 'http://127.0.0.1:18443/openai/v1',
    apiKey: 'fake-long-bridge-key', connection: vertex, model: 'st-current',
    mode: 'openai', tierSource: 'independent', tier: 'standard', effectiveTier: 'standard', tierError: null };
function fixture({ state = disabled, capability = true, source = 'vertexai' } = {}) {
    const context = nativeContext();
    context.chatCompletionSettings.vertexai_auth_mode = 'full';
    context.chatCompletionSettings.chat_completion_source = source;
    const documentRef = nativeDocument();
    const writes = [];
    const ui = createOpenAiBridgeUi({ context, documentRef, localize: createLocalizer(), serverClient: {
        checkHealth: async () => ({ capabilities: { openaiBridge: true, openaiBridgeGateway: capability } }),
        readOpenAiBridge: async () => state,
        readActiveGoogleSecretId: async () => 'fixed-secret-id',
        updateOpenAiBridge: async payload => {
            writes.push(payload);
            state = payload.enabled ? { ...active, ...state, ...payload, ok: true, enabled: true,
                baseUrl: active.baseUrl, apiKey: active.apiKey, connection: payload.connection ?? state.connection ?? vertex,
                effectiveTier: payload.tierSource === 'follow' ? 'priority' : payload.tier ?? state.tier ?? 'standard',
            } : disabled;
            return state;
        },
    } });
    const get = suffix => documentRef.getElementById(`vertex-paygo-bridge-${suffix}`);
    const button = label => {
        const find = node => node.tagName === 'BUTTON' && node.textContent === label ? node : node.children.map(find).find(Boolean);
        return find(documentRef);
    };
    return { ui, get, button, writes, context };
}

test('Vertex gateway is opt in; policy is applied explicitly and keeps account binding', async () => {
    const f = fixture({ state: active });
    await tick();
    assert.equal(f.get('mode').value, 'openai');
    assert.equal(f.get('tier-source').value, 'independent');
    assert.equal(f.get('policy').attributes.open, undefined);
    f.get('mode').value = 'gemini'; await f.get('mode').fire('change');
    f.get('tier').value = 'flex'; await f.get('tier').fire('change');
    assert.equal(f.writes.length, 0);
    assert.equal(f.get('policy-apply').disabled, false);
    await f.get('policy-apply').fire('click'); await tick();
    assert.deepEqual(f.writes[0], { enabled: true, mode: 'gemini', tierSource: 'independent', tier: 'flex' });
    assert.equal(f.get('policy-apply').disabled, true);
    assert.match(f.get('policy-status').textContent, /Flex/);
    f.get('tier-source').value = 'follow'; await f.get('tier-source').fire('change');
    assert.equal(f.get('tier').disabled, true);
    await f.get('policy-apply').fire('click'); await tick();
    assert.equal(f.writes[1].tierSource, 'follow');
    assert.equal(Object.hasOwn(f.writes[1], 'connection'), false);
    assert.match(f.get('policy-status').textContent, /Priority/);
    f.ui.destroy();
});

test('Vertex native Flex is blocked and pre-enable gateway selection is submitted', async () => {
    const f = fixture(); await tick();
    f.get('tier').value = 'flex'; await f.get('tier').fire('change');
    assert.equal(f.button('Enable bridge').disabled, true);
    assert.match(f.get('policy-status').textContent, /does not support Flex/);
    f.get('mode').value = 'gemini'; await f.get('mode').fire('change');
    assert.equal(f.button('Enable bridge').disabled, false);
    await f.button('Enable bridge').fire('click'); await tick();
    assert.equal(f.writes[0].mode, 'gemini');
    assert.equal(f.writes[0].tier, 'flex');
    assert.equal(f.writes[0].connection.secretId, 'fixed-secret-id');
    f.ui.destroy();
});

test('AI Studio is unchanged and older backends do not receive gateway fields', async () => {
    for (const options of [{ source: 'makersuite' }, { capability: false }]) {
        const f = fixture(options); await tick();
        assert.equal(f.get('mode').disabled, true);
        if (options.source) assert.equal(f.get('policy').hidden, true);
        await f.button('Enable bridge').fire('click'); await tick();
        for (const field of ['mode', 'tierSource', 'tier']) assert.equal(Object.hasOwn(f.writes[0], field), false);
        f.ui.destroy();
    }
});

test('state validates policy types and exposes follow errors as plain text', async () => {
    assert.equal(validateBridgeState(active), true);
    for (const change of [{ mode: 'proxy' }, { tierSource: 'caller' }, { tier: 'free' },
        { effectiveTier: {} }, { tierError: [] }]) assert.equal(validateBridgeState({ ...active, ...change }), false);
    const message = '<img src=x onerror=alert(1)> settings unavailable';
    const f = fixture({ state: { ...active, tierSource: 'follow', effectiveTier: null, tierError: message } });
    await tick();
    assert.equal(f.get('policy-status').textContent, message);
    assert.equal(f.get('policy-status').children.length, 0);
    assert.equal(f.get('tier').disabled, true);
    f.ui.destroy();
});
