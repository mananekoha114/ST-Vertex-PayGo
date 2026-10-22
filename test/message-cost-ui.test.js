/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageCostUi as createUi } from '../src/message-cost-ui.js';
import { readFile } from 'node:fs/promises';
import { createLocalizer } from '../src/i18n.js';

const catalogs = Object.fromEntries(await Promise.all(['en', 'zh-cn', 'zh-tw'].map(async language => [language,
    JSON.parse(await readFile(new URL(`../locales/${language}.json`, import.meta.url), 'utf8'))])));
const localize = createLocalizer((fallback, key) => catalogs['zh-cn'][key] ?? fallback);
// Keep existing layout regressions in Chinese while testing host selection below.
const createMessageCostUi = options => createUi({ localize, getPlacement: () => 'avatar', ...options });

function fakeDom({ avatarVisible = true } = {}) {
    const listeners = new Map();
    const windowListeners = new Map();
    const observers = [];
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
            this.dataset = {}; this.attributes = {}; this.style = {}; this.className = ''; this.textContent = '';
            this.offsetParent = {}; this.offsetHeight = 300;
        }
        append(...children) { for (const child of children) { child.remove(); this.children.push(child); child.parentElement = this; } }
        prepend(child) { child.remove(); this.children.unshift(child); child.parentElement = this; }
        insertBefore(child, before) { child.remove(); const index = this.children.indexOf(before); this.children.splice(index < 0 ? 0 : index, 0, child); child.parentElement = this; }
        replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
        remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
        setAttribute(name, value) { this.attributes[name] = String(value); }
        getAttribute(name) { return this.attributes[name] ?? null; }
        matches(selector) { return matches(this, selector); }
        contains(target) { return target === this || this.children.some(child => child.contains(target)); }
        focus() { this.focused = true; }
        getBoundingClientRect() { return { left: 780, top: 500, bottom: 520 }; }
        querySelector(selector) {
            const selectors = selector.split(',').map(value => value.trim());
            return walk(this).find(item => selectors.some(value => matches(item, value))) ?? null;
        }
        querySelectorAll(selector) { return walk(this).filter(item => matches(item, selector)); }
    }
    const matches = (element, selector) => {
        const match = /^\.([^[]+)(?:\[([^\]]+)\])?$/.exec(selector);
        return Boolean(match && element.className.split(/\s+/).includes(match[1])
            && (!match[2] || element.getAttribute(match[2]) !== null));
    };
    const walk = root => root.children.flatMap(child => [child, ...walk(child)]);
    const document = {
        body: new Element('body'), defaultView: {
            innerWidth: 1_000, innerHeight: 700,
            getComputedStyle: element => element.style,
            MutationObserver: class {
                constructor(callback) { this.callback = callback; observers.push(this); }
                observe(target, options) { this.target = target; this.options = options; }
                disconnect() { this.disconnected = true; }
            },
            addEventListener: (name, handler) => windowListeners.set(name, handler),
            removeEventListener: name => windowListeners.delete(name),
        },
        createElement: tag => new Element(tag),
        addEventListener: (name, handler) => listeners.set(name, handler),
        removeEventListener: name => listeners.delete(name),
        querySelectorAll(selector) { return walk(this.body).filter(element => matches(element, selector)); },
        getElementById(id) { return id === 'chat' ? this.body : null; },
    };
    const message = new Element('div'); message.className = 'mes'; message.setAttribute('mesid', '0');
    const avatar = new Element('div'); avatar.className = 'mesAvatarWrapper'; avatar.offsetParent = avatarVisible ? {} : null;
    const block = new Element('div'); block.className = 'mes_block';
    const header = new Element('div'); header.className = 'ch_name';
    const metadata = new Element('div'); metadata.className = 'metadata';
    const timestamp = new Element('small'); timestamp.className = 'timestamp'; metadata.append(timestamp); header.append(metadata);
    const text = new Element('div'); text.className = 'mes_text';
    const media = new Element('div'); media.className = 'mes_media_wrapper';
    const file = new Element('div'); file.className = 'mes_file_wrapper';
    block.append(header, text, media, file);
    message.append(avatar, block); document.body.append(message);
    return { document, listeners, windowListeners, observers, message, avatar, block, header, metadata, text, file,
        walk: () => [document.body, ...walk(document.body)] };
}

