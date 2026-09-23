/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCostUi } from '../src/cost-ui.js';

function fakeDocument() {
    const ids = new Map();
    class Node {
        constructor(tag) { this.tag = tag; this.children = []; this.listeners = new Map(); this.dataset = {}; this.value = ''; }
        setAttribute(name, value) { this[name] = value; }
        append(...children) { this.children.push(...children); for (const child of children) child.parentElement = this; }
        replaceChildren(...children) { this.children = []; this.append(...children); }
        addEventListener(name, handler) { this.listeners.set(name, handler); }
        remove() { this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1); }
        async fire(name, extra = {}) { return await this.listeners.get(name)?.({ type: name, preventDefault() {}, ...extra }); }
    }
    const document = { createElement: tag => new Node(tag), getElementById: id => ids.get(id) ?? null };
    const menu = new Node('div'); ids.set('extensionsMenu', menu);
    return { document, menu };
}

function text(node) {
    return [node.textContent, ...node.children.flatMap(child => text(child))].filter(Boolean);
}

function find(node, predicate) {
    if (predicate(node)) return node;
    for (const child of node.children) {
        const match = find(child, predicate);
        if (match) return match;
    }
    return null;
}

test('wand statistics show weighted and per-request cache rates using host translations', async () => {
    for (const missingCache of [false, true]) {
        const { document } = fakeDocument();
        let shown;
        class Popup { constructor(content) { shown = content; } async show() { return 0; } }
        const records = [
            { id: 'a', chatId: 'chat', status: 'complete', usage: { promptTokenCount: 100, cachedContentTokenCount: 20 } },
            { id: 'b', chatId: 'chat', status: 'complete', usage: { promptTokenCount: 1000, cachedContentTokenCount: 800 } },
        ];
        if (missingCache) {
            records[1].usageAccuracy = 'tauri-normalized';
            delete records[1].usage.cachedContentTokenCount;
        }
        const ui = createCostUi({ context: { Popup, POPUP_TYPE: { TEXT: 1 },
            translate: (fallback, key) => key === 'vertex_paygo.costs.cache_hit_rate' ? '自定义命中率' : fallback },
        documentRef: document, getChatId: () => 'chat',
        serverClient: { readUsage: async () => ({ ok: true, records }) } });
        await ui.open();
        const summary = find(shown, node => node.className === 'vertex-paygo-cost-summary');
        assert.ok(summary.textContent.includes(`自定义命中率 ${missingCache ? '—' : '74.5%'}`));
        const table = find(shown, node => node.tag === 'table');
        assert.equal(table.children[0].children[0].children[5].textContent, '自定义命中率');
        assert.equal(table.children[1].children[0].children[5].textContent, missingCache ? '—' : '80.0%');
        assert.equal(table.children[1].children[1].children[5].textContent, '20.0%');
        ui.destroy();
    }
});

test('attaches a menu entry and a new chat can edit prices without reading usage', async () => {
    const { document, menu } = fakeDocument();
    let reads = 0;
    let shown;
    class Popup { constructor(content) { this.content = content; shown = content; } async show() { return 0; } }
    const ui = createCostUi({
        context: { Popup, POPUP_TYPE: { TEXT: 1 } }, documentRef: document,
        serverClient: { readUsage: async () => { reads += 1; } }, getChatId: () => null,
    });
    assert.equal(menu.children.length, 1);
    assert.ok(text(menu).includes('对话费用估算'));
    await ui.open();
    assert.equal(reads, 0);
    assert.ok(text(shown).includes('价格设置（美元 / 百万 token）'));
    assert.ok(text(shown).some(value => value.includes('Vertex 按 Global 基础价')));
    assert.ok(text(shown).includes('尚无已采集请求；可先为当前模型配置价格。'));
    ui.destroy();
    assert.equal(menu.children.length, 0);
});

