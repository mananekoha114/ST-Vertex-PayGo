/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0.
 */

import { calculateCacheHitRate, summarizeUsage } from './cost-model.js';
import { createLocalizer } from './i18n.js';
import { createPriceSettingsUi } from './price-settings-ui.js';
import { mountExtensionSettings } from './extension-settings.js';

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

function cacheRate(value) {
    return value == null ? '—' : `${(value * 100).toFixed(1)}%`;
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
        tauri_normalized: 'TauriTavern 用量信息可能不完整，仅部分估算',
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
    coverageNotice = '',
    documentRef = globalThis.document,
    localize = createLocalizer((fallback, key) => context?.translate?.(fallback, key)),
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
    let activeView = null;
    const priceSettings = createPriceSettingsUi({ documentRef, getCurrentPricingKey, getPrices, getPriceInfo,
        setPrice, resetPrice, refreshCatalog, onChange: async () => {
            if (!destroyed && activeView) await activeView.load();
        } });
    const unmountSettings = mountExtensionSettings(priceSettings.root, { documentRef, tab: 'pricing',
        label: localize('vertex_paygo.settings.tab.pricing'), onShow: priceSettings.syncCurrentKey });

    function stopPolling() {
        if (pollTimer !== null) clearTimeout(pollTimer);
        pollTimer = null;
    }

    function buildContent(chatId) {
        const root = element(documentRef, 'section', 'vertex-paygo-cost');
        root.append(element(documentRef, 'h3', '', '当前对话费用估算'));
        const summary = element(documentRef, 'div', 'vertex-paygo-cost-summary', '正在读取用量…');
        const refresh = element(documentRef, 'button', 'menu_button vertex-paygo-cost-refresh', '刷新');
        refresh.setAttribute('type', 'button');
        const tableWrap = element(documentRef, 'div', 'vertex-paygo-cost-table-wrap');
        root.append(summary, refresh, tableWrap);
        if (coverageNotice) root.append(element(documentRef, 'p', 'vertex-paygo-cost-coverage-notice', coverageNotice));

        async function load() {
            const token = ++renderToken;
            stopPolling();
            refresh.disabled = true;
            try {
                if (!chatId) {
                    summary.textContent = '尚无已采集请求；价格可在扩展设置的 ST-Vertex-PayGo「价格」页配置。';
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
                priceSettings.updateKeyLists(records);
                const result = summarizeUsage(records, getPrices?.() ?? {});
                const latest = result.details.at(-1)?.estimate;
                const subtotal = result.estimatedCount ? money(result.amount) : '—';
                const latestAmount = latest?.amount === null || latest === undefined ? '—' : money(latest.amount);
                summary.textContent = `已估算小计 ${subtotal} · 最近一次 ${latestAmount} · ${result.requestCount} 次请求 · 缓存命中 ${result.cachedTokenCount} token · 待计价 ${result.unpricedCount} · 不完整 ${result.incompleteCount}`;
                summary.textContent += ` · ${localize('vertex_paygo.costs.cache_hit_rate')} ${cacheRate(result.cacheHitRate)}`;
                summary.title = localize('vertex_paygo.costs.cache_hit_rate_hint');
                if (response.truncated) summary.append(element(documentRef, 'strong', 'vertex-paygo-cost-truncated', ' · 记录过多，当前仅显示部分账本'));
                tableWrap.replaceChildren();
                if (records.some(record => record.usageAccuracy === 'tauri-normalized')) {
                    tableWrap.append(element(documentRef, 'p', 'vertex-paygo-cost-tauri-warning',
                        '由于 TauriTavern 非流式用量可能缺少思考 Token 等信息，估算可能不准确或偏低。'));
                }
                const table = element(documentRef, 'table', 'vertex-paygo-cost-table');
                const head = element(documentRef, 'thead');
                const headRow = element(documentRef, 'tr');
                for (const title of ['时间', '模型 / 层级', '状态', '输入', '缓存', localize('vertex_paygo.costs.cache_hit_rate'), '输出', '思考', '费用']) headRow.append(element(documentRef, 'th', '', title));
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
                        element(documentRef, 'td', '', cacheRate(calculateCacheHitRate([record]))),
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
            priceSettings.updateKeyLists();
            priceSettings.renderPriceMeta();
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
        activeView = view;
        popup = new context.Popup(view.root, context.POPUP_TYPE.TEXT, '', {
            okButton: '关闭', wide: true, large: true, leftAlign: true,
            allowHorizontalScrolling: true, allowVerticalScrolling: true,
        });
        void view.load();
        try { return await popup.show(); } finally { stopPolling(); activeChatId = null; popup = null; activeView = null; ++renderToken; }
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
            if (destroyed) return;
            destroyed = true;
            stopPolling();
            ++renderToken;
            menuItem.remove();
            activeView = null;
            priceSettings.destroy();
            unmountSettings();
            context.eventSource?.removeListener?.(context.eventTypes?.CHAT_CHANGED, onChatChanged);
            popup?.complete?.(context.POPUP_RESULT?.CANCELLED);
        },
    };
}
