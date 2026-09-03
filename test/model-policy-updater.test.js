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

import { BUNDLED_MODEL_POLICY, MODEL_POLICY_SNAPSHOT, getTierSupport } from '../src/model-policy.js';
import {
    MODEL_POLICY_CACHE_KEY,
    MODEL_POLICY_GITHUB_URL,
    MODEL_POLICY_REFRESH_INTERVAL_MS,
    parseModelPolicyDocument,
    refreshModelPolicyFromGitHub,
    restoreBundledModelPolicy,
    restoreCachedModelPolicy,
} from '../src/model-policy-updater.js';
import { TIER } from '../src/constants.js';

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
