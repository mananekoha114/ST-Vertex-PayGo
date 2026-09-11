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
    buildLogFilename,
    createLogViewerContent,
    downloadLogText,
    showLogViewer,
} from '../src/log-actions.js';

function createFakeElement(tag) {
    return {
        tag,
        children: [],
        append(...children) {
            this.children.push(...children);
        },
        click() {
            this.clicked = (this.clicked ?? 0) + 1;
        },
        remove() {
            this.removed = true;
        },
        textContent: '',
        className: '',
    };
}

function createFakeDocument() {
    const created = [];
    const body = createFakeElement('body');
    return {
        created,
        body,
        createElement(tag) {
            const element = createFakeElement(tag);
            created.push(element);
            return element;
        },
    };
}

test('log viewer renders hostile and Unicode log text only as textContent', () => {
    const documentRef = createFakeDocument();
    const hostile = '</pre><img src=x onerror=alert(1)><script>bad()</script>\n客户端';
    const content = createLogViewerContent(hostile, {
        documentRef,
        title: '日志',
        description: '分享前检查',
    });

    assert.equal(content.children[0].tag, 'h3');
    assert.equal(content.children[0].textContent, '日志');
    assert.equal(content.children[1].tag, 'p');
    assert.equal(content.children[2].tag, 'pre');
    assert.equal(content.children[2].textContent, hostile);
    assert.deepEqual(documentRef.created.map(element => element.tag), ['div', 'h3', 'p', 'pre']);
});

test('log viewer passes an HTMLElement and scrolling options to SillyTavern Popup', async () => {
    const documentRef = createFakeDocument();
    let received;
    class Popup {
        constructor(content, type, input, options) {
            received = { content, type, input, options };
        }
        async show() {
            return 1;
        }
    }

    const result = await showLogViewer('one\ntwo', {
        context: { Popup, POPUP_TYPE: { TEXT: 7 } },
        documentRef,
        title: 'Logs',
        closeText: 'Close',
    });
    assert.equal(result, 1);
    assert.equal(received.type, 7);
    assert.equal(received.content.children.at(-1).textContent, 'one\ntwo');
    assert.equal(received.options.large, true);
    assert.equal(received.options.allowVerticalScrolling, true);
    assert.equal(received.options.allowHorizontalScrolling, true);
});

test('log download uses a fixed safe name, text Blob, and always revokes its URL', () => {
    const documentRef = createFakeDocument();
    const blobs = [];
    class BlobImpl {
        constructor(parts, options) {
            blobs.push({ parts, options });
        }
    }
    const revoked = [];
    const urlApi = {
        createObjectURL: () => 'blob:safe',
        revokeObjectURL: value => revoked.push(value),
    };

    assert.equal(buildLogFilename(), 'st-vertex-paygo.log');
    assert.equal(downloadLogText('CLIENT 猫', { documentRef, BlobImpl, urlApi }), 'st-vertex-paygo.log');
    const link = documentRef.created.find(element => element.tag === 'a');
    assert.deepEqual(blobs, [{ parts: ['CLIENT 猫'], options: { type: 'text/plain;charset=utf-8' } }]);
    assert.equal(link.download, 'st-vertex-paygo.log');
    assert.equal(link.clicked, 1);
    assert.equal(link.removed, true);
    assert.deepEqual(revoked, ['blob:safe']);
});

test('log download cleans up when link creation or clicking fails', () => {
    const revokedAfterCreateFailure = [];
    const createFailureDocument = {
        body: createFakeElement('body'),
        createElement() {
            throw new Error('create failed');
        },
    };
    assert.throws(() => downloadLogText('log', {
        documentRef: createFailureDocument,
        BlobImpl: class {},
        urlApi: {
            createObjectURL: () => 'blob:create-failure',
            revokeObjectURL: value => revokedAfterCreateFailure.push(value),
        },
    }), /create failed/u);
    assert.deepEqual(revokedAfterCreateFailure, ['blob:create-failure']);

    const documentRef = createFakeDocument();
    documentRef.createElement = tag => {
        const element = createFakeElement(tag);
        element.click = () => { throw new Error('click failed'); };
        documentRef.created.push(element);
        return element;
    };
    const revokedAfterClickFailure = [];
    assert.throws(() => downloadLogText('log', {
        documentRef,
        BlobImpl: class {},
        urlApi: {
            createObjectURL: () => 'blob:click-failure',
            revokeObjectURL: value => revokedAfterClickFailure.push(value),
        },
    }), /click failed/u);
    assert.equal(documentRef.created[0].removed, true);
    assert.deepEqual(revokedAfterClickFailure, ['blob:click-failure']);
});