function allText(elements) { return elements.map(element => element.textContent).filter(Boolean); }
function find(elements, className) { return elements.find(element => element.className === className); }

function appendMessage(dom, id) {
    const message = dom.document.createElement('div');
    message.className = 'mes';
    message.setAttribute('mesid', String(id));
    const block = dom.document.createElement('div');
    block.className = 'mes_block';
    message.append(block);
    dom.document.body.append(message);
    return message;
}

test('long chats only read recent floor snapshots and do not rescan the DOM on refresh', () => {
    const dom = fakeDom();
    const chat = Array.from({ length: 10_000 }, (_, id) => ({ id }));
    for (let id = 1; id < chat.length; id++) appendMessage(dom, id);
    chat[9_999].is_user = true;
    chat[9_998].is_system = true;
    const read = [];
    let scans = 0;
    const query = dom.document.querySelectorAll;
    dom.document.querySelectorAll = function (selector) { scans++; return query.call(this, selector); };
    const ui = createUi({ documentRef: dom.document, getContext: () => ({ chat }),
        getMessageCost: message => { read.push(message.id); return snapshot; } });
    ui.render();
    assert.deepEqual(read, Array.from({ length: 18 }, (_, i) => 9_980 + i));
    assert.equal(dom.walk().filter(item => item.className === 'vertex-paygo-message-cost-trigger').length, 18);
    read.length = 0;
    ui.render(9_997);
    assert.deepEqual(read, [9_997]);
    ui.render(0);
    assert.deepEqual(read, [9_997]);
    assert.equal(scans, 1);
    ui.destroy();
});

test('moving and resizing the recent window removes old triggers and closes their details', async () => {
    const dom = fakeDom();
    const chat = [{ id: 0 }, { id: 1 }, { id: 2 }];
    appendMessage(dom, 1);
    appendMessage(dom, 2);
    let count = 3;
    const read = [];
    const ui = createUi({ documentRef: dom.document, getContext: () => ({ chat }), getRecentCount: () => count,
        getPlacement: () => 'footer', getMessageCost: message => { read.push(message.id); return snapshot; } });
    const ids = () => dom.walk().filter(item => item.className === 'vertex-paygo-message-cost-trigger')
        .map(button => button.dataset.messageId);
    ui.render();
    const first = dom.block.children.at(-1);
    first.onclick({ stopPropagation() {} });
    count = 2;
    read.length = 0;
    ui.render(2);
    assert.deepEqual(ids(), ['1', '2']);
    assert.deepEqual(read, [1, 2]);
    assert.equal(first.parentElement, null);
    assert.equal(find(dom.walk(), 'vertex-paygo-message-cost-card'), undefined);
    const next = appendMessage(dom, 3);
    chat.push({ id: 3 });
    dom.observers.find(observer => observer.options.attributeFilter?.includes('mesid'))
        .callback([{ type: 'childList', addedNodes: [next], removedNodes: [] }]);
    await Promise.resolve();
    assert.deepEqual(ids(), ['2', '3']);
    count = 4;
    ui.render();
    assert.deepEqual(ids(), ['0', '1', '2', '3']);
    chat.pop();
    next.remove();
    dom.observers.find(observer => observer.options.attributeFilter?.includes('mesid'))
        .callback([{ type: 'childList', addedNodes: [], removedNodes: [next] }]);
    await Promise.resolve();
    assert.deepEqual(ids(), ['0', '1', '2']);
    ui.destroy();
});

test('reindexes renumbered and wrapped remounted messages without reading older floors', async () => {
    const dom = fakeDom();
    const chat = Array.from({ length: 5 }, (_, id) => ({ id }));
    let reads = 0;
    const ui = createUi({ documentRef: dom.document, getContext: () => ({ chat }), getRecentCount: () => 1,
        getMessageCost: () => { reads++; return snapshot; } });
    ui.render();
    assert.equal(reads, 0);
    const observer = dom.observers.find(item => item.options.attributeFilter?.includes('mesid'));
    const wrapper = dom.document.createElement('div');
    const recent = appendMessage(dom, 4);
    wrapper.append(recent);
    dom.document.body.append(wrapper);
    observer.callback([{ type: 'childList', addedNodes: [wrapper], removedNodes: [] }]);
    await Promise.resolve();
    assert.equal(reads, 1);
    const button = recent.children[0].children[0];
    button.onclick({ stopPropagation() {} });
    recent.setAttribute('mesid', '1');
    observer.callback([{ type: 'attributes', target: recent }]);
    await Promise.resolve();
    assert.equal(reads, 2); // The click reads once; renumbering into old history does not.
    assert.equal(button.parentElement, null);
    assert.equal(find(dom.walk(), 'vertex-paygo-message-cost-card'), undefined);
    ui.destroy();
});

