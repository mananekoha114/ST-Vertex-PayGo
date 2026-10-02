import test from 'node:test';
import assert from 'node:assert/strict';
import { currentBridgeConnection, isValidBridgeConnection, validateBridgeState } from '../src/openai-bridge-model.js';
import { createOpenAiBridgeUi } from '../src/openai-bridge-ui.js';
import { createServerClient } from '../src/server-client.js';
import { createLocalizer } from '../src/i18n.js';
import { nativeContext, nativeDocument } from './helpers/native-dom.js';
import { createTauriUi } from '../src/tauri-ui.js';
import yaml from 'yaml';

const disabled = { ok: true, enabled: false, baseUrl: null, apiKey: null, model: 'st-current', connection: null };
const enabled = { ok: true, enabled: true, baseUrl: 'http://127.0.0.1:4321/openai/v1',
    apiKey: 'long-temporary-bridge-key', model: 'st-current',
    connection: { source: 'makersuite', model: 'gemini-3.8-flash' } };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('connection snapshot accepts native Google only and matches selected profile secret', () => {
    const context = nativeContext();
    context.chatCompletionSettings.vertexai_auth_mode = 'full';
    context.extensionSettings.connectionManager = { selectedProfile: 'current', profiles: [
        { id: 'current', mode: 'cc', api: 'makersuite', 'secret-id': 'wrong-source' },
    ] };
    let result = currentBridgeConnection(context, nativeDocument());
    assert.equal(result.ok, true);
    assert.deepEqual(result.connection, { source: 'vertexai', model: 'gemini-3.8-flash', authMode: 'full', region: 'global' });
    context.extensionSettings.connectionManager.profiles[0].api = 'vertexai';
    result = currentBridgeConnection(context, nativeDocument());
    assert.equal(result.connection.secretId, undefined);
    context.extensionSettings.connectionManager.profiles[0]['secret-id'] = 'bad/id';
    assert.equal(currentBridgeConnection(context, nativeDocument()).connection.secretId, undefined);
    context.extensionSettings.connectionManager.profiles[0]['secret-id'] = '';
    assert.equal(currentBridgeConnection(context, nativeDocument()).ok, true);
    context.chatCompletionSettings.vertexai_auth_mode = 'express';
    assert.equal(currentBridgeConnection(context).code, 'express');
    context.chatCompletionSettings.vertexai_auth_mode = 'full';
    context.chatCompletionSettings.reverse_proxy = 'https://custom.invalid';
    assert.equal(currentBridgeConnection(context).code, 'proxy');
    context.chatCompletionSettings.reverse_proxy = '';
    context.chatCompletionSettings.chat_completion_source = 'openai';
    assert.equal(currentBridgeConnection(context).code, 'source');
    context.chatCompletionSettings.chat_completion_source = 'makersuite';
    context.chatCompletionSettings.google_model = 'models/gemini-3.8-flash';
    assert.equal(currentBridgeConnection(context).code, 'model');
    context.chatCompletionSettings.google_model = 'Gemini-3.8-flash';
    assert.equal(currentBridgeConnection(context).code, 'model');
    context.chatCompletionSettings.google_model = 'google/gemini-3.8-flash';
    assert.equal(currentBridgeConnection(context).ok, true);
    context.chatCompletionSettings.chat_completion_source = 'vertexai';
    context.chatCompletionSettings.vertexai_region = 'bad/region';
    assert.equal(currentBridgeConnection(context).code, 'region');
});

test('bridge response accepts only authenticated loopback endpoint', () => {
    assert.equal(validateBridgeState(disabled), true);
    assert.equal(validateBridgeState(enabled), true);
    assert.equal(validateBridgeState({ ...enabled, debugLocalAccess: true }), true);
    assert.equal(validateBridgeState({ ...enabled, debugLocalAccess: 'true' }), false);
    assert.equal(validateBridgeState({ ...disabled, debugLocalAccess: true }), false);
    assert.equal(validateBridgeState({ ...enabled, baseUrl: 'http://localhost:4321/openai/v1' }), false);
    assert.equal(validateBridgeState({ ...enabled, apiKey: null }), false);
    assert.equal(validateBridgeState({ ...enabled, baseUrl: 'http://name:pass@127.0.0.1:4321/openai/v1' }), false);
    assert.equal(validateBridgeState({ ...disabled, connection: enabled.connection }), false);
    assert.equal(validateBridgeState({ ...enabled, connection: { source: 'vertexai', model: 'gemini-3.8-flash' } }), false);
    assert.equal(isValidBridgeConnection({ source: 'vertexai', model: 'gemini-3.8-flash', authMode: 'full', region: 'global' }), true);
    assert.equal(isValidBridgeConnection({ source: 'makersuite', model: 'google/gemini-3.8-flash', region: 'global' }), false);
    assert.equal(isValidBridgeConnection({ source: 'makersuite', model: 'gemini-3.8-flash', secretId: 'bad/id' }), false);
});

