/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inferUpdateChannel, selectUpdateMode } = require('../scripts/update-channel.cjs');

test('default updates choose the current branch before recorded metadata', () => {
    assert.deepEqual(inferUpdateChannel({ symbolicBranch: 'development', recordedBranch: 'main', recordedTag: 'v0.5.0' }),
        { branch: 'development', mode: 'commit', tag: null, source: 'branch' });
    assert.deepEqual(inferUpdateChannel({ recordedBranch: 'main', recordedTag: 'v0.5.0' }),
        { branch: 'main', mode: 'tag', tag: 'v0.5.0', source: 'metadata' });
    assert.equal(inferUpdateChannel({ symbolicBranch: 'main' }).mode, 'tag');
    assert.equal(inferUpdateChannel({ recordedBranch: 'development' }).mode, 'commit');
});

test('detached legacy tags identify main while unknown histories stay explicit', () => {
    assert.deepEqual(inferUpdateChannel({ headTag: 'v0.5.0' }),
        { branch: 'main', mode: 'tag', tag: 'v0.5.0', source: 'tag' });
    assert.equal(inferUpdateChannel(), null);
    assert.equal(inferUpdateChannel({ allowUnmanaged: true }).branch, 'main');
});

test('only the current invocation may override the default mode', () => {
    assert.equal(selectUpdateMode({ branch: 'main' }), 'tag');
    assert.equal(selectUpdateMode({ branch: 'development' }), 'commit');
    assert.equal(selectUpdateMode({ branch: 'main', mode: 'commit' }), 'commit');
    assert.equal(selectUpdateMode({ branch: 'main', commit: 'abcdef1' }), 'commit');
    assert.equal(selectUpdateMode({ branch: 'main', tag: 'v0.5.0' }), 'tag');
    assert.equal(selectUpdateMode({ branch: 'main' }), 'tag');
});
