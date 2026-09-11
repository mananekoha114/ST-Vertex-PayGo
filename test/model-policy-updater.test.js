/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { BUNDLED_MODEL_POLICY, MODEL_POLICY_SNAPSHOT, getActiveModelPolicy, getTierSupport } from '../src/model-policy.js';
import {
    MODEL_POLICY_CACHE_KEY,
    MODEL_POLICY_GITHUB_URL,
    MODEL_POLICY_REFRESH_INTERVAL_MS,
    parseModelPolicyDocument,
    refreshModelPolicyFromGitHub,
    restoreBundledModelPolicy,
    restoreCachedModelPolicy,
} from '../src/model-policy-updater.js';
import { AI_STUDIO_SOURCE, TIER } from '../src/constants.js';
import { planPersistedReconciliation } from '../src/reconciliation.js';
import { createRequestHook } from '../src/request-hook.js';

const silentLogger = { warn() {} };

function createStorage(initialValue = null) {
    const values = new Map();
    if (initialValue !== null) values.set(MODEL_POLICY_CACHE_KEY, initialValue);
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        value: key => values.get(key) ?? null,
    };
}

function responseFor(document) {
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(document),
    };
}

function currentBasedPolicy({
    updatedAt = '2026-09-04',
    flexAdditions = [],
    priorityAdditions = [],
    knownAdditions = [...flexAdditions, ...priorityAdditions],
} = {}) {
    return {
        schemaVersion: 1,
        updatedAt,
        tiers: {
            flex: [...BUNDLED_MODEL_POLICY.tiers.flex, ...flexAdditions],
            priority: [...BUNDLED_MODEL_POLICY.tiers.priority, ...priorityAdditions],
        },
        knownModels: [...BUNDLED_MODEL_POLICY.knownModels, ...knownAdditions],
        aiStudio: BUNDLED_MODEL_POLICY.aiStudio,
    };
}

function aiStudioPolicy(overrides = {}) {
    return {
        ...BUNDLED_MODEL_POLICY,
        aiStudio: {
            ...BUNDLED_MODEL_POLICY.aiStudio,
            updatedAt: '2026-09-11',
            ...overrides,
        },
    };
}

test.afterEach(() => {
    restoreBundledModelPolicy();
});

test('the repository document matches the bundled fallback and production GitHub path', async () => {
    const document = JSON.parse(await readFile(new URL('../data/model-support.json', import.meta.url), 'utf8'));
    const parsed = parseModelPolicyDocument(document);

    assert.deepEqual(parsed, BUNDLED_MODEL_POLICY);
    assert.match(MODEL_POLICY_GITHUB_URL, /\/main\/data\/model-support\.json$/u);
    assert.equal(MODEL_POLICY_REFRESH_INTERVAL_MS, 6 * 60 * 60 * 1_000);
});

test('strict validation rejects incompatible, malformed, or incomplete documents', () => {
    const valid = currentBasedPolicy();

    assert.throws(
        () => parseModelPolicyDocument({ ...valid, schemaVersion: 2 }),
        error => error.code === 'UNSUPPORTED_SCHEMA',
    );
    assert.throws(
        () => parseModelPolicyDocument({ ...valid, updatedAt: '2026-02-30' }),
        error => error.code === 'INVALID_DATE',
    );
    assert.throws(
        () => parseModelPolicyDocument({
            ...valid,
            tiers: { ...valid.tiers, flex: ['claude-sonnet-4'] },
            knownModels: [...valid.knownModels, 'claude-sonnet-4'],
        }),
        error => error.code === 'INVALID_MODEL_ID',
    );
    assert.throws(
        () => parseModelPolicyDocument({ ...valid, knownModels: valid.knownModels.slice(1) }),
        error => error.code === 'INCOMPLETE_KNOWN_MODELS',
    );
    assert.throws(
        () => parseModelPolicyDocument({
            ...valid,
            knownModels: [...valid.knownModels, valid.knownModels[0].toUpperCase()],
        }),
        error => error.code === 'DUPLICATE_MODEL_ID',
    );
});

