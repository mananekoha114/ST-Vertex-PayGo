/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isTauriTavern, showTauriTavernNotice } from '../src/tauritavern.js';

function createDocument() {
    const created = [];
    const createElement = tag => {
        const listeners = {};
        const element = {
            tag, children: [], textContent: '',
            append(...children) { this.children.push(...children); },
            addEventListener(name, handler) { listeners[name] = handler; },
            setAttribute(name, value) { this[name] = value; },
            showModal() { this.open = true; },
            close() { this.open = false; listeners.close?.(); },
            click() { listeners.click?.(); },
            remove() { this.removed = true; },
        };
        created.push(element);
        return element;
    };
    return { created, createElement, body: createElement('body') };
}

test('detects TauriTavern without treating other Tauri apps or browser hosts as TauriTavern', () => {
    assert.equal(isTauriTavern({ __TAURITAVERN__: { api: {} } }), true);
    for (const host of [
        {}, { SillyTavern: {} }, { __TAURI__: {}, __TAURI_INTERNALS__: {} },
        { __TAURITAVERN__: null }, { __TAURITAVERN__: false },
        { navigator: { userAgent: 'TauriTavern' } },
    ]) {
        assert.equal(isTauriTavern(host), false);
    }
});

test('uses the host popup and renders translations as text, with scrollable guidance', async () => {
    const documentRef = createDocument();
    let received;
    const hostileTranslation = '<img src=x onerror=alert(1)>中文';
    class Popup {
        constructor(content, type, input, options) { received = { content, type, options }; }
        async show() {}
    }
    await showTauriTavernNotice({
        context: { Popup, POPUP_TYPE: { TEXT: 7 } }, documentRef,
        localize: () => hostileTranslation,
    });
    assert.equal(received.type, 7);
    assert.equal(received.options.allowVerticalScrolling, true);
    assert.equal(received.options.okButton, hostileTranslation);
    assert.ok(received.content.children.every(child => child.textContent === hostileTranslation));
    assert.equal(documentRef.body.children.length, 0);
});

test('shows a dismissible native dialog when the host context is unavailable', async () => {
    const documentRef = createDocument();
    await showTauriTavernNotice({ documentRef });
    const dialog = documentRef.body.children[0];
    assert.equal(dialog.tag, 'dialog');
    assert.equal(dialog.open, true);
    dialog.children.at(-1).click();
    assert.equal(dialog.open, false);
    assert.equal(dialog.removed, true);
});

test('falls back to a native dialog if the host popup fails', async t => {
    t.mock.method(console, 'warn', () => {});
    const documentRef = createDocument();
    class Popup { async show() { throw new Error('host not ready'); } }
    await showTauriTavernNotice({ context: { Popup, POPUP_TYPE: { TEXT: 1 } }, documentRef });
    assert.equal(documentRef.body.children[0].open, true);
});

test('waits for the document body before showing an early startup notice', async () => {
    const documentRef = createDocument();
    const body = documentRef.body;
    let ready;
    documentRef.body = null;
    documentRef.readyState = 'loading';
    documentRef.addEventListener = (name, handler, options) => {
        assert.equal(name, 'DOMContentLoaded');
        assert.equal(options.once, true);
        ready = handler;
    };
    const notice = showTauriTavernNotice({ documentRef });
    assert.equal(body.children.length, 0);
    documentRef.body = body;
    ready();
    await notice;
    assert.equal(body.children[0].open, true);
});

test('still shows guidance when the TauriTavern context shim throws', async t => {
    const { init } = await import('../index.js?context-not-ready');
    t.mock.method(console, 'warn', () => {});
    const keys = ['document', '__TAURITAVERN__', 'SillyTavern'];
    const previous = Object.getOwnPropertyDescriptors(globalThis);
    t.after(() => {
        for (const key of keys) {
            if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
            else delete globalThis[key];
        }
    });
    globalThis.document = createDocument();
    globalThis.__TAURITAVERN__ = {};
    globalThis.SillyTavern = { getContext: () => { throw new Error('not ready'); } };
    await init();
    assert.equal(document.body.children[0].open, true);
    await init();
    assert.equal(document.body.children.length, 1);
});

test('TauriTavern activation shows only once and leaves network, controls and request hooks untouched', async t => {
    // Import with no document so the legacy activation fallback does not auto-run.
    const { init, getControllerForDebug } = await import('../index.js');
    const documentRef = createDocument();
    let shown = 0;
    let dismiss;
    class Popup {
        show() {
            shown += 1;
            return new Promise(resolve => { dismiss = resolve; });
        }
    }
    const fail = () => assert.fail('Unsupported host must not initialize plugin services');
    const previous = Object.getOwnPropertyDescriptors(globalThis);
    t.after(() => {
        for (const key of ['document', '__TAURITAVERN__', 'SillyTavern', 'fetch', 'setInterval']) {
            if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
            else delete globalThis[key];
        }
    });
    globalThis.document = { ...documentRef, getElementById: fail };
    globalThis.__TAURITAVERN__ = { api: {} };
    globalThis.SillyTavern = { getContext: () => ({
        Popup, POPUP_TYPE: { TEXT: 1 }, eventSource: { on: fail, makeLast: fail },
        getRequestHeaders: fail,
    }) };
    globalThis.fetch = fail;
    globalThis.setInterval = fail;
    await init();
    await init();
    assert.equal(shown, 1);
    assert.equal(getControllerForDebug(), null);
    dismiss();
    await Promise.resolve();
    await init();
    assert.equal(shown, 1);
});
