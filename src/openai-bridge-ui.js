/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

import { currentBridgeConnection, validateBridgeState } from './openai-bridge-model.js';

export function createOpenAiBridgeUi({ context, serverClient, localize, documentRef = globalThis.document,
    clipboard = globalThis.navigator?.clipboard } = {}) {
    const host = documentRef.getElementById('extensions_settings2')
        ?? documentRef.getElementById('extensions_settings');
    if (!host) return null;
    const make = (tag, key, attributes = {}) => {
        const node = documentRef.createElement(tag);
        if (key) node.textContent = localize(key);
        for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
        return node;
    };
    const root = make('section', '', { id: 'vertex-paygo-openai-bridge', class: 'inline-drawer' });
    const header = make('div', '', { class: 'inline-drawer-toggle inline-drawer-header', role: 'button',
        tabindex: '0', 'aria-expanded': 'false', 'aria-controls': 'vertex-paygo-openai-bridge-content' });
    header.append(make('b', 'vertex_paygo.bridge.title'),
        make('div', '', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down', 'aria-hidden': 'true' }));
    const content = make('div', '', { id: 'vertex-paygo-openai-bridge-content', class: 'inline-drawer-content vertex-paygo-bridge-content' });
    const status = make('small', '', { class: 'vertex-paygo-status', 'aria-live': 'polite' });
    const connection = make('small', '', { class: 'vertex-paygo-guidance' });
    const enable = make('button', 'vertex_paygo.bridge.enable', { type: 'button', class: 'menu_button' });
    const disable = make('button', 'vertex_paygo.bridge.disable', { type: 'button', class: 'menu_button' });
    const refresh = make('button', 'vertex_paygo.bridge.refresh', { type: 'button', class: 'menu_button' });
    const update = make('button', 'vertex_paygo.bridge.update', { type: 'button', class: 'menu_button' });
    const rotate = make('button', 'vertex_paygo.bridge.rotate', { type: 'button', class: 'menu_button' });
    const baseUrl = make('input', '', { type: 'text', readonly: '', 'aria-label': localize('vertex_paygo.bridge.base_url') });
    const copyUrl = make('button', 'vertex_paygo.bridge.copy', { type: 'button', class: 'menu_button' });
    const apiKey = make('input', '', { type: 'password', readonly: '', 'aria-label': localize('vertex_paygo.bridge.api_key') });
    const showKey = make('button', 'vertex_paygo.bridge.show', { type: 'button', class: 'menu_button' });
    const copyKey = make('button', 'vertex_paygo.bridge.copy', { type: 'button', class: 'menu_button' });
    const copyModel = make('button', 'vertex_paygo.bridge.copy_model', { type: 'button', class: 'menu_button' });
    const modelValue = make('code', '', { class: 'vertex-paygo-bridge-model' });
    modelValue.textContent = 'st-current';
    const field = (label, input, ...buttons) => {
        const row = make('div', '', { class: 'vertex-paygo-bridge-row' });
        row.append(make('label', label), input, ...buttons);
        return row;
    };
    const actions = make('div', '', { class: 'vertex-paygo-bridge-actions' });
    actions.append(enable, disable, refresh, update, rotate);
    content.append(status, actions, connection, make('small', 'vertex_paygo.bridge.guidance', { class: 'vertex-paygo-guidance' }),
        field('vertex_paygo.bridge.base_url', baseUrl, copyUrl),
        field('vertex_paygo.bridge.api_key', apiKey, showKey, copyKey),
        field('vertex_paygo.bridge.model', modelValue, copyModel),
        make('small', 'vertex_paygo.bridge.limitations', { class: 'vertex-paygo-guidance' }));
    root.append(header, content);
    host.append(root);
    let state = null;
    let healthy = false;
    let busy = false;
    let disposed = false;
    let errorText = '';
    const disposers = [];
    const listen = (node, event, handler) => {
        node.addEventListener(event, handler);
        disposers.push(() => node.removeEventListener(event, handler));
    };
    const issueText = code => localize(`vertex_paygo.bridge.validation.${code}`);
    const describeError = error => error?.code === 'ACTIVE_GOOGLE_SECRET_UNAVAILABLE'
        ? localize('vertex_paygo.bridge.active_secret_unavailable')
        : error instanceof Error ? error.message : String(error);
    const current = () => currentBridgeConnection(context, documentRef);
    function render() {
        if (disposed) return;
        const selected = current();
        const enabled = state?.enabled === true;
        status.textContent = errorText || localize(healthy
            ? (enabled ? 'vertex_paygo.bridge.status_on' : 'vertex_paygo.bridge.status_off')
            : 'vertex_paygo.bridge.status_unavailable');
        status.classList.toggle('vertex-paygo-status--error', Boolean(errorText) || !healthy);
        const saved = state?.connection;
        connection.textContent = enabled && saved
            ? localize('vertex_paygo.bridge.connection', { source: saved.source, model: saved.model,
                region: saved.region ?? '—' })
            : selected.ok
                ? localize('vertex_paygo.bridge.current', { source: selected.connection.source,
                    model: selected.connection.model })
                : issueText(selected.code);
        enable.disabled = busy || !healthy || enabled || !selected.ok;
        disable.disabled = busy || !healthy || !enabled;
        update.disabled = busy || !healthy || !enabled || !selected.ok;
        rotate.disabled = busy || !healthy || !enabled;
        refresh.disabled = busy;
        baseUrl.value = enabled ? state.baseUrl : '';
        apiKey.value = enabled ? state.apiKey : '';
        if (!enabled) { apiKey.type = 'password'; showKey.textContent = localize('vertex_paygo.bridge.show'); }
        copyUrl.disabled = !enabled || busy;
        copyKey.disabled = !enabled || busy;
        showKey.disabled = !enabled || busy;
        copyModel.disabled = !enabled || busy;
    }
    async function read() {
        if (busy || disposed) return;
        busy = true; errorText = ''; render();
        try {
            const health = await serverClient.checkHealth();
            if (health.capabilities?.openaiBridge !== true) {
                healthy = false;
                state = null;
                errorText = localize('vertex_paygo.bridge.upgrade');
                return;
            }
            healthy = true;
            const result = await serverClient.readOpenAiBridge();
            if (disposed) return;
            if (!validateBridgeState(result)) throw new Error(localize('vertex_paygo.bridge.invalid_response'));
            state = result;
        } catch (error) {
            if (disposed) return;
            healthy = false;
            state = null;
            errorText = describeError(error);
        } finally { busy = false; render(); }
    }
    async function change(payload, { resolveSecret = false } = {}) {
        if (busy || !healthy || disposed) return;
        busy = true; errorText = ''; render();
        try {
            if (resolveSecret) {
                const secretId = await serverClient.readActiveGoogleSecretId(payload.connection.source);
                if (disposed) return;
                payload = { ...payload, connection: { ...payload.connection, ...(secretId ? { secretId } : {}) } };
            }
            const result = await serverClient.updateOpenAiBridge(payload);
            if (disposed) return;
            if (!validateBridgeState(result)) throw new Error(localize('vertex_paygo.bridge.invalid_response'));
            state = result;
        } catch (error) {
            if (disposed) return;
            healthy = false;
            state = null;
            errorText = describeError(error);
        } finally { busy = false; render(); }
    }
    listen(enable, 'click', () => { const selected = current(); if (selected.ok) void change({ enabled: true, connection: selected.connection }, { resolveSecret: true }); });
    listen(disable, 'click', () => void change({ enabled: false }));
    listen(update, 'click', () => { const selected = current(); if (selected.ok) void change({ enabled: true, connection: selected.connection }, { resolveSecret: true }); });
    listen(rotate, 'click', () => void change({ enabled: true, rotateKey: true }));
    listen(refresh, 'click', () => void read());
    listen(showKey, 'click', () => { apiKey.type = apiKey.type === 'password' ? 'text' : 'password';
        showKey.textContent = localize(apiKey.type === 'password' ? 'vertex_paygo.bridge.show' : 'vertex_paygo.bridge.hide'); });
    const copy = async (value, input) => { try {
        if (typeof clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable');
        await clipboard.writeText(value);
    } catch { errorText = localize('vertex_paygo.bridge.copy_failed'); render(); input?.select?.(); } };
    listen(copyUrl, 'click', () => { if (state?.enabled) void copy(state.baseUrl, baseUrl); });
    listen(copyKey, 'click', () => { if (state?.enabled) void copy(state.apiKey, apiKey); });
    listen(copyModel, 'click', () => void copy('st-current'));
    listen(documentRef, 'change', render);
    listen(documentRef, 'input', render);
    listen(header, 'keydown', event => { if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); header.click();
    } });
    listen(root, 'inline-drawer-toggle', event => { if (event.target === root && typeof event.detail?.open === 'boolean')
        header.setAttribute('aria-expanded', String(event.detail.open)); });
    render();
    void read();
    return { refresh: read, render, destroy() { disposed = true; for (const dispose of disposers) dispose();
        apiKey.value = ''; state = null; root.remove(); } };
}