test('a valid GitHub response replaces policy atomically and becomes the last-known-good cache', async () => {
    const model = 'gemini-4-priority-test';
    const document = currentBasedPolicy({ priorityAdditions: [model] });
    const storage = createStorage();
    const calls = [];

    const result = await refreshModelPolicyFromGitHub({
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return responseFor(document);
        },
        storage,
        logger: silentLogger,
    });

    assert.deepEqual(
        { applied: result.applied, changed: result.changed, source: result.source, snapshot: result.snapshot },
        { applied: true, changed: true, source: 'github', snapshot: '2026-09-04' },
    );
    assert.equal(getTierSupport(model, TIER.PRIORITY).level, 'known');
    assert.equal(getTierSupport(model, TIER.FLEX).level, 'unsupported');
    assert.deepEqual(JSON.parse(storage.value(MODEL_POLICY_CACHE_KEY)), parseModelPolicyDocument(document));
    assert.equal(calls[0].url, MODEL_POLICY_GITHUB_URL);
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(calls[0].options.credentials, 'omit');
    assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
    assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('an unchanged GitHub policy is cached without triggering downstream reconciliation', async () => {
    const storage = createStorage();
    const result = await refreshModelPolicyFromGitHub({
        fetchImpl: async () => responseFor(BUNDLED_MODEL_POLICY),
        storage,
        logger: silentLogger,
    });

    assert.equal(result.applied, true);
    assert.equal(result.changed, false);
    assert.notEqual(storage.value(MODEL_POLICY_CACHE_KEY), null);
});

test('a valid cache is restored before a failed GitHub refresh and remains active', async () => {
    const model = 'gemini-4-flex-test';
    const cachedPolicy = currentBasedPolicy({ flexAdditions: [model] });
    const storage = createStorage(JSON.stringify(cachedPolicy));

    const restored = restoreCachedModelPolicy({ storage, logger: silentLogger });
    const refreshed = await refreshModelPolicyFromGitHub({
        fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }),
        storage,
        logger: silentLogger,
    });

    assert.equal(restored.applied, true);
    assert.equal(restored.changed, true);
    assert.equal(refreshed.applied, false);
    assert.equal(MODEL_POLICY_SNAPSHOT, '2026-09-04');
    assert.equal(getTierSupport(model, TIER.FLEX).level, 'known');
});

test('stale or invalid cache entries never replace the bundled policy', () => {
    const stale = currentBasedPolicy({ updatedAt: '2026-09-02' });
    const staleResult = restoreCachedModelPolicy({
        storage: createStorage(JSON.stringify(stale)),
        logger: silentLogger,
    });
    const invalidResult = restoreCachedModelPolicy({
        storage: createStorage('<html>not json</html>'),
        logger: silentLogger,
    });

    assert.equal(staleResult.applied, false);
    assert.equal(staleResult.error.code, 'STALE_POLICY');
    assert.equal(invalidResult.applied, false);
    assert.equal(invalidResult.error.code, 'INVALID_JSON');
    assert.equal(MODEL_POLICY_SNAPSHOT, BUNDLED_MODEL_POLICY.updatedAt);
});

test('a poisoned future cache is rejected and cannot pin later GitHub updates', async () => {
    const storage = createStorage(JSON.stringify(currentBasedPolicy({ updatedAt: '9999-12-31' })));
    const now = Date.UTC(2026, 8, 3, 12);

    const restored = restoreCachedModelPolicy({ storage, logger: silentLogger, now });
    assert.equal(restored.applied, false);
    assert.equal(restored.error.code, 'FUTURE_POLICY');

    const valid = currentBasedPolicy({ updatedAt: '2026-09-04' });
    const refreshed = await refreshModelPolicyFromGitHub({
        fetchImpl: async () => responseFor(valid),
        storage,
        logger: silentLogger,
        now,
    });
    assert.equal(refreshed.applied, true);
    assert.equal(MODEL_POLICY_SNAPSHOT, '2026-09-04');
});

