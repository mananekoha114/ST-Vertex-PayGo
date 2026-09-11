/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayGoUi } from '../src/ui.js';
import { EXTENSION_ID } from '../src/constants.js';

// Minimal host DOM adapter keeps this controller regression dependency-free.
function createHostDom() {
    const elements = [];
    class Element {
        constructor(tag) {
            this.tag = tag;
            this.children = [];
            this.dataset = {};
            this.listeners = new Map();
            this.classList = { add() {}, remove() {} };
            this.value = '';
            elements.push(this);
        }
        setAttribute(name, value) { this[name] = value; }
        remove() {
            if (this.parentElement) {
                const children = this.parentElement.children;
                children.splice(children.indexOf(this), 1);
                this.parentElement = null;
            }
        }
        append(...children) {
            for (const child of children) {
                child.remove();
                child.parentElement = this;
                this.children.push(child);
            }
        }
        after(child) {
            child.remove();
            const siblings = this.parentElement.children;
            siblings.splice(siblings.indexOf(this) + 1, 0, child);
            child.parentElement = this.parentElement;
        }
        get previousElementSibling() {
            const siblings = this.parentElement?.children ?? [];
            return siblings[siblings.indexOf(this) - 1] ?? null;
        }
        closest() { return this.parentElement; }
        querySelector(selector) {
            const value = /value="([^"]+)"/u.exec(selector)?.[1];
            return this.children.find(child => child.value === value) ?? null;
        }
        addEventListener(name, callback) {
            const handlers = this.listeners.get(name) ?? [];
            this.listeners.set(name, [...handlers, callback]);
        }
        async fire(name) {
            for (const handler of this.listeners.get(name) ?? []) await handler({ target: this });
        }
    }
    class Input extends Element {}
    class Select extends Element {}
    const document = {
        activeElement: null,
        createElement(tag) { return new (tag === 'input' ? Input : tag === 'select' ? Select : Element)(tag); },
        getElementById(id) { return elements.find(element => element.id === id) ?? null; },
        addEventListener() {},
    };
    function add(tag, id, parent) {
        const element = document.createElement(tag);
        element.id = id;
        parent?.append(element);
        return element;
    }
    const vertex = add('form', 'vertexai_form');
    const regionContainer = add('div', 'region_container', vertex);
    const region = add('input', 'vertexai_region', regionContainer);
    region.value = 'us-central1';
    add('select', 'model_vertexai_select', vertex).value = 'gemini-3.8-flash';
    const studio = add('form', 'makersuite_form');
    add('select', 'model_google_select', studio).value = 'gemini-2.5-pro';
    return { document, Element, Input, Select, elements, vertex, studio, region };
}

test('one settings controller moves between sources, preserves profiles, and applies AI Studio Flex without a region dialog', async t => {
    const dom = createHostDom();
    for (const [key, value] of Object.entries({ document: dom.document, Element: dom.Element, HTMLInputElement: dom.Input, HTMLSelectElement: dom.Select })) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { value, configurable: true });
        t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
    }
    const handlers = new Map();
    const studio = { id: 'studio', api: 'makersuite', mode: 'cc', [EXTENSION_ID]: { tier: 'standard', paygoOnly: true } };
    const vertex = { id: 'vertex', api: 'vertexai', mode: 'cc', [EXTENSION_ID]: { tier: 'standard', paygoOnly: true } };
    const context = {
        chatCompletionSettings: { chat_completion_source: 'makersuite', google_model: 'gemini-2.5-pro', vertexai_model: 'gemini-3.8-flash', vertexai_region: 'us-central1' },
        extensionSettings: { connectionManager: { selectedProfile: 'studio', profiles: [studio, vertex] } },
        eventTypes: new Proxy({}, { get: (_target, key) => key }),
        eventSource: { on: (name, callback) => handlers.set(name, callback), once() {} },
        Popup: { show: { confirm: () => assert.fail('AI Studio must not ask for a Vertex region') } },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
        saveSettingsDebounced() {},
    };
    const ui = createPayGoUi({ context, serverClient: { checkHealth: async () => ({ capabilities: {} }) } });
    await Promise.resolve();
    const root = dom.document.getElementById('vertex-paygo-settings');
    const select = dom.document.getElementById('vertex-paygo-tier');
    const paygo = dom.document.getElementById('vertex-paygo-only');
    assert.equal(root.parentElement, dom.studio);
    assert.equal(paygo.parentElement.hidden, true);
    assert.equal(select.querySelector('option[value="priority"]').hidden, true);
    assert.equal(select.querySelector('option[value="flex"]').disabled, false);
    select.value = 'flex';
    await select.fire('change');
    assert.equal(ui.getState().tier, 'flex');
    assert.equal(studio[EXTENSION_ID].tier, 'flex');
    assert.equal(dom.region.value, 'us-central1');
    assert.match(root.children[0].textContent, /Google AI Studio/u);

    context.chatCompletionSettings.chat_completion_source = 'vertexai';
    context.extensionSettings.connectionManager.selectedProfile = 'vertex';
    handlers.get('CHATCOMPLETION_SOURCE_CHANGED')();
    assert.equal(root.parentElement, dom.vertex);
    assert.equal(ui.getState().tier, 'standard');
    assert.equal(paygo.parentElement.hidden, false);
    assert.equal(select.querySelector('option[value="priority"]').hidden, false);

    context.chatCompletionSettings.chat_completion_source = 'makersuite';
    context.extensionSettings.connectionManager.selectedProfile = 'studio';
    handlers.get('CHATCOMPLETION_SOURCE_CHANGED')();
    assert.equal(root.parentElement, dom.studio);
    assert.equal(ui.getState().tier, 'flex');
    assert.equal(dom.elements.filter(element => element.id === root.id).length, 1);
    assert.equal(select.listeners.get('change').length, 1);
    assert.equal(vertex[EXTENSION_ID].tier, 'standard');
});
