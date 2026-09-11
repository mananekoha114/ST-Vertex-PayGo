/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createClientLogger,
    getSafeErrorContext,
    normalizeClientLogContext,
    normalizeClientLogEntry,
} from '../src/client-logger.js';

test('client log entries retain only server-approved scalar context', () => {
    assert.deepEqual(normalizeClientLogEntry('warn', 'request.blocked', {
        clientVersion: '0.3.0',
        protocolVersion: 1,
        phase: 'blocked',
        statusCode: 409,
        errorCode: 'GLOBAL_REGION_REQUIRED',
        model: 'claude-3-7-sonnet',
        tier: 'flex',
        region: 'global',
        stream: true,
        paygoOnly: false,
        durationMs: 12,
        proxySecret: 'must-not-leak',
        prompt: 'must-not-leak',
        nested: { token: 'must-not-leak' },
    }), {
        level: 'warn',
        event: 'request.blocked',
        context: {
            clientVersion: '0.3.0',
            protocolVersion: 1,
            phase: 'blocked',
            statusCode: 409,
            errorCode: 'GLOBAL_REGION_REQUIRED',
            model: 'claude-3-7-sonnet',
            tier: 'flex',
            region: 'global',
            stream: true,
            paygoOnly: false,
            durationMs: 12,
        },
    });
    assert.equal(normalizeClientLogEntry('debug', 'request.started'), null);
    assert.equal(normalizeClientLogEntry('info', 'bad event'), null);
});

test('client context mirrors server numeric and identifier boundaries', () => {
    assert.deepEqual(normalizeClientLogContext({
        statusCode: 99,
        durationMs: 86_400_001,
        model: 'unsafe/model?key=secret',
        region: 'US-CENTRAL1',
        errorCode: '_invalid',
    }), {});
    assert.deepEqual(normalizeClientLogContext({
        statusCode: 599,
        durationMs: 86_400_000,
        model: 'gemma-3-27b-it',
        region: 'us-central1',
        errorCode: 'HTTP_ERROR',
    }), {
        statusCode: 599,
        durationMs: 86_400_000,
        model: 'gemma-3-27b-it',
        region: 'us-central1',
        errorCode: 'HTTP_ERROR',
    });
    assert.deepEqual(getSafeErrorContext({ code: 'TIMEOUT', status: 504, stack: 'secret' }), {
        errorCode: 'TIMEOUT',
        statusCode: 504,
    });
});

test('failed client log delivery stays queued and a later flush retries in order', async () => {
    const delivered = [];
    let attempts = 0;
    const logger = createClientLogger({
        clientVersion: '0.3.0',
        protocolVersion: 1,
        sessionId: 'session-1',
        randomUUID: () => 'request-1',
        consoleImpl: {},
        sendEntry: async entry => {
            attempts += 1;
            if (attempts === 1) throw new Error('offline');
            delivered.push(entry);
        },
    });

    logger.event('info', 'extension.init_started', { phase: 'started' });
    await logger.flush();
    assert.equal(logger.getPendingCount(), 1);
    await logger.flush();
    assert.equal(logger.getPendingCount(), 0);
    assert.equal(attempts, 2);
    assert.deepEqual(delivered[0].context, {
        clientVersion: '0.3.0',
        protocolVersion: 1,
        clientSessionId: 'session-1',
        phase: 'started',
    });
    assert.equal(logger.createRequestId(), 'request-1');
});

test('flush never throws and arbitrary console messages are never transported', async () => {
    let sends = 0;
    const logger = createClientLogger({
        sessionId: 'session-1',
        consoleImpl: { error() {} },
        sendEntry: async () => {
            sends += 1;
            throw new Error('still offline');
        },
    });

    logger.error('Authorization: Bearer must-not-be-sent');
    assert.equal(sends, 0);
    logger.event('error', 'extension.init_failed', { phase: 'failed' });
    await assert.doesNotReject(() => logger.flush());
    assert.equal(logger.getPendingCount(), 1);
    assert.ok(sends >= 1);
});

test('pending client log queue is bounded while delivery is stalled', () => {
    const logger = createClientLogger({
        sessionId: 'session-1',
        maxPendingEntries: 2,
        consoleImpl: {},
        sendEntry: () => new Promise(() => {}),
    });
    logger.event('info', 'event.one');
    logger.event('info', 'event.two');
    logger.event('info', 'event.three');
    assert.equal(logger.getPendingCount(), 2);
});

test('delivery waits for server capability and cannot override trusted client metadata', async () => {
    const delivered = [];
    const logger = createClientLogger({
        clientVersion: '0.3.0',
        protocolVersion: 1,
        sessionId: 'trusted-session',
        deliveryEnabled: false,
        consoleImpl: {},
        sendEntry: async entry => delivered.push(entry),
    });

    logger.event('info', 'extension.init_started', {
        clientVersion: '9.9.9',
        protocolVersion: 99,
        clientSessionId: 'spoofed-session',
        phase: 'started',
    });
    await logger.flush();
    assert.equal(delivered.length, 0);
    assert.equal(logger.getPendingCount(), 1);

    logger.setDeliveryEnabled(true);
    await logger.flush();
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0].context, {
        clientVersion: '0.3.0',
        protocolVersion: 1,
        clientSessionId: 'trusted-session',
        phase: 'started',
    });

    logger.setDeliveryEnabled(false);
    logger.event('info', 'event.after_disable');
    await logger.flush();
    assert.equal(logger.getPendingCount(), 0);
    assert.equal(delivered.length, 1);
});