test('known-model tombstones cannot be removed by a newer GitHub document', async () => {
    const retiredModel = 'gemini-4-retired-test';
    const firstPolicy = currentBasedPolicy({ knownAdditions: [retiredModel] });
    const storage = createStorage();
    const first = await refreshModelPolicyFromGitHub({
        fetchImpl: async () => responseFor(firstPolicy),
        storage,
        logger: silentLogger,
    });
    assert.equal(first.applied, true);
    assert.equal(getTierSupport(retiredModel, TIER.FLEX).level, 'unsupported');

    const incompletePolicy = currentBasedPolicy({ updatedAt: '2026-09-05' });
    const second = await refreshModelPolicyFromGitHub({
        fetchImpl: async () => responseFor(incompletePolicy),
        storage,
        logger: silentLogger,
    });

    assert.equal(second.applied, false);
    assert.equal(second.error.code, 'INCOMPLETE_MODEL_HISTORY');
    assert.equal(MODEL_POLICY_SNAPSHOT, '2026-09-04');
    assert.equal(getTierSupport(retiredModel, TIER.PRIORITY).level, 'unsupported');
    assert.deepEqual(JSON.parse(storage.value(MODEL_POLICY_CACHE_KEY)), parseModelPolicyDocument(firstPolicy));
});

test('invalid GitHub data and cache write failures preserve a safe in-memory policy', async () => {
    const invalid = currentBasedPolicy({ updatedAt: '2026-09-05' });
    invalid.knownModels = invalid.knownModels.slice(1);
    const invalidResult = await refreshModelPolicyFromGitHub({
        fetchImpl: async () => responseFor(invalid),
        storage: createStorage(),
        logger: silentLogger,
    });
    assert.equal(invalidResult.applied, false);
    assert.equal(MODEL_POLICY_SNAPSHOT, BUNDLED_MODEL_POLICY.updatedAt);

    const model = 'gemini-4-cache-write-test';
    const valid = currentBasedPolicy({ flexAdditions: [model] });
    const validResult = await refreshModelPolicyFromGitHub({
        fetchImpl: async () => responseFor(valid),
        storage: {
            getItem: () => null,
            setItem: () => { throw new Error('quota exceeded'); },
        },
        logger: silentLogger,
    });
    assert.equal(validResult.applied, true);
    assert.equal(getTierSupport(model, TIER.FLEX).level, 'known');
});

test('oversized GitHub responses are rejected before buffering or installing them', async () => {
    let textCalled = false;
    const declaredOversize = await refreshModelPolicyFromGitHub({
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: { get: name => name === 'content-length' ? String(64 * 1024 + 1) : null },
            text: async () => {
                textCalled = true;
                return JSON.stringify(BUNDLED_MODEL_POLICY);
            },
        }),
        logger: silentLogger,
    });
    assert.equal(declaredOversize.applied, false);
    assert.equal(declaredOversize.error.code, 'INVALID_SIZE');
    assert.equal(textCalled, false);

    const streamedOversize = await refreshModelPolicyFromGitHub({
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: new ReadableStream({
                start(streamController) {
                    streamController.enqueue(new Uint8Array(64 * 1024));
                    streamController.enqueue(new Uint8Array(1));
                },
            }),
        }),
        logger: silentLogger,
    });
    assert.equal(streamedOversize.applied, false);
    assert.equal(streamedOversize.error.code, 'INVALID_SIZE');
    assert.equal(MODEL_POLICY_SNAPSHOT, BUNDLED_MODEL_POLICY.updatedAt);
});

