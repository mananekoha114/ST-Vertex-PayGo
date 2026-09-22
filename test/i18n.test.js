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

import { CLIENT_VERSION, TIER } from '../src/constants.js';
import {
    MESSAGES,
    createLocalizer,
    formatMessage,
    getTierLabel,
    localizeError,
    localizeSupport,
    localizeValidation,
} from '../src/i18n.js';
import { MODEL_POLICY_SNAPSHOT } from '../src/model-policy.js';

async function readJson(relativePath) {
    return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
}

function getParameters(message) {
    return [...String(message).matchAll(/\{([a-zA-Z0-9_]+)\}/gu)].map(match => match[1]).sort();
}

test('manifest exposes exact SillyTavern locale IDs and package version matches', async () => {
    const [manifest, packageJson] = await Promise.all([
        readJson('../manifest.json'),
        readJson('../package.json'),
    ]);

    assert.deepEqual(manifest.i18n, {
        'zh-cn': 'locales/zh-cn.json',
        'zh-tw': 'locales/zh-tw.json',
    });
    assert.equal(manifest.version, packageJson.version);
    assert.equal(packageJson.version, CLIENT_VERSION);
});

test('every locale has exactly one non-empty string for every message key', async () => {
    const expectedKeys = Object.keys(MESSAGES).sort();

    for (const localePath of ['../locales/zh-cn.json', '../locales/zh-tw.json']) {
        const locale = await readJson(localePath);
        assert.deepEqual(Object.keys(locale).sort(), expectedKeys, localePath);
        for (const [key, value] of Object.entries(locale)) {
            assert.equal(typeof value, 'string', `${localePath}: ${key}`);
            assert.notEqual(value.trim(), '', `${localePath}: ${key}`);
            assert.deepEqual(getParameters(value), getParameters(MESSAGES[key]), `${localePath}: ${key}`);
        }
    }
});

test('localizer uses namespaced translations and interpolates named parameters', () => {
    const calls = [];
    const localize = createLocalizer((fallback, key) => {
        calls.push({ fallback, key });
        return key === 'vertex_paygo.status.tier_global'
            ? '{tier} 计费将使用 global 端点。'
            : fallback;
    });

    assert.equal(
        localize('vertex_paygo.status.tier_global', { tier: 'Flex（灵活）' }),
        'Flex（灵活） 计费将使用 global 端点。',
    );
    assert.deepEqual(calls[0], {
        fallback: MESSAGES['vertex_paygo.status.tier_global'],
        key: 'vertex_paygo.status.tier_global',
    });
});

test('localizer safely falls back to English when translation is unavailable', () => {
    const localize = createLocalizer(() => { throw new Error('locale not loaded'); });
    assert.equal(localize('vertex_paygo.popup.tier_region.accept', { tier: 'Flex' }), 'Use Flex and global');
    assert.equal(formatMessage('Keep {tier}; preserve {unknown}.', { tier: 'Priority' }), 'Keep Priority; preserve {unknown}.');
});

test('policy and validation objects are localized by stable codes instead of English reasons', () => {
    const translations = {
        'vertex_paygo.tier.flex': 'Flex（灵活）',
        'vertex_paygo.policy.unverified': '未验证：{date}',
        'vertex_paygo.validation.global_required': '{tier} 必须使用 global',
    };
    const localize = createLocalizer((fallback, key) => translations[key] ?? fallback);

    assert.equal(getTierLabel(localize, TIER.FLEX), 'Flex（灵活）');
    assert.equal(
        localizeSupport(localize, { level: 'unverified', reason: 'raw English reason' }, TIER.FLEX),
        `未验证：${MODEL_POLICY_SNAPSHOT}`,
    );
    assert.equal(
        localizeSupport(localize, { level: 'unverified', snapshot: '2026-01-01' }, TIER.FLEX),
        '未验证：2026-01-01',
    );
    assert.equal(
        localizeValidation(localize, { code: 'TIER_REQUIRES_GLOBAL', message: 'raw English message' }, { tier: TIER.FLEX }),
        'Flex（灵活） 必须使用 global',
    );
});

test('server errors are localized by protocol code with unknown errors preserved', () => {
    const localize = createLocalizer((fallback, key) => (
        key === 'vertex_paygo.server_error.protocol' ? '需要协议 v{version}' : fallback
    ));

    assert.equal(localizeError(localize, { code: 'PROTOCOL_MISMATCH' }), '需要协议 v2');
    assert.equal(localizeError(localize, { code: 'LOG_TOO_LARGE' }), 'Server Plugin log exceeds the 5 MiB limit.');
    assert.equal(localizeError(localize, { code: 'INVALID_LOG_RESPONSE' }), 'Server Plugin returned an invalid log response.');
    assert.equal(localizeError(localize, new Error('opaque upstream failure')), 'opaque upstream failure');
});