test('management client reads only active Google credential metadata and sends host headers', async () => {
    const requests = [];
    const client = createServerClient({
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'token' }),
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, json: async () => url === '/api/secrets/read'
                ? { api_key_makersuite: [{ id: 'old', active: false }, { id: 'current', active: true, value: 'masked' }],
                    vertexai_service_account_json: [{ id: 'vertex-current', active: true }] }
                : disabled };
        },
    });
    assert.equal(await client.readActiveGoogleSecretId('makersuite'), 'current');
    assert.equal(await client.readActiveGoogleSecretId('vertexai'), 'vertex-current');
    await client.readOpenAiBridge();
    await client.updateOpenAiBridge({ enabled: false });
    assert.deepEqual(requests.map(item => [item.url, item.options.method]), [
        ['/api/secrets/read', 'POST'],
        ['/api/secrets/read', 'POST'],
        ['/api/plugins/vertex-paygo/openai-bridge', 'GET'],
        ['/api/plugins/vertex-paygo/openai-bridge', 'POST'],
    ]);
    assert.equal(requests[0].options.headers['X-CSRF-Token'], 'token');
    assert.equal(JSON.parse(requests[3].options.body).enabled, false);
});

test('metadata without one valid active credential fails closed', async () => {
    for (const value of [false, null, [], [{ id: 'bad/id', active: true }],
        [{ id: 'a', active: true }, { id: 'b', active: true }]]) {
        const client = createServerClient({ fetchImpl: async () => ({ ok: true,
            json: async () => ({ api_key_makersuite: value }) }) });
        await assert.rejects(client.readActiveGoogleSecretId('makersuite'),
            error => error.code === 'ACTIVE_GOOGLE_SECRET_UNAVAILABLE');
    }
});

test('UI gates management fetch on capability, then snapshots and updates current connection', async () => {
    const context = nativeContext();
    context.chatCompletionSettings.chat_completion_source = 'makersuite';
    const documentRef = nativeDocument();
    const payloads = [];
    let capability = false;
    let reads = 0;
    const ui = createOpenAiBridgeUi({ context, documentRef, localize: createLocalizer(), serverClient: {
        checkHealth: async () => ({ capabilities: { openaiBridge: capability } }),
        readOpenAiBridge: async () => { reads++; return disabled; },
        readActiveGoogleSecretId: async () => 'active-key',
        updateOpenAiBridge: async payload => { payloads.push(payload); return enabled; },
    } });
    await tick();
    assert.equal(reads, 0);
    capability = true;
    await ui.refresh();
    assert.equal(reads, 1);
    assert.equal(documentRef.getElementById('vertex-paygo-bridge-debug').disabled, true);
    const findButton = text => {
        const visit = node => node.tagName === 'BUTTON' && node.textContent === text ? node
            : node.children.map(visit).find(Boolean);
        return visit(documentRef);
    };
    context.chatCompletionSettings.chat_completion_source = 'openai';
    await documentRef.fire('change');
    assert.equal(findButton('Enable bridge').disabled, true);
    context.chatCompletionSettings.chat_completion_source = 'makersuite';
    await documentRef.fire('change');
    assert.equal(findButton('Enable bridge').disabled, false);
    await findButton('Enable bridge').fire('click');
    await tick();
    assert.deepEqual(payloads[0], { enabled: true, connection: { source: 'makersuite', model: 'gemini-3.8-flash', secretId: 'active-key' } });
    context.chatCompletionSettings.google_model = 'gemini-2.5-pro';
    await findButton('Update to current connection').fire('click');
    await tick();
    assert.equal(payloads[1].connection.model, 'gemini-2.5-pro');
    await findButton('Disable bridge').fire('click');
    await tick();
    assert.deepEqual(payloads[2], { enabled: false });
    ui.destroy();
    assert.equal(documentRef.getElementById('vertex-paygo-openai-bridge'), null);
});

test('destroy during health check prevents subsequent bridge requests', async () => {
    let resolveHealth;
    let reads = 0;
    const documentRef = nativeDocument();
    const ui = createOpenAiBridgeUi({ context: nativeContext(), documentRef, localize: createLocalizer(), serverClient: {
        checkHealth: () => new Promise(resolve => { resolveHealth = resolve; }),
        readOpenAiBridge: async () => { reads++; return enabled; },
    } });
    ui.destroy();
    resolveHealth({ capabilities: { openaiBridge: true } });
    await tick();
    assert.equal(reads, 0);
    assert.equal(documentRef.getElementById('vertex-paygo-openai-bridge'), null);
});

