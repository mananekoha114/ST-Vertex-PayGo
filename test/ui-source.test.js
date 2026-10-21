/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayGoUi } from '../src/ui.js';
import { EXTENSION_ID, UPDATE_POLL_INTERVAL_MS } from '../src/constants.js';

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
        removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(handler => handler !== callback)); }
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
    let placement = 'avatar';
    let recentCount = 20; const recentCalls = [];
    const placementCalls = [];
    const ui = createPayGoUi({ context, getMessageCostPlacement: () => placement,
        getMessageCostRecentCount: () => recentCount,
        setMessageCostRecentCount: value => { recentCount = value; recentCalls.push(value); },
        setMessageCostPlacement: value => { placement = value; placementCalls.push(value); }, serverClient: { checkHealth: async () => ({ capabilities: {} }) } });
    await Promise.resolve();
    const placementSelect = dom.document.getElementById('vertex-paygo-message-cost-placement');
    assert.equal(placementSelect.value, 'avatar');
    const recentInput = dom.document.getElementById('vertex-paygo-message-cost-recent-count');
    assert.equal(recentInput.value, '20');
    recentInput.value = '7'; await recentInput.fire('change');
    assert.deepEqual(recentCalls, [7]);
    assert.equal(placementSelect.disabled, undefined);
    placementSelect.value = 'hidden';
    await placementSelect.fire('change');
    assert.deepEqual(placementCalls, ['hidden']);
    assert.equal(ui.getState().tier, 'standard');
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
    assert.equal(placementSelect.value, 'hidden');
    ui.destroy();
    placementSelect.value = 'footer';
    await placementSelect.fire('change');
    assert.deepEqual(placementCalls, ['hidden']);
});

function createUpdaterContext() {
    const profile = { id: 'vertex', api: 'vertexai', mode: 'cc', [EXTENSION_ID]: { tier: 'standard', paygoOnly: false } };
    return {
        chatCompletionSettings: { chat_completion_source: 'vertexai', vertexai_model: 'gemini-3.8-flash', vertexai_region: 'us-central1' },
        extensionSettings: { connectionManager: { selectedProfile: 'vertex', profiles: [profile] } },
        eventTypes: new Proxy({}, { get: (_target, key) => key }),
        eventSource: { on() {}, once() {} },
        Popup: { show: { confirm: async () => 1 } },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
        saveSettingsDebounced() {},
    };
}

// The controller reads a few host globals; the same adapter as above keeps this
// regression dependency-free.
function installHostDom(t, dom) {
    for (const [key, value] of Object.entries({ document: dom.document, Element: dom.Element, HTMLInputElement: dom.Input, HTMLSelectElement: dom.Select })) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { value, configurable: true });
        t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
    }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function controlUpdatePoll(t) {
    const timers = new Map();
    const originalSet = globalThis.setTimeout;
    const originalClear = globalThis.clearTimeout;
    let nextId = -1;
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
        if (delay !== UPDATE_POLL_INTERVAL_MS) return originalSet(callback, delay, ...args);
        const id = nextId--;
        timers.set(id, () => callback(...args));
        return id;
    });
    t.mock.method(globalThis, 'clearTimeout', id => {
        if (!timers.delete(id)) originalClear(id);
    });
    return {
        get pending() { return timers.size; },
        async tick() {
            const callbacks = [...timers.values()];
            timers.clear();
            assert.ok(callbacks.length > 0, 'an update poll is scheduled');
            for (const callback of callbacks) callback();
            await settle();
        },
    };
}

function makeUpdaterUi(t, client = {}, context = createUpdaterContext()) {
    const dom = createHostDom();
    installHostDom(t, dom);
    const clock = controlUpdatePoll(t);
    const ui = createPayGoUi({ context, serverClient: {
        checkHealth: async () => ({ capabilities: { updater: true } }),
        checkUpdate: async () => ({ ok: true, status: 'update-available', components: [
            { name: 'frontend', status: 'update', target: { tag: 'v0.5.1', commit: 'a'.repeat(40) } },
            { name: 'server', status: 'update', target: { tag: 'v0.5.1', commit: 'b'.repeat(40) } },
        ] }),
        startUpdate: async () => ({ ok: true, started: true }),
        readUpdateStatus: async () => ({ ok: true, running: false, lastResult: { status: 'updated' } }),
        ...client,
    } });
    t.after(() => ui.destroy());
    return { dom, ui, clock, get: id => dom.document.getElementById(`vertex-paygo-${id}`) };
}