test('chat replacement clears detached triggers and hidden placement reads no snapshots', async () => {
    const dom = fakeDom();
    let chat = [{ id: 'old' }];
    let placement = 'footer';
    const read = [];
    const ui = createUi({ documentRef: dom.document, getContext: () => ({ chat }), getPlacement: () => placement,
        getMessageCost: message => { read.push(message.id); return snapshot; } });
    ui.render();
    const oldButton = dom.block.children.at(-1);
    oldButton.onclick({ stopPropagation() {} });
    dom.message.remove();
    chat = [{ id: 'new' }];
    const replacement = appendMessage(dom, 0);
    dom.observers.find(item => item.options.attributeFilter?.includes('mesid'))
        .callback([{ type: 'childList', addedNodes: [replacement], removedNodes: [dom.message] }]);
    await Promise.resolve();
    assert.equal(oldButton.parentElement, null);
    assert.equal(find(dom.walk(), 'vertex-paygo-message-cost-card'), undefined);
    assert.equal(read.at(-1), 'new');
    read.length = 0;
    placement = 'hidden';
    ui.render();
    assert.deepEqual(read, []);
    assert.equal(find(dom.walk(), 'vertex-paygo-message-cost-trigger'), undefined);
    ui.destroy();
});

test('rebuilding message contents closes details anchored to a removed trigger', () => {
    const dom = fakeDom();
    const ui = createUi({ documentRef: dom.document, getContext: () => ({ chat: [{}] }), getMessageCost: () => snapshot,
        getPlacement: () => 'footer' });
    ui.render();
    const oldButton = dom.block.children.at(-1);
    oldButton.onclick({ stopPropagation() {} });
    const block = dom.document.createElement('div');
    block.className = 'mes_block';
    dom.message.replaceChildren(block);
    ui.render(0);
    assert.equal(find(dom.walk(), 'vertex-paygo-message-cost-card'), undefined);
    assert.equal(oldButton.parentElement, null);
    const replacement = block.children[0];
    assert.notEqual(replacement, oldButton);
    replacement.onclick({ stopPropagation() {} });
    assert.ok(find(dom.walk(), 'vertex-paygo-message-cost-card'));
    ui.destroy();
});

test('late attributes on a detached root cannot replace a live message in the index', async () => {
    const dom = fakeDom();
    const ui = createUi({ documentRef: dom.document, getContext: () => ({ chat: [{}] }), getMessageCost: () => snapshot });
    ui.render();
    dom.message.remove();
    const replacement = appendMessage(dom, 0);
    dom.observers.find(item => item.options.attributeFilter?.includes('mesid')).callback([
        { type: 'childList', addedNodes: [], removedNodes: [dom.message] },
        { type: 'childList', addedNodes: [replacement], removedNodes: [] },
        { type: 'attributes', target: dom.message },
    ]);
    await Promise.resolve();
    assert.equal(replacement.children[0].children[0]?.className, 'vertex-paygo-message-cost-trigger');
    assert.equal(dom.block.children.some(child => child.className === 'vertex-paygo-message-cost-trigger'), false);
    ui.destroy();
});

test('message card shows weighted cache hit rate and unknown normalized cache separately from zero', () => {
    const dom = fakeDom();
    const current = structuredClone(snapshot);
    current.requests[0].record.usage.cachedContentTokenCount = 250;
    const ui = createMessageCostUi({ documentRef: dom.document, getContext: () => ({ chat: [{}] }),
        getMessageCost: () => current });
    ui.render();
    dom.avatar.children[0].onclick({ stopPropagation() {} });
    const metric = () => dom.walk().find(item => item.className === 'vertex-paygo-message-cost-metric'
        && item.children[0]?.textContent === localize('vertex_paygo.costs.cache_hit_rate'));
    assert.equal(metric().children[1].textContent, '25.0%');
    current.requests[0].record.usage.cachedContentTokenCount = 0;
    ui.render();
    assert.equal(metric().children[1].textContent, '0.0%');
    current.requests[0].record.usageAccuracy = 'tauri-normalized';
    delete current.requests[0].record.usage.cachedContentTokenCount;
    ui.render();
    assert.equal(metric().children[1].textContent, '—');
    ui.destroy();
});

