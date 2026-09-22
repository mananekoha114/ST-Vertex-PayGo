/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0.
 */

import { normalizePrice, priceKey, summarizeUsage } from './cost-model.js';

const POLL_MS = 5_000;

function element(documentRef, tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}

function money(value) {
    return `$${Number(value).toFixed(6)}`;
}

function errorText(code) {
    const normalized = String(code ?? '').toUpperCase();
    if (!normalized) return '';
    if (normalized === '429' || normalized.endsWith('_429') || normalized.includes('RATE') || normalized.includes('QUOTA')) return '限流';
    if (normalized.includes('ABORT') || normalized.includes('CANCEL') || normalized === 'CLIENT_DISCONNECTED') return '连接中断';
    if (normalized.includes('COMPRESS') || normalized.includes('COMPACT')) return '压缩响应无法采集用量';
    if (normalized.includes('RESTART')) return '服务重启，用量不完整';
    if (normalized.includes('TIMEOUT')) return '等待用量超时';
    if (normalized === 'UPSTREAM_RESPONSE_STREAM_FAILED') return '响应流中断';
    if (normalized === 'USAGE_METADATA_MISSING') return '未返回用量';
    if (normalized.includes('LIMIT')) return '用量采集超出限制';
    const http = normalized.match(/HTTP_(\d{3})$/);
    if (http) return `HTTP ${http[1]}`;
    return '请求错误';
}