test('the update row stays hidden while the backend does not advertise it', async t => {
    const dom = createHostDom();
    installHostDom(t, dom);
    const ui = createPayGoUi({
        context: createUpdaterContext(),
        serverClient: { checkHealth: async () => ({ capabilities: {} }) },
    });
    await settle();
    assert.equal(dom.document.getElementById('vertex-paygo-update-row').hidden, true);
    ui.destroy();
});

test('an available update is confirmed before anything is replaced', async t => {
    const dom = createHostDom();
    installHostDom(t, dom);
    const confirmations = [];
    let starts = 0;
    const context = createUpdaterContext();
    context.Popup = {
        show: {
            confirm: async (title, body, options) => {
                confirmations.push({ title, body, options });
                return context.POPUP_RESULT.NEGATIVE;
            },
        },
    };
    const ui = createPayGoUi({
        context,
        serverClient: {
            checkHealth: async () => ({ capabilities: { updater: true } }),
            checkUpdate: async () => ({
                ok: true,
                status: 'update-available',
                components: [
                    { name: 'frontend', status: 'update', target: { tag: 'v0.5.1', commit: 'a'.repeat(40) }, channel: { branch: 'main', mode: 'tag' } },
                    { name: 'server', status: 'update', target: { tag: 'v0.5.1', commit: 'b'.repeat(40) }, channel: { branch: 'main', mode: 'tag' } },
                ],
            }),
            startUpdate: async () => { starts += 1; return { ok: true, started: true }; },
            readUpdateStatus: async () => ({ ok: true, running: false, lastResult: { status: 'updated' } }),
        },
    });
    await settle();

    const row = dom.document.getElementById('vertex-paygo-update-row');
    const check = dom.document.getElementById('vertex-paygo-update-check');
    const apply = dom.document.getElementById('vertex-paygo-update-apply');
    const status = dom.document.getElementById('vertex-paygo-update-status');
    assert.equal(row.hidden, false, 'the row is offered when the backend advertises the capability');
    assert.equal(check.disabled, false);
    assert.equal(apply.hidden, true, 'nothing to apply before a check');

    await check.fire('click');
    await settle();
    await settle();
    assert.equal(apply.hidden, false, 'a paired update becomes actionable');
    assert.match(status.textContent, /v0\.5\.1/u);

    await apply.fire('click');
    await settle();
    await settle();
    assert.equal(confirmations.length, 1, 'replacing both components is confirmed first');
    assert.match(confirmations[0].body, /v0\.5\.1/u);
    assert.equal(confirmations[0].options.defaultResult, context.POPUP_RESULT.NEGATIVE);
    assert.equal(starts, 0, 'declining the confirmation starts nothing');
    assert.equal(apply.hidden, false, 'the offer survives a declined confirmation');
    ui.destroy();
});

test('an accepted update polls progress and ends with a restart notice', async t => {
    const calls = [];
    const statuses = [
        { ok: true, running: true, job: { phase: 'preparing' } },
        { ok: true, running: false, lastResult: { status: 'updated', restartRequired: true } },
    ];
    const f = makeUpdaterUi(t, {
        startUpdate: async () => { calls.push('start'); return { ok: true, started: true }; },
        readUpdateStatus: async () => { calls.push('status'); return statuses.shift(); },
    });
    await f.ui.checkForUpdates();
    const work = f.ui.applyUpdate();
    await settle();
    assert.equal(f.get('update-check').disabled, true);
    await f.clock.tick();
    assert.match(f.get('update-status').textContent, /downloading and verifying/u);
    await f.clock.tick();
    await work;
    assert.deepEqual(calls, ['start', 'status', 'status']);
    assert.match(f.get('update-status').textContent, /Restart the host/u);
    assert.equal(f.get('update-check').disabled, false);
    assert.equal(f.clock.pending, 0);
});

test('an update that became current during confirmation reports no replacement', async t => {
    const f = makeUpdaterUi(t, {
        readUpdateStatus: async () => ({ ok: true, running: false, lastResult: { status: 'no-change' } }),
    });
    await f.ui.checkForUpdates();
    const work = f.ui.applyUpdate();
    await settle();
    await f.clock.tick();
    await work;
    assert.match(f.get('update-status').textContent, /Both components are current/u);
    assert.equal(f.get('update-apply').hidden, true);
});

