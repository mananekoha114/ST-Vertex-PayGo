/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

import { normalizePrice, priceKey } from './cost-model.js';

function element(documentRef, tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

function choiceLabel(name, value) {
    if (name === 'source') return ({ vertexai: 'Vertex AI', makersuite: 'Google AI Studio' })[value] ?? value;
    if (name === 'tier') return ({ standard: '标准', flex: 'Flex', priority: 'Priority' })[value] ?? value;
    return value;
}

function parsePriceForm(inputs) {
    const raw = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value]));
    return normalizePrice(raw);
}


export function createPriceSettingsUi({ documentRef = globalThis.document,
    getCurrentPricingKey, getPrices = () => ({}), getPriceInfo = () => ({ source: 'missing' }),
    setPrice, resetPrice, refreshCatalog, onChange } = {}) {
    const pricing = element(documentRef, 'section', 'vertex-paygo-cost-pricing');
    pricing.id = 'vertex-paygo-pricing-settings';
    const feedback = element(documentRef, 'p', 'vertex-paygo-cost-feedback');
    feedback.setAttribute('aria-live', 'polite');
    pricing.append(element(documentRef, 'h4', 'vertex-paygo-group-title', '价格设置（美元 / 百万 token）'));
    pricing.append(element(documentRef, 'p', 'vertex-paygo-cost-pricing-note',
        '自动价格为公开付费文本单价；Vertex 按 Global 基础价。地区差价、免费额度和账户折扣请手动调整。'));
    const form = element(documentRef, 'form', 'vertex-paygo-cost-price-form');
    const priceMeta = element(documentRef, 'p', 'vertex-paygo-cost-price-meta');
    const keyFields = { source: '来源', model: '模型', tier: '服务层级' };
    const priceFields = {
        input: '输入', cachedInput: '缓存输入', output: '输出',
        longContextThreshold: '长上下文阈值（token）', longInput: '长上下文输入',
        longCachedInput: '长上下文缓存输入', longOutput: '长上下文输出',
    };
    const inputs = {};
    const keyLists = {};
    const currentKey = { ...getCurrentPricingKey?.() };
    for (const [name, caption] of Object.entries(keyFields)) {
        const field = element(documentRef, 'label', 'vertex-paygo-cost-field');
        field.append(element(documentRef, 'span', '', caption));
        const input = element(documentRef, name === 'model' ? 'input' : 'select', 'text_pole');
        input.setAttribute('name', name);
        let list = input;
        if (name === 'model') {
            input.setAttribute('type', 'text');
            list = element(documentRef, 'datalist');
            list.id = 'vertex-paygo-cost-model-list';
            input.setAttribute('list', list.id);
            pricing.append(list);
        } else {
            const defaults = name === 'source' ? ['vertexai', 'makersuite'] : ['standard', 'flex', 'priority'];
            if (currentKey[name] && !defaults.includes(currentKey[name])) defaults.push(currentKey[name]);
            for (const value of defaults) {
                const option = element(documentRef, 'option', '', choiceLabel(name, value));
                option.value = value;
                input.append(option);
            }
        }
        input.value = String(currentKey[name] ?? '');
        field.append(input);
        form.append(field);
        inputs[name] = input;
        keyLists[name] = list;
    }
    const initialPrices = getPrices?.() ?? {};
    const initial = normalizePrice(initialPrices[priceKey(currentKey)]) ?? {};
    const priceInputs = {};
    for (const [name, caption] of Object.entries(priceFields)) {
        const field = element(documentRef, 'label', 'vertex-paygo-cost-field');
        field.append(element(documentRef, 'span', '', caption));
        const input = element(documentRef, 'input', 'text_pole');
        input.setAttribute('name', name);
        input.setAttribute('type', 'number');
        input.setAttribute('min', '0');
        input.setAttribute('step', 'any');
        input.value = initial[name] ?? '';
        field.append(input);
        form.append(field);
        priceInputs[name] = input;
    }
    function selectedKeyObject() {
        return {
            source: inputs.source.value.trim(), model: inputs.model.value.trim(), tier: inputs.tier.value.trim(),
        };
    }
    function updateKeyLists(records = []) {
        const priceKeys = Object.keys(getPrices?.() ?? {}).flatMap(key => {
            try {
                const parsed = JSON.parse(key);
                return Array.isArray(parsed) && parsed.length === 3
                    ? [{ source: parsed[0], model: parsed[1], tier: parsed[2] }]
                    : [];
            } catch { return []; }
        });
        for (const name of Object.keys(keyLists)) {
            const values = new Set([
                currentKey[name],
                ...priceKeys.map(key => key[name]),
                ...records.map(record => record?.[name]),
            ].filter(Boolean));
            if (name !== 'model') {
                for (const value of values) {
                    if ([...keyLists[name].children].some(option => option.value === value)) continue;
                    const option = element(documentRef, 'option', '', choiceLabel(name, value));
                    option.value = String(value);
                    keyLists[name].append(option);
                }
                continue;
            }
            keyLists[name].replaceChildren(...[...values].map(value => {
                const option = element(documentRef, 'option');
                option.value = String(value);
                return option;
            }));
        }
    }
    function renderPriceMeta() {
        const info = getPriceInfo?.(selectedKeyObject()) ?? { source: 'missing' };
        const labels = { manual: '手动价格', catalog: '自动价格', missing: '暂无价格' };
        const parts = [labels[info.source] ?? '暂无价格'];
        if (info.updatedAt) parts.push(`核验 ${info.updatedAt}`);
        if (info.validUntil) parts.push(`有效至 ${info.validUntil}`);
        priceMeta.replaceChildren(element(documentRef, 'span', '', parts.join(' · ')));
        if (typeof info.sourceUrl === 'string' && info.sourceUrl.startsWith('https://')) {
            const link = element(documentRef, 'a', '', '官方来源');
            link.href = info.sourceUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            priceMeta.append(element(documentRef, 'span', '', ' · '), link);
        }
    }
    function loadSelectedPrice() {
        const selected = normalizePrice((getPrices?.() ?? {})[priceKey(selectedKeyObject())]) ?? {};
        for (const [name, input] of Object.entries(priceInputs)) input.value = selected[name] ?? '';
        renderPriceMeta();
    }
    for (const input of Object.values(inputs)) input.addEventListener('change', loadSelectedPrice);
    updateKeyLists();
    const actions = element(documentRef, 'div', 'vertex-paygo-cost-price-actions');
    const save = element(documentRef, 'button', 'menu_button', '保存手动价格');
    save.setAttribute('type', 'submit');
    const reset = element(documentRef, 'button', 'menu_button', '恢复自动价格');
    reset.setAttribute('type', 'button');
    reset.disabled = typeof resetPrice !== 'function';
    const catalogRefresh = element(documentRef, 'button', 'menu_button', '更新支持列表和价格');
    catalogRefresh.setAttribute('type', 'button');
    catalogRefresh.disabled = typeof refreshCatalog !== 'function';
    actions.append(save, reset, catalogRefresh);
    form.append(actions);
    pricing.append(form, priceMeta, feedback);
    renderPriceMeta();

    form.addEventListener('submit', async event => {
        event.preventDefault?.();
        const key = selectedKeyObject();
        const price = parsePriceForm(priceInputs);
        if (!key.source || !key.model || !key.tier || !price) {
            feedback.textContent = '请填写来源、模型、层级及非负的输入/缓存/输出价格；长上下文价格须成组填写。';
            feedback.dataset.state = 'error';
            return;
        }
        try {
            if (typeof setPrice !== 'function') throw new Error('价格保存接口不可用');
            await setPrice(key, price);
            feedback.textContent = '价格已保存。';
            feedback.dataset.state = 'success';
            loadSelectedPrice();
            await onChange?.();
        } catch (error) {
            feedback.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`;
            feedback.dataset.state = 'error';
        }
    });

    reset.addEventListener('click', async () => {
        reset.disabled = true;
        try {
            await resetPrice(selectedKeyObject());
            loadSelectedPrice();
            feedback.textContent = '已恢复自动价格。';
            feedback.dataset.state = 'success';
            await onChange?.();
        } catch (error) {
            feedback.textContent = `恢复失败：${error instanceof Error ? error.message : String(error)}`;
            feedback.dataset.state = 'error';
        } finally { reset.disabled = false; }
    });

    catalogRefresh.addEventListener('click', async () => {
        catalogRefresh.disabled = true;
        try {
            const result = await refreshCatalog();
            if (!result?.applied) {
                feedback.textContent = `更新失败，已保留现有价格${result?.error ? `：${result.error}` : '。'}`;
                feedback.dataset.state = 'error';
                return;
            }
            updateKeyLists();
            loadSelectedPrice();
            feedback.textContent = result.changed ? '支持列表和价格已更新。' : '支持列表和价格已是最新。';
            feedback.dataset.state = 'success';
            await onChange?.();
        } catch (error) {
            feedback.textContent = `更新失败，已保留现有价格：${error instanceof Error ? error.message : String(error)}`;
            feedback.dataset.state = 'error';
        } finally { catalogRefresh.disabled = false; }
    });

    // Showing the pricing tab follows the current connection, even after
    // switching sources or models.
    const syncCurrentKey = () => {
        const key = getCurrentPricingKey?.() ?? {};
        for (const name of Object.keys(inputs)) {
            currentKey[name] = key[name];
        }
        updateKeyLists();
        for (const [name, input] of Object.entries(inputs)) input.value = String(key[name] ?? '');
        loadSelectedPrice();
    };
    return { root: pricing, updateKeyLists, renderPriceMeta, syncCurrentKey, destroy() {
        pricing.remove();
    } };
}