test('message cards use the host locale, editable templates and English fallback', () => {
    for (const language of ['en', 'zh-cn', 'zh-tw']) {
        const dom = fakeDom();
        const dictionary = { ...catalogs[language] };
        const context = { chat: [{}], translate: (fallback, key) => dictionary[key] ?? fallback };
        const ui = createUi({ documentRef: dom.document, getContext: () => context, getMessageCost: () => snapshot, getPlacement: () => 'avatar' });
        ui.render();
        dom.avatar.children[0].onclick({ stopPropagation() {} });
        assert.ok(allText(dom.walk()).includes(dictionary['vertex_paygo.message_cost.title']));
        assert.equal(dom.document.body.children.at(-1).attributes['aria-label'], dictionary['vertex_paygo.message_cost.dialog_label']);
        assert.ok(allText(dom.walk()).includes(dictionary['vertex_paygo.message_cost.request_count'].replace('{count}', '1')));
        dictionary['vertex_paygo.message_cost.title'] = '<img src=x onerror=alert(1)> Custom title';
        dictionary['vertex_paygo.message_cost.trigger_label'] = '{cost} / custom label';
        dictionary['vertex_paygo.message_cost.dialog_label'] = 'Custom dialog';
        delete dictionary['vertex_paygo.message_cost.input'];
        ui.render();
        assert.ok(allText(dom.walk()).includes('<img src=x onerror=alert(1)> Custom title'));
        assert.ok(allText(dom.walk()).includes('Input'));
        assert.ok(dom.avatar.children[0].attributes['aria-label'].endsWith(' / custom label'));
        assert.equal(dom.document.body.children.at(-1).attributes['aria-label'], 'Custom dialog');
        assert.equal(dom.walk().some(element => element.tagName === 'IMG'), false);
        ui.destroy();
    }
});

const snapshot = {
    version: 1,
    requests: [{
        id: 'request-1',
        record: {
            id: 'request-1', source: 'vertexai', model: '<img src=x onerror=alert(1)>', tier: 'standard', status: 'complete',
            price: { input: 1, cachedInput: 0, output: 2 },
            usage: { promptTokenCount: 1_000, candidatesTokenCount: 500, thoughtsTokenCount: 100 },
        },
        timing: { stream: true, durationMs: 3_000, firstTokenMs: 1_000 },
    }],
};

test('remounts costs after native virtualization and ignores its own button mutations', async () => {
    const dom = fakeDom();
    const ui = createMessageCostUi({ documentRef: dom.document, getContext: () => ({ chat: [{}] }),
        getMessageCost: () => snapshot });
    ui.render();
    const observer = dom.observers.find(item => item.options.childList);
    const button = dom.avatar.children[0];
    button.onclick({ stopPropagation() {} });
    dom.message.remove();
    observer.callback([{ type: 'childList', addedNodes: [], removedNodes: [dom.message] }]);
    await Promise.resolve();
    assert.equal(find(dom.walk(), 'vertex-paygo-message-cost-card'), undefined);
    button.remove();
    dom.document.body.append(dom.message);
    observer.callback([{ type: 'childList', addedNodes: [dom.message], removedNodes: [] }]);
    await Promise.resolve();
    const replacement = dom.avatar.children[0];
    assert.equal(replacement.textContent, '≈ $0.00220');
    replacement.textContent = 'no rerender';
    observer.callback([{ type: 'childList', addedNodes: [replacement], removedNodes: [] }]);
    await Promise.resolve();
    assert.equal(replacement.textContent, 'no rerender');
    ui.destroy();
    assert.ok(dom.observers.every(item => item.disconnected));
});

test('native normalized details label partial costs and do not display unknown reasoning as zero', () => {
    const dom = fakeDom();
    const native = structuredClone(snapshot);
    native.requests[0].record.usageAccuracy = 'tauri-normalized';
    delete native.requests[0].record.usage.thoughtsTokenCount;
    const ui = createMessageCostUi({ documentRef: dom.document, getContext: () => ({ chat: [{}] }),
        getMessageCost: () => native });
    ui.render();
    const button = dom.avatar.children[0];
    assert.match(button.textContent, /^部分/);
    button.onclick({ stopPropagation() {} });
    const text = allText(dom.walk());
    assert.ok(text.includes('输出（已报告）'));
    assert.ok(text.includes(localize('vertex_paygo.message_cost.thinking_unreported')));
    assert.ok(text.some(value => value.includes('TauriTavern 非流式用量经过转换')));
    ui.destroy();
});

