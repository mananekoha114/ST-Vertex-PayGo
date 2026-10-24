/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

import { AI_STUDIO_SOURCE, EXTENSION_ID, isGoogleSource, TIER } from './constants.js';
import { getTierLabel, localizeSupport } from './i18n.js';
import { getTierSupport } from './model-policy.js';

// Keep in sync with .vertex-paygo-floating in style.css.
const BALL_SIZE = 60;
const MARGIN = 8;
const EDGE_GAP = 12;
const PANEL_GAP = 10;
const PANEL_WIDTH = 248;
const DRAG_THRESHOLD = 6;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Display preferences belong to the account, independently of connection presets.
export function createFloatingTierUi({ documentRef = globalThis.document, getContext, getTarget, selectTier,
    localize, notifyError = () => {} }) {
    const view = documentRef.defaultView;
    const make = (tag, attributes = {}, text = '') => {
        const node = documentRef.createElement(tag);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
        node.textContent = text;
        return node;
    };
    const setting = make('label', { class: 'checkbox_label vertex-paygo-floating-setting' });
    const enabled = make('input', { type: 'checkbox', id: 'vertex-paygo-floating-enabled' });
    setting.append(enabled, make('span', {}, localize('vertex_paygo.floating.enabled')));
    const root = make('div', { id: 'vertex-paygo-floating', class: 'vertex-paygo-floating' });
    const ball = make('button', { type: 'button', class: 'vertex-paygo-floating-ball',
        'aria-expanded': 'false', 'aria-controls': 'vertex-paygo-floating-options' });
    const brand = make('span', { class: 'vertex-paygo-floating-brand', 'aria-hidden': 'true' }, 'PayGo');
    const mode = make('span', { class: 'vertex-paygo-floating-mode', 'aria-hidden': 'true' });
    ball.append(brand, mode);
    const panel = make('div', { id: 'vertex-paygo-floating-options', class: 'vertex-paygo-floating-options',
        role: 'group', 'aria-label': localize('vertex_paygo.floating.current') });
    panel.hidden = true;
    const header = make('div', { class: 'vertex-paygo-floating-header' });
    const model = make('span', { class: 'vertex-paygo-floating-model' });
    header.append(make('small', {}, localize('vertex_paygo.floating.current')), model);
    panel.append(header);
    // Hints are visible text, because touch screens never show title tooltips.
    const options = new Map(Object.values(TIER).map(tier => {
        const button = make('button', { type: 'button', class: 'vertex-paygo-floating-option',
            'data-tier': tier, 'aria-pressed': 'false' });
        const hint = make('small', { class: 'vertex-paygo-floating-hint' });
        button.append(make('span', { class: 'vertex-paygo-floating-name' }, getTierLabel(localize, tier)), hint);
        panel.append(button);
        return [tier, { button, hint }];
    }));
    root.append(ball, panel);
    // The real hosts always have a body; the fallback also supports host DOM adapters.
    (documentRef.body ?? documentRef.getElementById('extensions_settings2')
        ?? documentRef.getElementById('extensions_settings')).append(root);
    const disposers = [];
    const listen = (node, event, handler, options) => {
        if (!node?.addEventListener) return;
        node.addEventListener(event, handler, options);
        disposers.push(() => node.removeEventListener?.(event, handler, options));
    };
    let destroyed = false;
    let pending = false;
    let drag = null;
    let suppressClick = false;
    const preferences = () => getContext().extensionSettings?.[EXTENSION_ID]?.floatingTier ?? {};
    const choices = () => [...options.values()].map(({ button }) => button)
        .filter(button => !button.hidden && !button.disabled);
    function save(patch) {
        const context = getContext();
        context.extensionSettings ??= {};
        context.extensionSettings[EXTENSION_ID] ??= {};
        context.extensionSettings[EXTENSION_ID].floatingTier = { ...preferences(), ...patch };
        void Promise.resolve(context.saveSettingsDebounced()).catch(error => notifyError(error.message));
    }
    function close({ focus = false } = {}) {
        panel.hidden = true;
        ball.setAttribute('aria-expanded', 'false');
        if (focus) ball.focus?.();
    }
    // Places the ball at viewport pixels and opens the menu toward the roomier side.
    function layout(left, top) {
        if (!root.style || !view) return null;
        const width = view.innerWidth || 1;
        const height = view.innerHeight || 1;
        const x = clamp(left, MARGIN, width - BALL_SIZE - MARGIN);
        const y = clamp(top, MARGIN, height - BALL_SIZE - MARGIN);
        const side = x + BALL_SIZE / 2 < width / 2 ? 'left' : 'right';
        const above = y + BALL_SIZE / 2 > height / 2;
        root.style.left = `${x}px`;
        root.style.top = `${y}px`;
        root.dataset.side = side;
        root.dataset.placement = above ? 'above' : 'below';
        const panelWidth = Math.min(PANEL_WIDTH, Math.max(0, width - 2 * MARGIN));
        const anchor = side === 'left' ? x : x + BALL_SIZE - panelWidth;
        panel.style.width = `${panelWidth}px`;
        panel.style.left = `${clamp(anchor, MARGIN, width - panelWidth - MARGIN) - x}px`;
        panel.style.maxHeight = `${Math.max(0, (above ? y : height - y - BALL_SIZE) - PANEL_GAP - MARGIN)}px`;
        return { y, side, height };
    }
    // The ball rests against a side edge so it never parks over the chat text.
    function restore() {
        const point = preferences().position;
        const width = view?.innerWidth || 1;
        const height = view?.innerHeight || 1;
        const y = Number.isFinite(point?.y) ? point.y * height : height * 0.6;
        return layout(point?.side === 'left' ? EDGE_GAP : width - BALL_SIZE - EDGE_GAP, y);
    }
    function render() {
        if (destroyed) return;
        enabled.checked = preferences().enabled === true;
        let target;
        try { target = getTarget(); } catch { /* Malformed native parameters cannot be switched here. */ }
        const current = target?.tier ?? TIER.STANDARD;
        root.hidden = !enabled.checked || !isGoogleSource(target?.source);
        ball.disabled = pending || target?.busy === true;
        ball.setAttribute('aria-busy', String(ball.disabled));
        ball.dataset.tier = current;
        mode.textContent = getTierLabel(localize, current);
        ball.setAttribute('aria-label', localize('vertex_paygo.floating.toggle', {
            tier: getTierLabel(localize, current),
        }));
        ball.title = localize('vertex_paygo.floating.guidance');
        model.textContent = target?.model ?? '';
        model.title = target?.model ?? '';
        model.hidden = !target?.model;
        for (const [tier, { button, hint }] of options) {
            const support = getTierSupport(target?.model, tier, target?.source);
            const blocked = tier !== TIER.STANDARD && !support.allowed;
            const caution = tier !== TIER.STANDARD && support.level === 'unverified';
            const reason = tier === TIER.STANDARD ? '' : localizeSupport(localize, support, tier);
            button.hidden = target?.source === AI_STUDIO_SOURCE && tier === TIER.PRIORITY;
            button.disabled = ball.disabled || blocked;
            button.title = reason;
            button.dataset.support = blocked ? 'blocked' : caution ? 'caution' : 'ok';
            button.setAttribute('aria-pressed', String(tier === current));
            hint.textContent = blocked || caution ? reason : localize(`vertex_paygo.floating.hint.${tier}`);
        }
        if (root.hidden || ball.disabled) close();
        if (!drag) restore();
    }
    listen(enabled, 'change', () => { save({ enabled: enabled.checked }); render(); });
    listen(ball, 'click', () => {
        if (suppressClick) { suppressClick = false; return; }
        render();
        if (root.hidden || ball.disabled) return;
        panel.hidden = !panel.hidden;
        ball.setAttribute('aria-expanded', String(!panel.hidden));
        if (!panel.hidden) {
            const current = options.get(getTarget()?.tier)?.button;
            (choices().includes(current) ? current : choices()[0])?.focus?.();
        }
    });
    for (const [tier, { button }] of options) listen(button, 'click', async () => {
        render();
        if (root.hidden || button.hidden || button.disabled) return;
        close({ focus: true });
        pending = true;
        render();
        try { await selectTier(tier); }
        catch (error) { notifyError(error.message); }
        finally { pending = false; render(); }
    });
    listen(documentRef, 'pointerdown', event => { if (!root.contains(event.target)) close(); });
    listen(root, 'keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); close({ focus: true }); return; }
        if (panel.hidden || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const list = choices();
        if (list.length === 0) return;
        event.preventDefault();
        const index = list.indexOf(documentRef.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1
            : event.key === 'ArrowDown' ? (index + 1) % list.length
                : (index <= 0 ? list.length : index) - 1;
        list[next].focus?.();
    });
    listen(ball, 'pointerdown', event => {
        if (event.button !== 0 || ball.disabled) return;
        suppressClick = false;
        const rect = root.getBoundingClientRect();
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
        ball.setPointerCapture?.(event.pointerId);
    });
    listen(ball, 'pointermove', event => {
        if (!drag || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        if (!drag.moved) root.classList.add('vertex-paygo-floating--dragging');
        drag.moved = true;
        close();
        layout(drag.left + dx, drag.top + dy);
    });
    const endDrag = event => {
        if (!drag || drag.id !== event.pointerId) return;
        const moved = drag.moved;
        drag = null;
        root.classList.remove('vertex-paygo-floating--dragging');
        if (!moved) return;
        suppressClick = true;
        const placed = layout(parseFloat(root.style.left), parseFloat(root.style.top));
        if (placed) save({ position: { side: placed.side, y: placed.y / placed.height } });
        restore();
    };
    listen(ball, 'pointerup', endDrag);
    listen(ball, 'pointercancel', endDrag);
    listen(ball, 'lostpointercapture', endDrag);
    listen(view, 'resize', () => {
        drag = null;
        root.classList.remove('vertex-paygo-floating--dragging');
        close();
        restore();
    });
    // Both hosts may restore account settings after this component mounts.
    const context = getContext();
    const settingsEvent = context.eventTypes?.SETTINGS_LOADED;
    if (settingsEvent) {
        context.eventSource?.on(settingsEvent, render);
        disposers.push(() => context.eventSource?.removeListener?.(settingsEvent, render));
    }
    return { setting, render, destroy() {
        destroyed = true;
        for (const dispose of disposers) dispose();
        setting.remove();
        root.remove();
    } };
}