test('a timed-out GitHub request keeps the active fallback', async () => {
    const result = await refreshModelPolicyFromGitHub({
        fetchImpl: async (_url, { signal }) => await new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }),
        timeoutMs: 5,
        logger: silentLogger,
    });

    assert.equal(result.applied, false);
    assert.equal(result.error.name, 'AbortError');
    assert.equal(MODEL_POLICY_SNAPSHOT, BUNDLED_MODEL_POLICY.updatedAt);
});

test('AI Studio-only changes use the existing fetch, cache, and change notification without affecting Vertex', async () => {
    const model = 'gemini-ai-studio-new';
    const document = aiStudioPolicy({
        tiers: { flex: [...BUNDLED_MODEL_POLICY.aiStudio.tiers.flex, model] },
        knownModels: [...BUNDLED_MODEL_POLICY.aiStudio.knownModels, model],
    });
    const storage = createStorage();
    let fetches = 0;
    const result = await refreshModelPolicyFromGitHub({
        fetchImpl: async (url, options) => {
            fetches++;
            assert.equal(url, MODEL_POLICY_GITHUB_URL);
            assert.equal(options.credentials, 'omit');
            return responseFor(document);
        },
        storage, logger: silentLogger,
    });

    assert.equal(fetches, 1);
    assert.equal(result.applied, true);
    assert.equal(result.changed, true);
    assert.equal(MODEL_POLICY_SNAPSHOT, BUNDLED_MODEL_POLICY.updatedAt);
    assert.equal(getTierSupport(model, TIER.FLEX, AI_STUDIO_SOURCE).level, 'known');
    assert.equal(getTierSupport(model, TIER.FLEX, AI_STUDIO_SOURCE).snapshot, '2026-09-11');
    assert.equal(getTierSupport(model, TIER.FLEX).level, 'unverified');
    assert.deepEqual(getActiveModelPolicy().tiers, BUNDLED_MODEL_POLICY.tiers);
    assert.deepEqual(JSON.parse(storage.value(MODEL_POLICY_CACHE_KEY)), parseModelPolicyDocument(document));

    restoreBundledModelPolicy();
    assert.equal(restoreCachedModelPolicy({ storage, logger: silentLogger }).applied, true);
    const failed = await refreshModelPolicyFromGitHub({
        fetchImpl: async () => { throw new Error('offline'); }, storage, logger: silentLogger,
    });
    assert.equal(failed.applied, false);
    assert.equal(getTierSupport(model, TIER.FLEX, AI_STUDIO_SOURCE).level, 'known');
});

test('same-date AI Studio roster changes notify consumers but reordering does not', async () => {
    const initial = aiStudioPolicy();
    const storage = createStorage();
    const refresh = document => refreshModelPolicyFromGitHub({
        fetchImpl: async () => responseFor(document), storage, logger: silentLogger,
    });
    assert.equal((await refresh(initial)).changed, true);
    const retired = 'gemini-2.5-pro';
    const changed = aiStudioPolicy({ tiers: { flex: initial.aiStudio.tiers.flex.filter(model => model !== retired) } });
    assert.equal((await refresh(changed)).changed, true);
    assert.equal(getTierSupport(retired, TIER.FLEX, AI_STUDIO_SOURCE).level, 'unsupported');
    assert.equal(getTierSupport(retired, TIER.PRIORITY).level, 'known');
    const reordered = aiStudioPolicy({
        tiers: { flex: [...changed.aiStudio.tiers.flex].reverse() },
        knownModels: [...changed.aiStudio.knownModels].reverse(),
    });
    assert.equal((await refresh(reordered)).changed, false);
    assert.deepEqual(getActiveModelPolicy(), JSON.parse(storage.value(MODEL_POLICY_CACHE_KEY)));
});

