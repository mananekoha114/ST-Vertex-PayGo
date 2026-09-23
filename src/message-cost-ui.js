/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0.
 */

import { formatMessageCostLabel, formatMessageMoney, summarizeMessageCost } from './message-cost-view.js';
import { createLocalizer, getTierLabel } from './i18n.js';

const ROOT_CLASS = 'vertex-paygo-message-cost';
const messageKey = name => `vertex_paygo.message_cost.${name}`;

function node(documentRef, tag, className = '', text = '') {
    const result = documentRef.createElement(tag);
    if (className) result.className = className;
    if (text !== '') result.textContent = text;
    return result;
}

function formatTokens(value) {
    return value == null ? '—' : Number(value).toLocaleString();
}

function formatDuration(value, localize) {
    if (value == null) return '—';
    return value < 1000 ? localize(messageKey('unit_ms'), { value: Math.round(value) })
        : localize(messageKey('unit_seconds'), { value: (value / 1000).toFixed(2) });
}

function formatTps(value, localize) {
    return value == null ? '—' : localize(messageKey('unit_tps'), { value: value.toFixed(1) });
}

function addMetric(documentRef, parent, label, value, note = '') {
    const item = node(documentRef, 'div', 'vertex-paygo-message-cost-metric');
    item.append(node(documentRef, 'span', 'vertex-paygo-message-cost-metric-label', label));
    item.append(node(documentRef, 'strong', '', value));
    if (note) item.append(node(documentRef, 'small', '', note));
    parent.append(item);
}

const REASON_LABELS = new Set([
    'pending', 'unavailable', 'usage_missing', 'usage_incomplete', 'tauri_normalized',
    'price_missing', 'long_price_missing', 'traffic_tier_mismatch', 'provisioned_throughput',
    'unsupported_modality', 'cache_exceeds_prompt', 'amount_out_of_range', 'request_pending',
    'request_incomplete', 'request_failed', 'tool_use', 'timing_missing',
]);