test('renders an accessible avatar trigger and a text-only details card that closes with Escape', () => {
    const dom = fakeDom();
    let opened;
    const ui = createMessageCostUi({
        documentRef: dom.document,
        getContext: () => ({ chat: [{ messageId: 7 }] }),
        getMessageCost: () => snapshot,
        getPrices: () => ({}),
        onOpen: summary => { opened = summary; },
    });
    ui.render();
    const button = dom.avatar.children[0];
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.type, 'button');
    assert.equal(button.textContent, '≈ $0.00220');
    assert.equal(button.attributes['aria-haspopup'], 'dialog');
    button.onclick({ stopPropagation() {} });
    assert.equal(opened.amount, .0022);
    const card = dom.document.body.children.at(-1);
    assert.equal(card.attributes.role, 'dialog');
    assert.ok(allText(dom.walk()).some(value => value.includes('<img src=x onerror=alert(1)>')));
    assert.equal(dom.walk().some(element => element.tagName === 'IMG'), false);
    assert.equal(card.style.left, '472px');
    assert.equal(find(dom.walk(), 'vertex-paygo-message-cost-close').tagName, 'BUTTON');
    dom.listeners.get('keydown')({ key: 'Escape' });
    assert.equal(card.parentElement, null);
    assert.equal(button.attributes['aria-expanded'], 'false');
    assert.equal(button.focused, true);
    ui.destroy();
    assert.equal(dom.avatar.children.length, 0);
    assert.equal(dom.listeners.size, 0);
});

test('refreshes an open card in place and preserves its expanded state', () => {
    const dom = fakeDom();
    let current = snapshot;
    const ui = createMessageCostUi({
        documentRef: dom.document,
        getContext: () => ({ chat: [{}] }),
        getMessageCost: () => current,
    });
    ui.render();
    const button = dom.avatar.children[0];
    button.onclick({ stopPropagation() {} });
    const card = dom.document.body.children.at(-1);
    current = { version: 1, requests: [{
        id: 'request-1', status: 'unavailable',
        record: { ...snapshot.requests[0].record, status: 'pending', usage: null },
        timing: { durationMs: 1_200, stream: false },
    }] };
    ui.render(0);
    assert.equal(dom.document.body.children.at(-1), card);
    assert.equal(button.attributes['aria-expanded'], 'true');
    assert.ok(allText(dom.walk()).some(value => value.includes(localize('vertex_paygo.message_cost.reason.unavailable'))));
    ui.destroy();
});

test('moves an existing trigger as document mode changes and repositions on resize and scroll', () => {
    const dom = fakeDom();
    const ui = createMessageCostUi({
        documentRef: dom.document,
        getContext: () => ({ chat: [{}] }),
        getMessageCost: () => snapshot,
    });
    ui.render();
    const button = dom.avatar.children[0];
    dom.avatar.offsetParent = null;
    ui.render();
    assert.equal(dom.block.children.at(-1), button);
    dom.avatar.offsetParent = {};
    ui.render();
    assert.equal(dom.avatar.children[0], button);
    button.onclick({ stopPropagation() {} });
    const card = dom.document.body.children.at(-1);
    dom.document.defaultView.innerWidth = 600;
    dom.windowListeners.get('resize')();
    assert.equal(card.style.width, '520px');
    dom.document.defaultView.innerWidth = 400;
    dom.windowListeners.get('scroll')();
    assert.equal(card.style.width, '384px');
    ui.destroy();
    assert.equal(dom.windowListeners.size, 0);
});

test('uses the body fallback when the avatar rail is hidden and closes on outside pointer input', () => {
    const dom = fakeDom({ avatarVisible: false });
    const ui = createMessageCostUi({
        documentRef: dom.document,
        getContext: () => ({ chat: [{ messageId: 7 }] }),
        getMessageCost: () => snapshot,
    });
    ui.render(0);
    const button = dom.block.children.at(-1);
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(dom.message.children[1].className, 'mes_block');
    button.onclick({ stopPropagation() {} });
    const card = dom.document.body.children.at(-1);
    dom.listeners.get('pointerdown')({ target: dom.message });
    assert.equal(card.parentElement, null);
    ui.destroy();
});