test('Debug choice is sent on enable and update; live toggles preserve binding, failures require refresh', async () => {
    const context = nativeContext(); context.chatCompletionSettings.chat_completion_source = 'makersuite';
    const documentRef = nativeDocument();
    const payloads = [];
    let actual = { ...disabled, debugLocalAccess: false };
    let fail = false;
    const ui = createOpenAiBridgeUi({ context, documentRef, localize: createLocalizer(), serverClient: {
        checkHealth: async () => ({ capabilities: { openaiBridge: true, openaiBridgeDebug: true } }),
        readOpenAiBridge: async () => actual,
        readActiveGoogleSecretId: async () => 'active-key',
        updateOpenAiBridge: async payload => {
            payloads.push(payload);
            if (fail) throw new Error('Lost management response');
            actual = payload.enabled ? { ...enabled, debugLocalAccess: payload.debugLocalAccess ?? actual.debugLocalAccess }
                : { ...disabled, debugLocalAccess: false };
            return actual;
        },
    } });
    const button = text => {
        const visit = node => node.tagName === 'BUTTON' && node.textContent === text ? node
            : node.children.map(visit).find(Boolean);
        return visit(documentRef);
    };
    await tick();
    const debug = documentRef.getElementById('vertex-paygo-bridge-debug');
    assert.equal(debug.checked, false);
    assert.equal(debug.disabled, false);
    debug.checked = true; await debug.fire('change');
    assert.equal(payloads.length, 0);
    await button('Enable bridge').fire('click'); await tick();
    assert.equal(payloads[0].debugLocalAccess, true);
    await button('Update to current connection').fire('click'); await tick();
    assert.equal(payloads[1].debugLocalAccess, true);
    debug.checked = false; await debug.fire('change'); await tick();
    assert.deepEqual(payloads[2], { enabled: true, debugLocalAccess: false });
    actual = { ...enabled, debugLocalAccess: true };
    await ui.refresh(); assert.equal(debug.checked, true);
    fail = true; debug.checked = false; await debug.fire('change'); await tick();
    assert.equal(debug.disabled, true);
    assert.equal(debug.checked, false);
    assert.equal(button('Enable bridge').disabled, true);
    fail = false; await ui.refresh(); assert.equal(debug.checked, true);
    await button('Disable bridge').fire('click'); await tick();
    assert.equal(debug.checked, false);
    assert.deepEqual(payloads.at(-1), { enabled: false });
    ui.destroy();
});

test('missing active credential aborts enable without bridge update', async () => {
    const context = nativeContext(); context.chatCompletionSettings.chat_completion_source = 'makersuite';
    const documentRef = nativeDocument();
    let updates = 0;
    const ui = createOpenAiBridgeUi({ context, documentRef, localize: createLocalizer(), serverClient: {
        checkHealth: async () => ({ capabilities: { openaiBridge: true } }),
        readOpenAiBridge: async () => disabled,
        readActiveGoogleSecretId: async () => { throw new Error('No active Google credential is available.'); },
        updateOpenAiBridge: async () => { updates++; return enabled; },
    } });
    await tick();
    const visit = node => node.tagName === 'BUTTON' && node.textContent === 'Enable bridge' ? node
        : node.children.map(visit).find(Boolean);
    await visit(documentRef).fire('click'); await tick();
    assert.equal(updates, 0);
    ui.destroy();
});

test('legacy boolean secret state leaves a stale profile ID out of the bridge connection', async () => {
    const context = nativeContext(); context.chatCompletionSettings.chat_completion_source = 'makersuite';
    context.extensionSettings.connectionManager = { selectedProfile: 'old', profiles: [
        { id: 'old', mode: 'cc', api: 'makersuite', 'secret-id': 'stale-id' },
    ] };
    const documentRef = nativeDocument();
    let posted;
    const client = createServerClient({ fetchImpl: async url => ({ ok: true, json: async () =>
        url === '/api/secrets/read' ? { api_key_makersuite: true } : disabled }) });
    const ui = createOpenAiBridgeUi({ context, documentRef, localize: createLocalizer(), serverClient: {
        checkHealth: async () => ({ capabilities: { openaiBridge: true } }),
        readOpenAiBridge: async () => disabled,
        readActiveGoogleSecretId: client.readActiveGoogleSecretId,
        updateOpenAiBridge: async payload => { posted = payload; return enabled; },
    } });
    await tick();
    const visit = node => node.tagName === 'BUTTON' && node.textContent === 'Enable bridge' ? node
        : node.children.map(visit).find(Boolean);
    await visit(documentRef).fire('click'); await tick();
    assert.deepEqual(posted.connection, { source: 'makersuite', model: 'gemini-3.8-flash' });
    ui.destroy();
});