test('AI Studio history-only updates and an empty Flex roster still refresh the policy', async () => {
    const storage = createStorage();
    const model = 'gemini-ai-studio-retired';
    const history = aiStudioPolicy({
        knownModels: [...BUNDLED_MODEL_POLICY.aiStudio.knownModels, model],
    });
    const refresh = document => refreshModelPolicyFromGitHub({ fetchImpl: async () => responseFor(document), storage, logger: silentLogger });
    assert.equal((await refresh(aiStudioPolicy())).applied, true);
    assert.equal((await refresh(history)).changed, true);
    assert.equal(getTierSupport(model, TIER.FLEX, AI_STUDIO_SOURCE).level, 'unsupported');
    assert.equal(getTierSupport(model, TIER.FLEX).level, 'unverified');
    const disabled = { ...history, aiStudio: { ...history.aiStudio, tiers: { flex: [] } } };
    assert.equal((await refresh(disabled)).changed, true);
    assert.equal(getTierSupport('gemini-2.5-pro', TIER.FLEX, AI_STUDIO_SOURCE).allowed, false);
    assert.equal(getTierSupport('gemini-3.8-flash', TIER.FLEX).allowed, true);
});

test('an AI Studio model removed by the repository is blocked by reconciliation and the request hook', async () => {
    const model = 'gemini-2.5-pro';
    const document = aiStudioPolicy({ tiers: { flex: BUNDLED_MODEL_POLICY.aiStudio.tiers.flex.filter(value => value !== model) } });
    const result = await refreshModelPolicyFromGitHub({
        fetchImpl: async () => responseFor(document), storage: createStorage(), logger: silentLogger,
    });
    assert.equal(result.changed, true);
    const state = { tier: TIER.FLEX, paygoOnly: false };
    const plan = planPersistedReconciliation({ state, source: AI_STUDIO_SOURCE, model });
    assert.equal(plan.type, 'conflict');
    assert.equal(plan.validation.code, 'MODEL_UNSUPPORTED');
    const data = { chat_completion_source: AI_STUDIO_SOURCE, model, stream: true };
    await createRequestHook({
        stateProvider: () => state,
        serverClient: { prepare: async () => assert.fail('retired model must not reach prepare') },
        origin: 'http://localhost:8000', logger: { error() {} },
    })(data);
    assert.match(data.reverse_proxy, /\/rejected$/u);
});

test('legacy Vertex-only responses retain and cache a previously fetched AI Studio roster', async () => {
    const storage = createStorage();
    const model = 'gemini-ai-studio-retained';
    const updated = aiStudioPolicy({
        tiers: { flex: [...BUNDLED_MODEL_POLICY.aiStudio.tiers.flex, model] },
        knownModels: [...BUNDLED_MODEL_POLICY.aiStudio.knownModels, model],
    });
    await refreshModelPolicyFromGitHub({ fetchImpl: async () => responseFor(updated), storage, logger: silentLogger });
    const legacy = currentBasedPolicy();
    delete legacy.aiStudio;
    const result = await refreshModelPolicyFromGitHub({ fetchImpl: async () => responseFor(legacy), storage, logger: silentLogger });
    assert.equal(result.applied, true);
    assert.equal(getTierSupport(model, TIER.FLEX, AI_STUDIO_SOURCE).level, 'known');
    assert.deepEqual(JSON.parse(storage.value(MODEL_POLICY_CACHE_KEY)).aiStudio, updated.aiStudio);

    restoreBundledModelPolicy();
    assert.equal(restoreCachedModelPolicy({ storage, logger: silentLogger }).applied, true);
    assert.equal(getTierSupport(model, TIER.FLEX, AI_STUDIO_SOURCE).snapshot, '2026-09-11');
    const unchanged = await refreshModelPolicyFromGitHub({ fetchImpl: async () => responseFor(legacy), storage, logger: silentLogger });
    assert.equal(unchanged.changed, false);
    assert.equal(getTierSupport(model, TIER.FLEX, AI_STUDIO_SOURCE).level, 'known');
});