test('renders untrusted model names as text and uses the current price label for backfill estimates', async () => {
    const { document } = fakeDocument();
    let shown;
    let resolvePopup;
    let options;
    class Popup {
        constructor(content, _type, _unused, popupOptions) { shown = content; options = popupOptions; }
        show() { return new Promise(resolve => { resolvePopup = resolve; }); }
    }
    const key = JSON.stringify(['vertexai', '<img src=x onerror=alert(1)>', 'standard']);
    const ui = createCostUi({
        context: { Popup, POPUP_TYPE: { TEXT: 1 } }, documentRef: document,
        getChatId: () => 'chat-1', getCurrentPricingKey: () => ({ source: 'vertexai', model: 'm', tier: 'standard' }),
        getPrices: () => ({ [key]: { input: 1, cachedInput: .1, output: 2 } }),
        serverClient: { readUsage: async () => ({ ok: true, truncated: true, records: [{
            id: 'r1', chatId: 'chat-1', createdAt: '2026-01-01T00:00:00Z', source: 'vertexai',
            model: '<img src=x onerror=alert(1)>', tier: 'standard', status: 'complete', price: null,
            usage: { promptTokenCount: 10, cachedContentTokenCount: 2, candidatesTokenCount: 3 },
        }, {
            id: 'wrong-chat', chatId: 'chat-2', source: 'vertexai', model: 'must-not-render',
            tier: 'standard', status: 'complete', price: { input: 1, cachedInput: 1, output: 1 },
            usage: { promptTokenCount: 10, candidatesTokenCount: 3 },
        }, {
            id: 'limited', chatId: 'chat-1', source: 'vertexai', model: 'm', tier: 'standard',
            status: 'failed', errorCode: 'UPSTREAM_HTTP_429', usage: null,
        }, {
            id: 'compacted', chatId: 'chat-1', source: 'vertexai', model: 'm', tier: 'standard',
            status: 'incomplete', errorCode: 'USAGE_COMPRESSED_RESPONSE', usage: null,
        }] }) },
    });
    const promise = ui.open();
    await new Promise(resolve => setTimeout(resolve, 0));
    const allText = text(shown);
    assert.ok(allText.some(value => value.includes('<img src=x onerror=alert(1)>')));
    assert.ok(!allText.some(value => value.includes('must-not-render')));
    assert.ok(allText.includes('估算（按当前价格）'));
    assert.ok(allText.includes('请求失败（限流）'));
    assert.ok(allText.includes('压缩响应无法采集用量'));
    assert.ok(allText.some(value => value.includes('已估算小计')));
    assert.ok(allText.some(value => value.includes('当前仅显示部分账本')));
    assert.equal(options.allowHorizontalScrolling, true);
    assert.equal(options.allowVerticalScrolling, true);
    resolvePopup(0);
    await promise;
    ui.destroy();
});