function buildCard(documentRef, summary, onClose, localize) {
    const card = node(documentRef, 'section', 'vertex-paygo-message-cost-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', localize(messageKey('dialog_label')));
    card.tabIndex = -1;

    const header = node(documentRef, 'header');
    const heading = node(documentRef, 'div', 'vertex-paygo-message-cost-heading');
    heading.append(node(documentRef, 'strong', '', localize(messageKey('title'))));
    heading.append(node(documentRef, 'span', '', localize(messageKey(summary.complete ? 'estimate_complete' : 'estimate_partial'))));
    const closeButton = node(documentRef, 'button', 'vertex-paygo-message-cost-close', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', localize(messageKey('close')));
    closeButton.onclick = onClose;
    header.append(heading, closeButton);
    card.append(header);

    const top = node(documentRef, 'div', 'vertex-paygo-message-cost-top');
    addMetric(documentRef, top, localize(messageKey('input')), summary.hasUsage ? formatTokens(summary.promptTokens) : '—', localize(messageKey('unit_tokens')));
    const thinkingKnown = summary.thinkingTokens != null;
    addMetric(documentRef, top, localize(messageKey(thinkingKnown ? 'output_with_thinking' : 'output_reported')),
        summary.hasUsage ? formatTokens(summary.outputTokens + (summary.thinkingTokens ?? 0)) : '—',
        summary.hasUsage ? thinkingKnown ? localize(messageKey('output_breakdown'), {
            output: formatTokens(summary.outputTokens), thinking: formatTokens(summary.thinkingTokens),
        }) : localize(messageKey('thinking_unreported')) : localize(messageKey('unit_tokens')));
    const generationNote = summary.generationTps != null ? localize(messageKey('client_observed'))
        : summary.reasons.includes('timing_missing') ? localize(messageKey('stream_timing_missing')) : localize(messageKey('stream_only'));
    addMetric(documentRef, top, localize(messageKey('generation_speed')), formatTps(summary.generationTps, localize), generationNote);
    card.append(top);

    const cost = node(documentRef, 'div', 'vertex-paygo-message-cost-amount');
    cost.append(node(documentRef, 'span', '', localize(messageKey('local_cost'))));
    cost.append(node(documentRef, 'strong', '', summary.hasAmount ? formatMessageMoney(summary.amount)
        : localize(messageKey(summary.awaitingPrice ? 'label_unpriced' : 'cost_unavailable'))));
    const qualifiers = [];
    if (summary.priceSource === 'current' || summary.priceSource === 'mixed') qualifiers.push(localize(messageKey('current_price')));
    for (const reason of summary.reasons) {
        const label = REASON_LABELS.has(reason) ? localize(messageKey(`reason.${reason}`)) : null;
        if (label && !qualifiers.includes(label)) qualifiers.push(label);
    }
    if (qualifiers.length) cost.append(node(documentRef, 'small', '', qualifiers.join(' · ')));
    card.append(cost);

    const details = node(documentRef, 'div', 'vertex-paygo-message-cost-details');
    addMetric(documentRef, details, localize(messageKey('thinking')), summary.hasUsage ? formatTokens(summary.thinkingTokens) : '—');
    addMetric(documentRef, details, localize(messageKey('cached')), summary.hasUsage ? formatTokens(summary.cachedTokens) : '—');
    addMetric(documentRef, details, localize(messageKey('uncached')), summary.hasUsage ? formatTokens(summary.uncachedTokens) : '—');
    addMetric(documentRef, details, localize(messageKey('first_content')), formatDuration(summary.firstTokenMs, localize),
        localize(messageKey(summary.firstTokenMs == null ? 'first_content_unavailable' : 'client_observed')));
    addMetric(documentRef, details, localize(messageKey('duration')), formatDuration(summary.durationMs, localize));
    addMetric(documentRef, details, localize(messageKey('end_to_end_speed')), formatTps(summary.endToEndTps, localize));
    card.append(details);

    const footer = node(documentRef, 'footer');
    const model = summary.models.join(' · ') || localize(messageKey('model_unknown'));
    const tier = summary.tiers.length ? summary.tiers.map(value => getTierLabel(localize, value)).join(' · ')
        : localize(messageKey('tier_unknown'));
    footer.append(node(documentRef, 'span', '', localize(messageKey('model_tier'), { model, tier })));
    footer.append(node(documentRef, 'span', '', localize(messageKey('request_count'), { count: summary.requestCount })));
    card.append(footer);
    return card;
}

export function createMessageCostUi({ getContext, getMessageCost, getPrices, documentRef = globalThis.document, onOpen, localize } = {}) {
    localize ??= createLocalizer((fallback, key) => getContext?.()?.translate?.(fallback, key));
    let openCard = null;
    let openButton = null;
    let destroyed = false;

    function close() {
        openCard?.remove();
        openButton?.setAttribute('aria-expanded', 'false');
        openCard = null;
        openButton = null;
    }

    function position(card, button) {
        const rect = button.getBoundingClientRect?.();
        if (!rect || !documentRef.defaultView) return;
        const view = documentRef.defaultView;
        const margin = 8;
        const width = Math.min(520, view.innerWidth - margin * 2);
        card.style.width = `${width}px`;
        card.style.left = `${Math.max(margin, Math.min(rect.left, view.innerWidth - width - margin))}px`;
        const measuredHeight = card.offsetHeight || 360;
        const below = rect.bottom + margin;
        card.style.top = `${below + measuredHeight <= view.innerHeight
            ? below : Math.max(margin, rect.top - measuredHeight - margin)}px`;
    }

    function open(button, summary) {
        close();
        const card = buildCard(documentRef, summary, close, localize);
        documentRef.body.append(card);
        openCard = card;
        openButton = button;
        button.setAttribute('aria-expanded', 'true');
        position(card, button);
        card.focus?.();
        onOpen?.(summary);
    }

    function refreshOpenCard(summary) {
        if (!openCard || !openButton) return;
        const fresh = buildCard(documentRef, summary, close, localize);
        openCard.replaceChildren(...fresh.children);
        openCard.setAttribute('aria-label', fresh.getAttribute('aria-label'));
        openButton.setAttribute('aria-expanded', 'true');
        position(openCard, openButton);
    }

    function placeButton(messageElement, button) {
        const avatar = messageElement.querySelector?.('.mesAvatarWrapper, .avatar-container, .avatar');
        const body = messageElement.querySelector?.('.mes_text, .mes_block');
        if (avatar && avatar.offsetParent !== null) avatar.append(button);
        else if (body?.parentElement) body.parentElement.insertBefore(button, body);
        else messageElement.prepend?.(button);
    }

    function attach(messageElement, message, id) {
        const snapshot = message?.is_user || message?.is_system ? null : getMessageCost?.(message);
        const existing = messageElement.querySelector?.(`.${ROOT_CLASS}-trigger`);
        if (!snapshot) {
            existing?.remove();
            return;
        }
        const summary = summarizeMessageCost(snapshot, getPrices?.() ?? {});
        const button = existing ?? node(documentRef, 'button', `${ROOT_CLASS}-trigger`);
        button.type = 'button';
        button.dataset.messageId = id;
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-expanded', openButton === button ? 'true' : 'false');
        button.setAttribute('aria-label', localize(messageKey('trigger_label'), { cost: formatMessageCostLabel(summary, localize) }));
        button.textContent = formatMessageCostLabel(summary, localize);
        button.onclick = event => {
            event.stopPropagation?.();
            if (openButton === button) close();
            else {
                // Manual/catalog price changes need no chat rerender to take effect.
                const current = summarizeMessageCost(getMessageCost?.(message), getPrices?.() ?? {});
                button.textContent = formatMessageCostLabel(current, localize);
                button.setAttribute('aria-label', localize(messageKey('trigger_label'), { cost: formatMessageCostLabel(current, localize) }));
                open(button, current);
            }
        };
        placeButton(messageElement, button);
        if (openButton === button) refreshOpenCard(summary);
        return button;
    }

    function render(messageId) {
        if (destroyed || !documentRef) return;
        const messages = getContext?.()?.chat ?? [];
        const elements = new Map([...(documentRef.querySelectorAll?.('.mes[mesid]') ?? [])]
            .map(element => [element.getAttribute?.('mesid'), element]));
        let keptOpen = false;
        for (const [id, messageElement] of elements) {
            const message = messages[Number(id)];
            if (messageId != null && String(messageId) !== id) continue;
            if (messageElement) {
                const attached = attach(messageElement, message, id);
                if (attached && attached === openButton) keptOpen = true;
            }
        }
        if (openCard && !keptOpen && (messageId == null || openButton?.dataset.messageId === String(messageId))) close();
    }

    const outside = event => {
        if (openCard && !openCard.contains(event.target) && !openButton?.contains(event.target)) close();
    };
    const keydown = event => {
        if (event.key === 'Escape' && openCard) {
            const button = openButton;
            close();
            button?.focus?.();
        }
    };
    documentRef?.addEventListener?.('pointerdown', outside);
    documentRef?.addEventListener?.('keydown', keydown);
    const reposition = () => { if (openCard && openButton) position(openCard, openButton); };
    documentRef?.defaultView?.addEventListener?.('resize', reposition);
    documentRef?.defaultView?.addEventListener?.('scroll', reposition, true);
    const context = getContext?.();
    const chatChanged = context?.eventTypes?.CHAT_CHANGED;
    if (chatChanged) context.eventSource?.on?.(chatChanged, close);
    // Theme/layout switches can hide the avatar column without rerendering any
    // messages. Move existing triggers when the host changes its body classes.
    const Observer = documentRef?.defaultView?.MutationObserver;
    const layoutObserver = Observer && documentRef.body ? new Observer(() => render()) : null;
    layoutObserver?.observe(documentRef.body, { attributes: true, attributeFilter: ['class'] });
    // Native chat virtualization can remount a message without a generation
    // event. Only react to message roots, ignoring our own button/card changes.
    const chat = documentRef?.getElementById?.('chat');
    const containsMessage = element => element?.matches?.('.mes[mesid]')
        || element?.querySelector?.('.mes[mesid]');
    let renderQueued = false;
    const messageObserver = Observer && chat ? new Observer(records => {
        if (!records.some(record => record.type === 'attributes'
            || [...record.addedNodes, ...record.removedNodes].some(containsMessage))) return;
        if (renderQueued) return;
        renderQueued = true;
        queueMicrotask(() => { renderQueued = false; render(); });
    }) : null;
    messageObserver?.observe(chat, { childList: true, subtree: true, attributes: true, attributeFilter: ['mesid'] });

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        close();
        documentRef?.removeEventListener?.('pointerdown', outside);
        documentRef?.removeEventListener?.('keydown', keydown);
        documentRef?.defaultView?.removeEventListener?.('resize', reposition);
        documentRef?.defaultView?.removeEventListener?.('scroll', reposition, true);
        if (chatChanged) context.eventSource?.removeListener?.(chatChanged, close);
        layoutObserver?.disconnect();
        messageObserver?.disconnect();
        for (const trigger of documentRef?.querySelectorAll?.(`.${ROOT_CLASS}-trigger`) ?? []) trigger.remove();
    }

    return { render, close, destroy };
}
