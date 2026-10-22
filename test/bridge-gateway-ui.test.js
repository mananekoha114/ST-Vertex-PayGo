/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountExtensionSettings } from '../src/extension-settings.js';
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
function fixture({ state = disabled, capability = true, source = 'vertexai', persistence = false } = {}) {
    const context = nativeContext();
    context.chatCompletionSettings.vertexai_auth_mode = 'full';
    context.chatCompletionSettings.chat_completion_source = source;
    const documentRef = nativeDocument();
    const writes = [];
    const ui = createOpenAiBridgeUi({ context, documentRef, localize: createLocalizer(), serverClient: {
        checkHealth: async () => ({ capabilities: { openaiBridge: true, openaiBridgeGateway: capability, openaiBridgePersistence: persistence } }),
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
    return { ui, get, button, writes, context, documentRef };
}

test('restart persistence status is capability gated and failed restoration can be disabled', async () => {
    const allText = node => [node.textContent, ...node.children.flatMap(allText)].join('\n');
    for (const persistence of [false, true]) {
        const f = fixture({ state: active, persistence }); await tick();
        assert.equal(allText(f.documentRef).includes('Bridge enabled. It will restore automatically at the next host startup.'), persistence);
        f.ui.destroy();
    }
    const failed = fixture({ persistence: true, state: { ...disabled, restorePending: true, restoreError: '<b>Credential unavailable</b>' } });
    await tick();
    assert.ok(allText(failed.documentRef).includes('<b>Credential unavailable</b>'));
    assert.equal(failed.button('Disable bridge').disabled, false);
    await failed.button('Disable bridge').fire('click'); await tick();
    assert.deepEqual(failed.writes, [{ enabled: false }]);
    assert.equal(failed.button('Disable bridge').disabled, true);
    assert.equal(allText(failed.documentRef).includes('<b>Credential unavailable</b>'), false);
    assert.equal(validateBridgeState({ ...disabled, restorePending: 'yes' }), false);
    assert.equal(validateBridgeState({ ...active, restorePending: true }), false);
    failed.ui.destroy();
});

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

test('bridge shares the extension settings drawer and stays mounted across API changes', async () => {
    const f = fixture({ state: active });
    await tick();
    const drawer = f.documentRef.getElementById('vertex-paygo-extension-settings');
    const content = f.documentRef.getElementById('vertex-paygo-extension-settings-content');
    const bridge = f.documentRef.getElementById('vertex-paygo-openai-bridge');
    const bridgePanel = f.documentRef.getElementById('vertex-paygo-settings-panel-bridge');
    assert.equal(drawer.tagName, 'DIV');
    assert.equal(drawer.children[0].children[0].textContent, 'ST-Vertex-PayGo');
    assert.equal(drawer.parentElement.id, 'extensions_settings2');
    assert.equal(bridgePanel.parentElement, content);
    assert.equal(bridge.parentElement, bridgePanel);
    assert.equal(bridgePanel.hidden, false);
    const general = f.documentRef.createElement('section');
    general.id = 'vertex-paygo-general-settings';
    const unmountGeneral = mountExtensionSettings(general, { documentRef: f.documentRef });
    const generalPanel = f.documentRef.getElementById('vertex-paygo-settings-panel-general');
    assert.equal(general.parentElement, generalPanel);
    assert.equal(f.documentRef.getElementById('extensions_settings2').children.length, 1);
    for (const source of ['makersuite', 'openai', 'vertexai']) {
        f.context.chatCompletionSettings.chat_completion_source = source;
        f.ui.render();
        assert.equal(bridge.parentElement, bridgePanel);
        assert.equal(general.parentElement, generalPanel);
    }
    f.ui.destroy();
    assert.equal(f.documentRef.getElementById('vertex-paygo-openai-bridge'), null);
    assert.equal(f.documentRef.getElementById('vertex-paygo-settings-panel-bridge'), null);
    assert.equal(f.documentRef.getElementById('vertex-paygo-extension-settings'), drawer);
    assert.equal(generalPanel.hidden, false);
    unmountGeneral();
    assert.equal(f.documentRef.getElementById('vertex-paygo-extension-settings'), null);
});