test('old caches without AI Studio remain readable and preserve its bundled policy', () => {
    const legacy = currentBasedPolicy();
    delete legacy.aiStudio;
    assert.equal(Object.hasOwn(parseModelPolicyDocument(legacy), 'aiStudio'), false);
    const result = restoreCachedModelPolicy({ storage: createStorage(JSON.stringify(legacy)), logger: silentLogger });
    assert.equal(result.applied, true);
    assert.equal(MODEL_POLICY_SNAPSHOT, legacy.updatedAt);
    assert.deepEqual(getActiveModelPolicy().aiStudio, BUNDLED_MODEL_POLICY.aiStudio);
});

test('invalid AI Studio sections reject the whole update and preserve both active policies and cache', async () => {
    const baseline = BUNDLED_MODEL_POLICY.aiStudio;
    const storage = createStorage(JSON.stringify(BUNDLED_MODEL_POLICY));
    for (const [aiStudio, code] of [
        [null, 'INVALID_DOCUMENT'],
        [[], 'INVALID_DOCUMENT'],
        [{ ...baseline, updatedAt: '2026-02-30' }, 'INVALID_DATE'],
        [{ ...baseline, tiers: null }, 'INVALID_TIERS'],
        [{ ...baseline, tiers: {} }, 'INVALID_MODELS'],
        [{ ...baseline, tiers: { flex: ['claude-sonnet-4'] } }, 'INVALID_MODEL_ID'],
        [{ ...baseline, tiers: { flex: ['gemini-2.5-pro', 'GEMINI-2.5-PRO'] } }, 'DUPLICATE_MODEL_ID'],
        [{ ...baseline, knownModels: baseline.knownModels.slice(1) }, 'INCOMPLETE_KNOWN_MODELS'],
        [{ ...baseline, knownModels: Array(257).fill('gemini-2.5-pro') }, 'INVALID_MODELS'],
    ]) {
        const result = await refreshModelPolicyFromGitHub({
            fetchImpl: async () => responseFor({ ...currentBasedPolicy(), aiStudio }), storage, logger: silentLogger,
        });
        assert.equal(result.applied, false);
        assert.equal(result.error.code, code);
        assert.deepEqual(getActiveModelPolicy(), BUNDLED_MODEL_POLICY);
        assert.deepEqual(JSON.parse(storage.value(MODEL_POLICY_CACHE_KEY)), BUNDLED_MODEL_POLICY);
    }
});

test('AI Studio dates and model history are checked independently for both cache and network updates', async () => {
    const model = 'gemini-ai-studio-history';
    const updated = aiStudioPolicy({
        tiers: { flex: [...BUNDLED_MODEL_POLICY.aiStudio.tiers.flex, model] },
        knownModels: [...BUNDLED_MODEL_POLICY.aiStudio.knownModels, model],
    });
    const storage = createStorage();
    await refreshModelPolicyFromGitHub({ fetchImpl: async () => responseFor(updated), storage, logger: silentLogger });
    for (const [aiStudio, code] of [
        [{ ...updated.aiStudio, updatedAt: '2026-09-09' }, 'STALE_POLICY'],
        [{ ...updated.aiStudio, updatedAt: '9999-12-31' }, 'FUTURE_POLICY'],
        [{ ...BUNDLED_MODEL_POLICY.aiStudio, updatedAt: '2026-09-12' }, 'INCOMPLETE_MODEL_HISTORY'],
    ]) {
        const document = { ...currentBasedPolicy(), aiStudio };
        const cached = restoreCachedModelPolicy({ storage: createStorage(JSON.stringify(document)), logger: silentLogger });
        const fetched = await refreshModelPolicyFromGitHub({ fetchImpl: async () => responseFor(document), storage, logger: silentLogger });
        assert.equal(cached.applied, false);
        assert.equal(fetched.applied, false);
        assert.equal(cached.error.code, code);
        assert.equal(fetched.error.code, code);
        assert.deepEqual(getActiveModelPolicy(), updated);
        assert.deepEqual(JSON.parse(storage.value(MODEL_POLICY_CACHE_KEY)), updated);
    }
});
