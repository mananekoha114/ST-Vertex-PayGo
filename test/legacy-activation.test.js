/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const originalDocument = globalThis.document;
delete globalThis.document;
const { installLegacyActivationFallback } = await import('../index.js');
if (originalDocument !== undefined) globalThis.document = originalDocument;

test('legacy activation fallback runs immediately after the document is ready', async () => {
    let calls = 0;
    const installed = installLegacyActivationFallback({
        documentRef: { readyState: 'complete' },
        activate: () => { calls += 1; },
    });

    await Promise.resolve();
    assert.equal(installed, true);
    assert.equal(calls, 1);
});

test('legacy activation fallback waits for DOMContentLoaded while loading', async () => {
    let calls = 0;
    let listener;
    let options;
    const documentRef = {
        readyState: 'loading',
        addEventListener(eventName, handler, eventOptions) {
            assert.equal(eventName, 'DOMContentLoaded');
            listener = handler;
            options = eventOptions;
        },
    };

    const installed = installLegacyActivationFallback({
        documentRef,
        activate: () => { calls += 1; },
    });

    assert.equal(installed, true);
    assert.deepEqual(options, { once: true });
    assert.equal(calls, 0);
    listener();
    await Promise.resolve();
    assert.equal(calls, 1);
});

test('legacy activation fallback is inert without a document', () => {
    assert.equal(installLegacyActivationFallback({ documentRef: undefined }), false);
});
