import test from 'node:test';
import assert from 'node:assert/strict';

import { TIER } from '../src/constants.js';
import {
    buildPreparePayload,
    createRequestHook,
    installFailureSink,
} from '../src/request-hook.js';

const ORIGIN = 'http://st.local:8000';

function vertexData(overrides = {}) {
    return {
        chat_completion_source: 'vertexai',
        model: 'gemini-3.1-pro-preview',
        stream: true,
        vertexai_auth_mode: 'full',
        vertexai_region: 'global',
        vertexai_express_project_id: '',
        ...overrides,
    };
}

test('Standard without PayGo-only leaves the native request completely untouched', async () => {
    const data = vertexData({ reverse_proxy: 'https://user-proxy.example' });
    let prepares = 0;
    const hook = createRequestHook({
        stateProvider: () => ({ tier: TIER.STANDARD, paygoOnly: false }),
        serverClient: { prepare: async () => prepares++ },
        origin: ORIGIN,
    });
    await hook(data);
    assert.equal(prepares, 0);
    assert.equal(data.reverse_proxy, 'https://user-proxy.example');
    assert.equal(Object.hasOwn(data, 'proxy_password'), false);
});

test('non-Vertex sources are untouched even when a PayGo state is selected', async () => {
    const data = { chat_completion_source: 'custom', model: 'gemini-3.1-pro-preview' };
    const hook = createRequestHook({
        stateProvider: () => ({ tier: TIER.FLEX, paygoOnly: false }),
        serverClient: { prepare: async () => assert.fail('prepare should not run') },
        origin: ORIGIN,
    });
    await hook(data);
    assert.equal(Object.hasOwn(data, 'reverse_proxy'), false);
});

test('installs the failure sink before awaiting prepare and replaces it only after success', async () => {
    let resolvePrepare;
    let payload;
    const preparePromise = new Promise(resolve => { resolvePrepare = resolve; });
    const data = vertexData();
    const hook = createRequestHook({
        stateProvider: () => ({ version: 1, tier: TIER.FLEX, paygoOnly: true }),
        serverClient: { prepare: value => { payload = value; return preparePromise; } },
        origin: ORIGIN,
        secretFactory: () => 'temporary-block-secret',
    });

    const pending = hook(data);
    assert.equal(data.reverse_proxy, 'http://st.local:8000/api/plugins/vertex-paygo/rejected');
    assert.equal(data.proxy_password, 'temporary-block-secret');

    resolvePrepare({ proxyUrl: `http://127.0.0.1:32145/proxy/${'a'.repeat(32)}`, proxySecret: 'proxy-secret-value' });
    await pending;
    assert.equal(data.reverse_proxy, `http://127.0.0.1:32145/proxy/${'a'.repeat(32)}`);
    assert.equal(data.proxy_password, 'proxy-secret-value');
    assert.deepEqual(payload, {
        protocolVersion: 1,
        chat_completion_source: 'vertexai',
        model: 'gemini-3.1-pro-preview',
        stream: true,
        vertexai_auth_mode: 'full',
        vertexai_region: 'global',
        vertexai_express_project_id: '',
        tier: TIER.FLEX,
        paygoOnly: true,
    });
});

test('prepare failure retains the failure sink and reports a visible error', async () => {
    const errors = [];
    const data = vertexData();
    const hook = createRequestHook({
        stateProvider: () => ({ tier: TIER.PRIORITY, paygoOnly: false }),
        serverClient: { prepare: async () => { throw new Error('Plugin unavailable'); } },
        origin: ORIGIN,
        notifyError: message => errors.push(message),
        logger: { error() {} },
        secretFactory: () => 'blocked',
    });
    await hook(data);
    assert.match(data.reverse_proxy, /\/rejected$/);
    assert.equal(data.proxy_password, 'blocked');
    assert.match(errors[0], /not sent to Vertex AI/);
});

test('invalid tier/region state is blocked before prepare', async () => {
    const errors = [];
    let prepares = 0;
    const data = vertexData({ vertexai_region: 'us-central1' });
    const hook = createRequestHook({
        stateProvider: () => ({ tier: TIER.FLEX, paygoOnly: false }),
        serverClient: { prepare: async () => prepares++ },
        origin: ORIGIN,
        notifyError: message => errors.push(message),
        localize: (key, parameters = {}) => key === 'vertex_paygo.validation.global_required'
            ? `${parameters.tier} 必须使用 global`
            : key === 'vertex_paygo.tier.flex' ? 'Flex（灵活）' : key,
        logger: { error() {} },
    });
    await hook(data);
    assert.equal(prepares, 0);
    assert.match(data.reverse_proxy, /\/rejected$/);
    assert.equal(errors[0], 'Flex（灵活） 必须使用 global');
});

test('pre-existing custom Vertex reverse proxy conflicts fail closed', async () => {
    const errors = [];
    let prepares = 0;
    const data = vertexData({ reverse_proxy: 'https://user-proxy.example', proxy_password: 'user-secret' });
    const hook = createRequestHook({
        stateProvider: () => ({ tier: TIER.PRIORITY, paygoOnly: false }),
        serverClient: { prepare: async () => prepares++ },
        origin: ORIGIN,
        notifyError: message => errors.push(message),
        logger: { error() {} },
        secretFactory: () => 'blocked-conflict',
    });
    await hook(data);
    assert.equal(prepares, 0);
    assert.equal(data.reverse_proxy, 'http://st.local:8000/api/plugins/vertex-paygo/rejected');
    assert.equal(data.proxy_password, 'blocked-conflict');
    assert.match(errors[0], /custom Vertex reverse proxy/i);
});

test('payload builder supplies safe defaults for optional Vertex fields', () => {
    assert.deepEqual(buildPreparePayload(vertexData({
        stream: 0,
        vertexai_auth_mode: ' FULL ',
        vertexai_region: ' GLOBAL ',
        vertexai_express_project_id: ' project-id ',
    }), { tier: TIER.STANDARD, paygoOnly: true }), {
        protocolVersion: 1,
        chat_completion_source: 'vertexai',
        model: 'gemini-3.1-pro-preview',
        stream: false,
        vertexai_auth_mode: 'full',
        vertexai_region: 'global',
        vertexai_express_project_id: 'project-id',
        tier: TIER.STANDARD,
        paygoOnly: true,
    });
});

test('failure sink always installs a non-empty secret', () => {
    const data = {};
    installFailureSink(data, ORIGIN, () => '');
    assert.equal(data.proxy_password, 'blocked');
});

test('failure sink itself cannot throw and retains a non-network URL', () => {
    const data = {};
    assert.doesNotThrow(() => installFailureSink(data, 'not a URL', () => { throw new Error('rng failed'); }));
    assert.equal(data.reverse_proxy, 'vertex-paygo-blocked://request');
    assert.equal(data.proxy_password, 'blocked');
});

test('failure sink does not propagate hostile property setters', () => {
    const data = new Proxy({}, { set() { throw new Error('setter failed'); } });
    assert.doesNotThrow(() => installFailureSink(data, ORIGIN, () => 'secret'));
});
