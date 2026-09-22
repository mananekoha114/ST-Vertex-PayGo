/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/ */

import { normalizePrice, priceKey } from './cost-model.js';
import { getActivePricing } from './model-policy.js';

const SETTINGS_KEY = 'vertex-paygo-costs';

export function createConversationId(cryptoImpl = globalThis.crypto) {
    if (typeof cryptoImpl?.randomUUID === 'function') return cryptoImpl.randomUUID();
    // LAN HTTP pages do not expose randomUUID, while getRandomValues remains
    // available. This ID is a correlation key, never an authorization token.
    if (typeof cryptoImpl?.getRandomValues === 'function') {
        const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }
    return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function identity(context) {
    const chat = context.getCurrentChatId?.() ?? context.chatId;
    if (typeof chat !== 'string' || !chat) return null;
    const owner = context.groupId != null && context.groupId !== ''
        ? ['group', String(context.groupId)]
        : ['character', context.characters?.[context.characterId]?.avatar];
    if (!owner[1]) return null;
    return JSON.stringify([...owner, chat.replace(/\.jsonl$/i, '')]);
}

// Account settings survive browser reloads and server restarts. Chat names stay
// in local ST settings; only random conversation IDs are sent to the usage API.
export function createCostContext({ getContext, idFactory = createConversationId, getPricing = getActivePricing, now = Date.now }) {
    function settings(context = getContext()) {
        const root = context.extensionSettings;
        if (!root) throw new Error('SillyTavern extension settings are unavailable.');
        const value = root[SETTINGS_KEY] ??= { conversations: {}, prices: {} };
        value.conversations ??= {};
        value.prices ??= {};
        return value;
    }

    function getChatId() {
        const context = getContext();
        const key = identity(context);
        return key ? settings(context).conversations[key] ?? null : null;
    }

    function captureUsageContext() {
        const context = getContext();
        const key = identity(context);
        if (!key) return null;
        const config = settings(context);
        if (!config.conversations[key]) {
            config.conversations[key] = idFactory();
            context.saveSettingsDebounced();
        }
        return config.conversations[key];
    }

    function catalogPrices() {
        const catalog = getPricing();
        const today = new Date(now()).toISOString().slice(0, 10);
        const entries = catalog.entries.filter(entry => !entry.validUntil || today <= entry.validUntil);
        return { catalog, entries };
    }

    function getPrices() {
        const prices = Object.fromEntries(catalogPrices().entries.map(entry => [priceKey(entry), normalizePrice(entry)]));
        for (const [key, value] of Object.entries(settings().prices)) {
            const rate = normalizePrice(value);
            if (rate) prices[key] = rate;
        }
        return prices;
    }

    function getPriceInfo(key) {
        if (normalizePrice(settings().prices[priceKey(key)])) return { source: 'manual' };
        const { catalog, entries } = catalogPrices();
        const entry = entries.find(entry => priceKey(entry) === priceKey(key));
        return entry ? { source: 'catalog', updatedAt: catalog.updatedAt,
            validUntil: entry.validUntil, sourceUrl: entry.sourceUrl } : { source: 'missing', updatedAt: catalog.updatedAt };
    }
    function setPrices(prices) {
        const validated = {};
        for (const [key, value] of Object.entries(prices)) {
            const rate = normalizePrice(value);
            if (!rate) throw new TypeError('Invalid token price.');
            validated[key] = rate;
        }
        const context = getContext();
        settings(context).prices = validated;
        context.saveSettingsDebounced();
    }

    function setPrice(key, price) {
        setPrices({ ...settings().prices, [priceKey(key)]: price });
    }

    function resetPrice(key) {
        const prices = { ...settings().prices };
        delete prices[priceKey(key)];
        setPrices(prices);
    }

    function getUsagePrice(data, state) {
        return normalizePrice(getPrices()[priceKey({
            source: data.chat_completion_source, model: data.model, tier: state.tier,
        })]);
    }

    function renamed({ avatarId, groupId, oldFileName, newFileName } = {}) {
        if (!oldFileName || !newFileName) return;
        const owner = groupId != null && groupId !== '' ? ['group', String(groupId)] : ['character', avatarId];
        if (!owner[1]) return;
        const context = getContext();
        const map = settings(context).conversations;
        const oldKey = JSON.stringify([...owner, oldFileName.replace(/\.jsonl$/i, '')]);
        const newKey = JSON.stringify([...owner, newFileName.replace(/\.jsonl$/i, '')]);
        if (map[oldKey]) {
            map[newKey] = map[oldKey];
            delete map[oldKey];
            context.saveSettingsDebounced();
        }
    }
    const context = getContext();
    if (context.eventTypes?.CHAT_RENAMED) context.eventSource?.on(context.eventTypes.CHAT_RENAMED, renamed);

    return { getChatId, captureUsageContext, getPrices, setPrices, setPrice, resetPrice, getPriceInfo, getUsagePrice,
        destroy() { context.eventSource?.removeListener?.(context.eventTypes?.CHAT_RENAMED, renamed); } };
}