function statusText(record, estimate) {
    if (record?.status === 'pending') return '待生成';
    if (record?.status === 'failed') return `请求失败${errorText(record.errorCode) ? `（${errorText(record.errorCode)}）` : ''}`;
    if (record?.status === 'incomplete' && record.errorCode) {
        return errorText(record.errorCode) + (estimate.amount !== null ? '，部分估算' : '');
    }
    const reasons = {
        usage_missing: '无用量数据', usage_incomplete: '用量数据不完整',
        cache_exceeds_prompt: '用量数据无效', provisioned_throughput: '预置吞吐量无法估算',
        unsupported_modality: '非文本模态无法估算', traffic_tier_mismatch: '计费层级不匹配',
        price_missing: '未知价格，待配置', long_price_missing: '长上下文价格待配置',
        tool_use: '含工具调用，仅部分估算', request_incomplete: '用量不完整，仅部分估算',
    };
    if (estimate.reason && reasons[estimate.reason]) {
        const suffix = estimate.priceSource === 'current' && estimate.amount !== null ? '（按当前价格）' : '';
        return `${reasons[estimate.reason]}${suffix}`;
    }
    if (record?.status === 'incomplete') return '用量不完整';
    if (estimate.status === 'estimated') return estimate.priceSource === 'current' ? '估算（按当前价格）' : '估算';
    if (estimate.status === 'partial') return estimate.priceSource === 'current' ? '部分估算（按当前价格）' : '部分估算';
    if (estimate.status === 'unpriced') return '未知价格，待配置';
    return errorText(record?.errorCode) || '无法估算';
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

export function createCostUi({
    context,
    serverClient,
    getChatId,
    getCurrentPricingKey,
    getPrices = () => ({}),
    getPriceInfo = () => ({ source: 'missing' }),
    setPrice,
    resetPrice,
    refreshCatalog,
    documentRef = globalThis.document,
}) {
    if (!documentRef?.createElement) throw new TypeError('A document implementation is required.');
    const menu = documentRef.getElementById('extensionsMenu');
    if (!menu) throw new Error('#extensionsMenu is unavailable.');

    const menuItem = element(documentRef, 'div', 'list-group-item flex-container flexGap5 interactable vertex-paygo-cost-menu');
    menuItem.setAttribute('role', 'button');
    menuItem.setAttribute('tabindex', '0');
    const icon = element(documentRef, 'i', 'fa-solid fa-coins extensionsMenuExtensionButton');
    const label = element(documentRef, 'span', '', '对话费用估算');
    menuItem.append(icon, label);
    menu.append(menuItem);

    let destroyed = false;
    let pollTimer = null;
    let activeChatId = null;
    let popup = null;
    let renderToken = 0;

    function stopPolling() {
        if (pollTimer !== null) clearTimeout(pollTimer);
        pollTimer = null;
    }

    function buildContent(chatId) {
        const root = element(documentRef, 'section', 'vertex-paygo-cost');
        root.append(element(documentRef, 'h3', '', '当前对话费用估算'));
        const feedback = element(documentRef, 'p', 'vertex-paygo-cost-feedback');
        feedback.setAttribute('aria-live', 'polite');
        const summary = element(documentRef, 'div', 'vertex-paygo-cost-summary', '正在读取用量…');
        const refresh = element(documentRef, 'button', 'menu_button vertex-paygo-cost-refresh', '刷新');
        refresh.setAttribute('type', 'button');
        const tableWrap = element(documentRef, 'div', 'vertex-paygo-cost-table-wrap');
        root.append(summary, refresh, tableWrap);

        const pricing = element(documentRef, 'details', 'vertex-paygo-cost-pricing');
        pricing.append(element(documentRef, 'summary', '', '价格设置（美元 / 百万 token）'));
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
        const currentKey = getCurrentPricingKey?.() ?? {};
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
                root.append(list);
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
        root.append(pricing);
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
                await load();
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
                await load();
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
                await load();
            } catch (error) {
                feedback.textContent = `更新失败，已保留现有价格：${error instanceof Error ? error.message : String(error)}`;
                feedback.dataset.state = 'error';
            } finally { catalogRefresh.disabled = false; }
        });

        async function load() {
            const token = ++renderToken;
            stopPolling();
            refresh.disabled = true;
            try {
                if (!chatId) {
                    summary.textContent = '尚无已采集请求；可先为当前模型配置价格。';
                    tableWrap.replaceChildren();
                    return;
                }
                if (getChatId?.() !== chatId) {
                    summary.textContent = '当前对话已切换，请关闭并重新打开费用窗口。';
                    tableWrap.replaceChildren();
                    return;
                }
                const response = await serverClient.readUsage(chatId);
                if (token !== renderToken || activeChatId !== chatId) return;
                if (getChatId?.() !== chatId) {
                    summary.textContent = '当前对话已切换，请关闭并重新打开费用窗口。';
                    tableWrap.replaceChildren();
                    return;
                }
                if (!response?.ok) throw new Error(response?.error || '读取失败');
                const records = (Array.isArray(response.records) ? response.records : [])
                    .filter(record => record?.chatId === chatId);
                updateKeyLists(records);
                const result = summarizeUsage(records, getPrices?.() ?? {});
                const latest = result.details.at(-1)?.estimate;
                const subtotal = result.estimatedCount ? money(result.amount) : '—';
                const latestAmount = latest?.amount === null || latest === undefined ? '—' : money(latest.amount);
                summary.textContent = `已估算小计 ${subtotal} · 最近一次 ${latestAmount} · ${result.requestCount} 次请求 · 缓存命中 ${result.cachedTokenCount} token · 待计价 ${result.unpricedCount} · 不完整 ${result.incompleteCount}`;
                if (response.truncated) summary.append(element(documentRef, 'strong', 'vertex-paygo-cost-truncated', ' · 记录过多，当前仅显示部分账本'));
                tableWrap.replaceChildren();
                const table = element(documentRef, 'table', 'vertex-paygo-cost-table');
                const head = element(documentRef, 'thead');
                const headRow = element(documentRef, 'tr');
                for (const title of ['时间', '模型 / 层级', '状态', '输入', '缓存', '输出', '思考', '费用']) headRow.append(element(documentRef, 'th', '', title));
                head.append(headRow);
                const body = element(documentRef, 'tbody');
                // Sum the entire ledger, but bound the number of live DOM rows.
                if (result.details.length > 200) tableWrap.append(element(documentRef, 'p', '', '累计包含全部请求；下表显示最近 200 条。'));
                for (const { record, estimate } of result.details.slice(-200).reverse()) {
                    const row = element(documentRef, 'tr');
                    const count = name => {
                        const value = record.usage?.[name];
                        return Number.isSafeInteger(value) && value >= 0 ? String(value) : '—';
                    };
                    const status = element(documentRef, 'td', '', statusText(record, estimate));
                    status.title = [record.errorCode, estimate.reason].filter(Boolean).join(' / ');
                    row.append(
                        element(documentRef, 'td', '', record.createdAt ? new Date(record.createdAt).toLocaleString() : '—'),
                        element(documentRef, 'td', '', `${choiceLabel('source', record.source || '')} · ${record.model || '未知模型'} / ${record.tier || '未知层级'}`),
                        status,
                        element(documentRef, 'td', '', count('promptTokenCount')),
                        element(documentRef, 'td', '', count('cachedContentTokenCount')),
                        element(documentRef, 'td', '', count('candidatesTokenCount')),
                        element(documentRef, 'td', '', count('thoughtsTokenCount')),
                        element(documentRef, 'td', '', estimate.amount === null ? '—' : money(estimate.amount)),
                    );
                    body.append(row);
                }
                table.append(head, body);
                tableWrap.append(table);
                if (records.some(record => record.status === 'pending')) {
                    pollTimer = setTimeout(() => void load(), POLL_MS);
                }
            } catch (error) {
                if (token === renderToken) summary.textContent = `无法读取用量：${error instanceof Error ? error.message : String(error)}`;
            } finally {
                if (token === renderToken) refresh.disabled = false;
            }
        }
        refresh.addEventListener('click', () => {
            updateKeyLists();
            renderPriceMeta();
            void load();
        });
        return { root, load };
    }

    async function open() {
        if (destroyed || popup) return;
        stopPolling();
        const chatId = getChatId?.();
        activeChatId = typeof chatId === 'string' && chatId ? chatId : null;
        const view = buildContent(activeChatId);
        popup = new context.Popup(view.root, context.POPUP_TYPE.TEXT, '', {
            okButton: '关闭', wide: true, large: true, leftAlign: true,
            allowHorizontalScrolling: true, allowVerticalScrolling: true,
        });
        void view.load();
        try { return await popup.show(); } finally { stopPolling(); activeChatId = null; popup = null; ++renderToken; }
    }

    function onActivate(event) {
        if (event?.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
        event?.preventDefault?.();
        void open();
    }
    menuItem.addEventListener('click', onActivate);
    menuItem.addEventListener('keydown', onActivate);
    const onChatChanged = () => {
        stopPolling();
        ++renderToken;
        popup?.complete?.(context.POPUP_RESULT?.CANCELLED);
    };
    if (context.eventTypes?.CHAT_CHANGED) context.eventSource?.on(context.eventTypes.CHAT_CHANGED, onChatChanged);

    return {
        open,
        destroy() {
            destroyed = true;
            stopPolling();
            ++renderToken;
            menuItem.remove();
            context.eventSource?.removeListener?.(context.eventTypes?.CHAT_CHANGED, onChatChanged);
            popup?.complete?.(context.POPUP_RESULT?.CANCELLED);
        },
    };
}