test('a failed update displays its cause and allows a fresh check and retry', async t => {
    let starts = 0;
    const f = makeUpdaterUi(t, {
        startUpdate: async () => { starts++; return { ok: true, started: true }; },
        readUpdateStatus: async () => ({ ok: true, running: false, lastResult: starts === 1
            ? { status: 'failed', code: 'UPDATER_GIT_FAILED', message: 'fixture download failed' }
            : { status: 'updated' } }),
    });
    await f.ui.checkForUpdates();
    const first = f.ui.applyUpdate();
    await settle();
    await f.clock.tick();
    await first;
    assert.match(f.get('update-status').textContent, /fixture download failed/u);
    assert.equal(f.get('update-check').disabled, false);
    await f.ui.checkForUpdates();
    const retry = f.ui.applyUpdate();
    await settle();
    await f.clock.tick();
    await retry;
    assert.equal(starts, 2);
    assert.match(f.get('update-status').textContent, /Restart the host/u);
});

test('an open confirmation prevents a second confirmation or start', async t => {
    const resolvers = [];
    const context = createUpdaterContext();
    context.Popup.show.confirm = () => new Promise(resolve => resolvers.push(resolve));
    t.after(() => { for (const resolve of resolvers) resolve(context.POPUP_RESULT.NEGATIVE); });
    let starts = 0;
    const f = makeUpdaterUi(t, { startUpdate: async () => { starts++; } }, context);
    await f.ui.checkForUpdates();
    const first = f.ui.applyUpdate();
    const second = f.ui.applyUpdate();
    assert.equal(resolvers.length, 1);
    assert.equal(f.get('update-apply').disabled, true);
    resolvers[0](context.POPUP_RESULT.NEGATIVE);
    await Promise.all([first, second]);
    assert.equal(starts, 0);
    assert.equal(f.get('update-apply').disabled, false);
});

test('destroying the panel releases its scheduled update poll', async t => {
    const f = makeUpdaterUi(t);
    await f.ui.checkForUpdates();
    const work = f.ui.applyUpdate();
    await settle();
    assert.equal(f.clock.pending, 1);
    f.ui.destroy();
    assert.equal(f.clock.pending, 0);
    await work;
});

test('a late status response cannot reattach a destroyed panel', async t => {
    let finishStatus;
    const f = makeUpdaterUi(t, { readUpdateStatus: () => new Promise(resolve => { finishStatus = resolve; }) });
    await f.ui.checkForUpdates();
    const work = f.ui.applyUpdate();
    await settle();
    await f.clock.tick();
    f.ui.destroy();
    finishStatus({ ok: true, running: false, lastResult: { status: 'updated' } });
    await work;
    assert.equal(f.get('settings').parentElement === null, true, 'the destroyed panel stays detached');
    assert.equal(f.clock.pending, 0);
});

test('a confirmation resolved after destruction cannot start an update', async t => {
    let confirm;
    let starts = 0;
    const context = createUpdaterContext();
    context.Popup.show.confirm = () => new Promise(resolve => { confirm = resolve; });
    const f = makeUpdaterUi(t, { startUpdate: async () => { starts++; } }, context);
    await f.ui.checkForUpdates();
    const work = f.ui.applyUpdate();
    f.ui.destroy();
    confirm(context.POPUP_RESULT.AFFIRMATIVE);
    await work;
    assert.equal(starts, 0);
    assert.equal(f.clock.pending, 0);
});

for (const failure of ['start', 'status']) {
    test(`an update ${failure} request failure releases the controls`, async t => {
        const fail = async () => { throw new Error('fixture request failed'); };
        const f = makeUpdaterUi(t, failure === 'start' ? { startUpdate: fail } : { readUpdateStatus: fail });
        await f.ui.checkForUpdates();
        const work = f.ui.applyUpdate();
        await settle();
        if (failure === 'status') await f.clock.tick();
        await work;
        assert.match(f.get('update-status').textContent, /fixture request failed/u);
        assert.equal(f.get('update-check').disabled, false);
        assert.equal(f.clock.pending, 0);
    });
}