test('Tauri settings explain bridge unavailability without a management client', () => {
    const documentRef = nativeDocument();
    const context = nativeContext();
    const ui = createTauriUi({ getContext: () => context, documentRef, yaml,
        connections: { list: () => [], read: () => null }, localize: createLocalizer() });
    const texts = [];
    const walk = node => { texts.push(node.textContent); node.children.forEach(walk); };
    walk(documentRef.getElementById('vertex-paygo-settings'));
    assert.ok(texts.some(value => value.includes('Google OpenAI-compatible bridge is unavailable in TauriTavern')));
    ui.destroy();
});

test('bridge API logs load only on demand, render raw text safely, clear, and gate older backends', async () => {
    const documentRef = nativeDocument();
    let supported = true;
    let reads = 0;
    let clears = 0;
    const raw = '<script>alert("raw")</script>\n' + 'long'.repeat(100);
    const ui = createOpenAiBridgeUi({ context: nativeContext(), documentRef, localize: createLocalizer(), serverClient: {
        checkHealth: async () => ({ capabilities: { openaiBridge: true, openaiBridgeLogs: supported } }),
        readOpenAiBridge: async () => enabled,
        readOpenAiBridgeLogs: async () => { reads++; return { ok: true, entries: [{ timestamp: 'now', method: 'POST', path: '/chat/completions', status: 502, durationMs: 45, requestBody: raw, forwardedBody: '{"contents":[]}', responseBody: 'upstream failure', error: { code: 'UPSTREAM', message: 'failed' }, truncated: true, interrupted: true, requestIncomplete: true }] }; },
        clearOpenAiBridgeLogs: async () => { clears++; return { ok: true, entries: [] }; },
    } });
    await tick();
    assert.equal(reads, 0);
    const refresh = documentRef.getElementById('vertex-paygo-bridge-logs-refresh');
    const clear = documentRef.getElementById('vertex-paygo-bridge-logs-clear');
    assert.equal(refresh.disabled, false);
    await refresh.fire('click'); await tick();
    assert.equal(reads, 1);
    const entries = documentRef.getElementById('vertex-paygo-bridge-logs-entries');
    const details = entries.children[0];
    assert.equal(details.tagName, 'DETAILS');
    const bodies = details.children.filter(node => node.tagName === 'PRE');
    assert.equal(bodies.length, 4);
    assert.equal(bodies[0].textContent, raw);
    assert.equal(bodies[0].children.length, 0);
    assert.ok(bodies[3].textContent.includes('UPSTREAM'));
    assert.ok(details.children.some(node => node.textContent === 'Response interrupted.'));
    assert.ok(details.children.some(node => node.textContent === 'Request body was not fully received.'));
    await clear.fire('click'); await tick();
    assert.equal(clears, 1);
    assert.equal(entries.children.length, 0);
    supported = false; await ui.refresh();
    assert.equal(refresh.disabled, true);
    await refresh.fire('click'); await tick();
    assert.equal(reads, 1);
    ui.destroy();
});

test('API log client sends host headers, uses dedicated routes, and rejects invalid results', async () => {
    const requests = [];
    let result = { ok: true, entries: [] };
    const client = createServerClient({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'token' }),
        fetchImpl: async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } }); } });
    await client.readOpenAiBridgeLogs();
    await client.clearOpenAiBridgeLogs();
    assert.deepEqual(requests.map(({ url, options }) => [url, options.method]), [
        ['/api/plugins/vertex-paygo/openai-bridge/logs', 'GET'],
        ['/api/plugins/vertex-paygo/openai-bridge/logs/clear', 'POST'],
    ]);
    assert.equal(requests[1].options.headers['X-CSRF-Token'], 'token');
    assert.equal(requests[0].options.cache, 'no-store');
    result = { ok: true, entries: [null] };
    await assert.rejects(client.readOpenAiBridgeLogs(), error => error.code === 'INVALID_BRIDGE_LOG_RESPONSE');
    result = { ok: true, entries: [{ id: 'uncleared' }] };
    await assert.rejects(client.clearOpenAiBridgeLogs(), error => error.code === 'INVALID_BRIDGE_LOG_RESPONSE');
});