test('removes a stale trigger when a message snapshot disappears', () => {
    const dom = fakeDom();
    let current = snapshot;
    const ui = createMessageCostUi({
        documentRef: dom.document,
        getContext: () => ({ chat: [{ messageId: 7 }] }),
        getMessageCost: () => current,
    });
    ui.render();
    assert.equal(dom.avatar.children.length, 1);
    current = null;
    ui.render(0);
    assert.equal(dom.avatar.children.length, 0);
    ui.destroy();
});

test('defaults below the avatar as in releases before 0.5.0', () => {
    const dom = fakeDom();
    const ui = createUi({ documentRef: dom.document, getContext: () => ({ chat: [{}] }), getMessageCost: () => snapshot });
    ui.render();
    assert.equal(dom.avatar.children[0].dataset.placement, 'avatar');
    assert.equal(dom.block.children.some(item => item.className === 'vertex-paygo-message-cost-trigger'), false);
    ui.destroy();
});

test('the footer follows attachments and survives replacement of message text', () => {
    const dom = fakeDom();
    const ui = createUi({ documentRef: dom.document, getContext: () => ({ chat: [{}] }), getMessageCost: () => snapshot,
        getPlacement: () => 'footer' });
    ui.render();
    const button = dom.block.children.at(-1);
    assert.equal(button.dataset.placement, 'footer');
    assert.equal(dom.block.children.at(-2), dom.file);
    assert.equal(dom.avatar.children.length, 0);
    dom.text.replaceChildren(dom.document.createElement('p'));
    assert.equal(button.parentElement, dom.block);
    ui.render();
    assert.equal(dom.walk().filter(item => item.className === 'vertex-paygo-message-cost-trigger').length, 1);
    ui.destroy();
});

test('switches all placements immediately, preserves open details, and hides without changing snapshots', () => {
    const dom = fakeDom();
    let placement = 'footer';
    const data = structuredClone(snapshot);
    const ui = createMessageCostUi({ documentRef: dom.document, getContext: () => ({ chat: [{}] }),
        getMessageCost: () => data, getPlacement: () => placement });
    ui.render();
    const button = dom.block.children.at(-1);
    button.onclick({ stopPropagation() {} });
    const card = find(dom.walk(), 'vertex-paygo-message-cost-card');
    for (const [value, parent] of [['header', dom.metadata], ['avatar', dom.avatar], ['footer', dom.block]]) {
        placement = value;
        ui.render();
        assert.equal(button.parentElement, parent);
        assert.equal(button.dataset.placement, value);
        assert.equal(find(dom.walk(), 'vertex-paygo-message-cost-card'), card);
        assert.equal(button.attributes['aria-expanded'], 'true');
    }
    placement = 'hidden';
    ui.render();
    assert.equal(button.parentElement, null);
    assert.equal(card.parentElement, null);
    assert.deepEqual(data, snapshot);
    placement = 'invalid';
    ui.render();
    assert.equal(dom.avatar.children.at(-1).dataset.placement, 'avatar');
    ui.destroy();
});

test('hidden headers and avatars fall back inside the content block and recover on theme/resize changes', () => {
    for (const placement of ['avatar', 'header']) {
        const dom = fakeDom();
        dom.document.head = dom.document.createElement('head');
        const target = placement === 'avatar' ? dom.avatar : dom.header;
        target.style.visibility = 'hidden';
        const ui = createMessageCostUi({ documentRef: dom.document, getContext: () => ({ chat: [{}] }),
            getMessageCost: () => snapshot, getPlacement: () => placement });
        ui.render();
        const button = dom.block.children.at(-1);
        assert.equal(button.dataset.placement, 'footer');
        assert.deepEqual(dom.message.children, [dom.avatar, dom.block]);
        target.style.visibility = 'visible';
        dom.observers.find(observer => observer.target === dom.document.head).callback([]);
        assert.equal(button.dataset.placement, placement);
        target.offsetParent = null;
        dom.windowListeners.get('resize')();
        assert.equal(button.parentElement, dom.block);
        target.offsetParent = {};
        dom.observers.find(observer => observer.options.attributeFilter?.includes('class')).callback([]);
        assert.equal(button.dataset.placement, placement);
        ui.destroy();
        assert.ok(dom.observers.every(observer => observer.disconnected));
    }
});
