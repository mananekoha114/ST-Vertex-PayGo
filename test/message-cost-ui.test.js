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
const createMessageCostUi = options => createUi({ localize, ...options });

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
    const text = new Element('div'); text.className = 'mes_text'; block.append(text);
    message.append(avatar, block); document.body.append(message);
    return { document, listeners, windowListeners, observers, message, avatar, block, walk: () => [document.body, ...walk(document.body)] };
}

function allText(elements) { return elements.map(element => element.textContent).filter(Boolean); }
function find(elements, className) { return elements.find(element => element.className === className); }

test('message cards use the host locale, editable templates and English fallback', () => {
    for (const language of ['en', 'zh-cn', 'zh-tw']) {
        const dom = fakeDom();
        const dictionary = { ...catalogs[language] };
        const context = { chat: [{}], translate: (fallback, key) => dictionary[key] ?? fallback };
        const ui = createUi({ documentRef: dom.document, getContext: () => context, getMessageCost: () => snapshot });
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
    assert.ok(text.includes('推理用量未报告'));
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
    assert.ok(allText(dom.walk()).some(value => value.includes('用量轮询已结束，结果不可用')));
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
    assert.equal(dom.message.children[1], button);
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
    const button = dom.message.children[1];
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(dom.message.children[2].className, 'mes_block');
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