test('a chat switch during loading replaces stale amounts with an explicit reopen notice', async () => {
    const { document } = fakeDocument();
    let shown;
    let closePopup;
    let finishRead;
    let chatId = 'chat-1';
    class Popup {
        constructor(content) { shown = content; }
        show() { return new Promise(resolve => { closePopup = resolve; }); }
    }
    const ui = createCostUi({
        context: { Popup, POPUP_TYPE: { TEXT: 1 } }, documentRef: document,
        getChatId: () => chatId, getCurrentPricingKey: () => ({ source: 'vertexai', model: 'm', tier: 'standard' }),
        serverClient: { readUsage: () => new Promise(resolve => { finishRead = resolve; }) },
    });
    const opened = ui.open();
    await Promise.resolve();
    chatId = 'chat-2';
    finishRead({ ok: true, records: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(text(shown).includes('当前对话已切换，请关闭并重新打开费用窗口。'));
    closePopup(0);
    await opened;
    ui.destroy();
});

test('warns that Tauri normalized non-stream usage may underestimate cost', async () => {
    const { document } = fakeDocument();
    let shown;
    let closePopup;
    class Popup { constructor(content) { shown = content; } show() { return new Promise(resolve => { closePopup = resolve; }); } }
    const ui = createCostUi({
        context: { Popup, POPUP_TYPE: { TEXT: 1 } }, documentRef: document,
        getChatId: () => 'chat-1', getCurrentPricingKey: () => ({ source: 'vertexai', model: 'm', tier: 'standard' }),
        coverageNotice: 'Agent 原生模型循环费用暂未计入。',
        serverClient: { readUsage: async () => ({ ok: true, records: [{
            id: 'r', chatId: 'chat-1', source: 'vertexai', model: 'm', tier: 'standard', status: 'complete',
            usageAccuracy: 'tauri-normalized', price: { input: 1, cachedInput: 0, output: 2 },
            usage: { promptTokenCount: 10, candidatesTokenCount: 2 },
        }] }) },
    });
    const opened = ui.open();
    await new Promise(setImmediate);
    assert.ok(text(shown).some(value => value.includes('非流式用量可能缺少思考 Token')));
    assert.ok(text(shown).includes('TauriTavern 用量信息可能不完整，仅部分估算'));
    assert.ok(text(shown).includes('Agent 原生模型循环费用暂未计入。'));
    closePopup(0);
    await opened;
    ui.destroy();
});

test('pending requests poll serially every five seconds until completion', async t => {
    const { document } = fakeDocument();
    const timers = [];
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
    };
    globalThis.clearTimeout = timer => { if (timer) timer.cleared = true; };
    t.after(() => { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; });
    let reads = 0;
    let closePopup;
    class Popup { show() { return new Promise(resolve => { closePopup = resolve; }); } }
    const ui = createCostUi({
        context: { Popup, POPUP_TYPE: { TEXT: 1 } }, documentRef: document,
        getChatId: () => 'chat-1', getCurrentPricingKey: () => ({ source: 'vertexai', model: 'm', tier: 'standard' }),
        serverClient: { readUsage: async () => ({ ok: true, records: [{
            id: 'pending', chatId: 'chat-1', source: 'vertexai', model: 'm', tier: 'flex',
            status: reads++ === 0 ? 'pending' : 'complete', usage: null,
        }] }) },
    });
    const opened = ui.open();
    await new Promise(setImmediate);
    assert.equal(reads, 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 5_000);
    timers[0].callback();
    await new Promise(setImmediate);
    assert.equal(reads, 2);
    assert.equal(timers.length, 1);
    closePopup(0);
    await opened;
    ui.destroy();
});

test('saving and resetting affect only the selected key and update its source label', async () => {
    const { document } = fakeDocument();
    let shown;
    let closePopup;
    const selected = { source: 'vertexai', model: 'gemini-test', tier: 'standard' };
    const selectedKey = JSON.stringify(Object.values(selected));
    const otherKey = JSON.stringify(['makersuite', 'other', 'standard']);
    const catalog = { input: 1, cachedInput: .1, output: 2 };
    let prices = { [selectedKey]: catalog, [otherKey]: { input: 9, cachedInput: 9, output: 9 } };
    let manual = false;
    const setCalls = [];
    class Popup {
        constructor(content) { shown = content; }
        show() { return new Promise(resolve => { closePopup = resolve; }); }
    }
    const ui = createCostUi({
        context: { Popup, POPUP_TYPE: { TEXT: 1 } }, documentRef: document,
        getChatId: () => null, getCurrentPricingKey: () => selected,
        getPrices: () => prices,
        getPriceInfo: () => ({ source: manual ? 'manual' : 'catalog', updatedAt: '2026-09-20', sourceUrl: 'https://example.com/pricing' }),
        setPrice: async (key, price) => {
            setCalls.push({ key, price });
            prices = { ...prices, [selectedKey]: price };
            manual = true;
        },
        resetPrice: async key => {
            assert.deepEqual(key, selected);
            prices = { ...prices, [selectedKey]: catalog };
            manual = false;
        },
        serverClient: { readUsage: async () => ({ ok: true, records: [] }) },
    });
    const opened = ui.open();
    await new Promise(setImmediate);
    assert.ok(text(shown).some(value => value.includes('自动价格 · 核验 2026-09-20')));
    const input = find(shown, node => node.name === 'input');
    input.value = '3';
    const form = find(shown, node => node.tag === 'form');
    await form.fire('submit');
    assert.equal(setCalls.length, 1);
    assert.equal(setCalls[0].price.input, 3);
    assert.deepEqual(prices[otherKey], { input: 9, cachedInput: 9, output: 9 });
    assert.ok(text(shown).includes('手动价格 · 核验 2026-09-20'));

    const reset = find(shown, node => node.textContent === '恢复自动价格');
    await reset.fire('click');
    assert.equal(prices[selectedKey].input, 1);
    assert.equal(input.value, 1);
    assert.ok(text(shown).includes('自动价格 · 核验 2026-09-20'));
    closePopup(0);
    await opened;
    ui.destroy();
});

test('catalog refresh preserves an edited field on failure and reloads prices and totals on success', async () => {
    const { document } = fakeDocument();
    let shown;
    let closePopup;
    const keyObject = { source: 'vertexai', model: 'm', tier: 'standard' };
    const key = JSON.stringify(Object.values(keyObject));
    let prices = { [key]: { input: 1, cachedInput: 0, output: 1 } };
    let updatedAt = '2026-09-21';
    let refreshResult = { applied: false, changed: false, error: '网络不可用', snapshot: null };
    let reads = 0;
    class Popup {
        constructor(content) { shown = content; }
        show() { return new Promise(resolve => { closePopup = resolve; }); }
    }
    const ui = createCostUi({
        context: { Popup, POPUP_TYPE: { TEXT: 1 } }, documentRef: document,
        getChatId: () => 'chat-1', getCurrentPricingKey: () => keyObject,
        getPrices: () => prices, getPriceInfo: () => ({ source: 'catalog', updatedAt }),
        refreshCatalog: async () => refreshResult,
        serverClient: { readUsage: async () => {
            reads += 1;
            return { ok: true, records: [{
                id: 'r', chatId: 'chat-1', source: 'vertexai', model: 'm', tier: 'standard', status: 'complete',
                usage: { promptTokenCount: 1_000_000, cachedContentTokenCount: 0, candidatesTokenCount: 0 },
            }] };
        } },
    });
    const opened = ui.open();
    await new Promise(setImmediate);
    const input = find(shown, node => node.name === 'input');
    const refresh = find(shown, node => node.textContent === '更新支持列表和价格');
    input.value = '77';
    prices = { ...prices, [JSON.stringify(['vertexai', 'new-model', 'standard'])]: { input: 2, cachedInput: 0, output: 2 } };
    updatedAt = '2026-09-22';
    const ledgerRefresh = find(shown, node => node.textContent === '刷新');
    await ledgerRefresh.fire('click');
    await new Promise(setImmediate);
    assert.equal(input.value, '77');
    assert.ok(text(shown).includes('自动价格 · 核验 2026-09-22'));
    const modelList = find(shown, node => node.tag === 'datalist');
    assert.ok(modelList.children.some(option => option.value === 'new-model'));
    await refresh.fire('click');
    assert.equal(input.value, '77');
    assert.ok(text(shown).some(value => value.includes('更新失败，已保留现有价格：网络不可用')));
    assert.equal(reads, 2);

    prices = { [key]: { input: 4, cachedInput: 0, output: 1 } };
    refreshResult = { applied: true, changed: true, snapshot: {}, pricingSnapshot: {} };
    await refresh.fire('click');
    assert.equal(input.value, 4);
    assert.equal(reads, 3);
    assert.ok(text(shown).some(value => value.includes('已估算小计 $4.000000')));
    closePopup(0);
    await opened;
    ui.destroy();
});
