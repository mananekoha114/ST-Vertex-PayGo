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
    const drawerIcon = make('div', '', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down', 'aria-hidden': 'true' });
    header.append(make('b', 'vertex_paygo.bridge.title'), drawerIcon);
    const drawerContent = make('div', '', { id: 'vertex-paygo-openai-bridge-content', class: 'inline-drawer-content' });
    const content = make('div', '', { class: 'vertex-paygo-bridge-content' });
    drawerContent.append(content);
    const status = make('small', '', { class: 'vertex-paygo-status', 'aria-live': 'polite' });
    const connection = make('small', '', { class: 'vertex-paygo-guidance' });
    const enable = make('button', 'vertex_paygo.bridge.enable', { type: 'button', class: 'menu_button' });
    const disable = make('button', 'vertex_paygo.bridge.disable', { type: 'button', class: 'menu_button' });
    const refresh = make('button', 'vertex_paygo.bridge.refresh', { type: 'button', class: 'menu_button' });
    const update = make('button', 'vertex_paygo.bridge.update', { type: 'button', class: 'menu_button' });
    const rotate = make('button', 'vertex_paygo.bridge.rotate', { type: 'button', class: 'menu_button' });
    const debug = make('input', '', { id: 'vertex-paygo-bridge-debug', type: 'checkbox' });
    debug.checked = false;
    const debugLabel = make('label', '', { class: 'vertex-paygo-bridge-debug', for: debug.id });
    debugLabel.append(debug, make('span', 'vertex_paygo.bridge.debug'));
    const debugGuidance = make('small', '', { class: 'vertex-paygo-guidance' });
    const baseUrl = make('textarea', '', { id: 'vertex-paygo-bridge-url', class: 'text_pole', rows: '2', readonly: '', 'aria-label': localize('vertex_paygo.bridge.base_url'), spellcheck: 'false' });
    const copyUrl = make('button', 'vertex_paygo.bridge.copy', { type: 'button', class: 'menu_button' });
    const apiKey = make('input', '', { id: 'vertex-paygo-bridge-key', class: 'text_pole', type: 'password', readonly: '', 'aria-label': localize('vertex_paygo.bridge.api_key'), autocomplete: 'off', spellcheck: 'false' });
    const showKey = make('button', 'vertex_paygo.bridge.show', { type: 'button', class: 'menu_button' });
    const copyKey = make('button', 'vertex_paygo.bridge.copy', { type: 'button', class: 'menu_button' });
    const copyModel = make('button', 'vertex_paygo.bridge.copy_model', { type: 'button', class: 'menu_button' });
    const modelValue = make('code', '', { class: 'vertex-paygo-bridge-model' });
    modelValue.textContent = 'st-current';
    const field = (label, input, ...buttons) => {
        const row = make('div', '', { class: 'vertex-paygo-bridge-row' });
        const controls = make('div', '', { class: 'vertex-paygo-bridge-controls' });
        const actions = make('div', '', { class: 'vertex-paygo-bridge-field-actions' });
        actions.append(...buttons);
        controls.append(input, actions);
        row.append(make(input.id ? 'label' : 'span', label, input.id ? { for: input.id } : {}), controls);
        return row;
    };
    const subsection = (id, title, ...children) => {
        const details = make('details', '', { id, class: 'vertex-paygo-bridge-subsection' });
        const summary = make('summary', title);
        const body = make('div', '', { class: 'vertex-paygo-bridge-subsection-body' });
        body.append(...children);
        details.append(summary, body);
        return { details, summary, body };
    };
    const actions = make('div', '', { class: 'vertex-paygo-bridge-actions' });
    actions.append(enable, disable, refresh);
    const setup = subsection('vertex-paygo-bridge-setup', 'vertex_paygo.bridge.sections.setup',
        field('vertex_paygo.bridge.base_url', baseUrl, copyUrl),
        field('vertex_paygo.bridge.api_key', apiKey, showKey, copyKey),
        field('vertex_paygo.bridge.model', modelValue, copyModel));
    const advancedActions = make('div', '', { class: 'vertex-paygo-bridge-actions' });
    advancedActions.append(update, rotate);
    const advanced = subsection('vertex-paygo-bridge-advanced', 'vertex_paygo.bridge.sections.advanced',
        advancedActions, debugLabel, debugGuidance);
    const help = subsection('vertex-paygo-bridge-help', 'vertex_paygo.bridge.sections.help',
        make('small', 'vertex_paygo.bridge.guidance', { class: 'vertex-paygo-guidance' }),
        make('small', 'vertex_paygo.bridge.limitations', { class: 'vertex-paygo-guidance' }));
    content.append(status, connection, actions, setup.details, advanced.details);
    const logs = subsection('vertex-paygo-bridge-logs', 'vertex_paygo.bridge.logs.title');
    const logsRefresh = make('button', 'vertex_paygo.bridge.logs.refresh', { id: 'vertex-paygo-bridge-logs-refresh', type: 'button', class: 'menu_button' });
    const logsClear = make('button', 'vertex_paygo.bridge.logs.clear', { id: 'vertex-paygo-bridge-logs-clear', type: 'button', class: 'menu_button' });
    const logsActions = make('div', '', { class: 'vertex-paygo-bridge-actions' });
    const logsStatus = make('small', '', { id: 'vertex-paygo-bridge-logs-status', class: 'vertex-paygo-guidance', 'aria-live': 'polite' });
    const logsEntries = make('div', '', { id: 'vertex-paygo-bridge-logs-entries' });
    logsActions.append(logsRefresh, logsClear);
    logs.body.append(make('small', 'vertex_paygo.bridge.logs.guidance', { class: 'vertex-paygo-guidance' }), logsActions, logsStatus, logsEntries);
    content.append(logs.details, help.details);
    root.append(header, drawerContent);
    host.append(root);
    let state = null;
    let healthy = false;
    let debugSupported = false;
    let logsSupported = false;
    let logsBusy = false;
    let logsLoaded = false;
    let logsError = '';
    let entries = [];
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
        logsRefresh.disabled = busy || logsBusy || !healthy || !logsSupported;
        logsClear.disabled = busy || logsBusy || !healthy || !logsSupported;
        logsStatus.textContent = logsError || localize(!healthy || !logsSupported ? 'vertex_paygo.bridge.logs.upgrade'
            : logsBusy ? 'vertex_paygo.bridge.logs.loading' : !logsLoaded ? 'vertex_paygo.bridge.logs.not_loaded'
                : entries.length ? 'vertex_paygo.bridge.logs.loaded' : 'vertex_paygo.bridge.logs.empty');
        logsStatus.classList.toggle('vertex-paygo-status--error', Boolean(logsError));
        debug.disabled = busy || !healthy || !debugSupported;
        advanced.summary.textContent = localize(debug.checked
            ? 'vertex_paygo.bridge.sections.advanced_debug' : 'vertex_paygo.bridge.sections.advanced');
        debugGuidance.textContent = localize(debugSupported ? 'vertex_paygo.bridge.debug_guidance' : 'vertex_paygo.bridge.debug_upgrade');
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
                debugSupported = false;
                logsSupported = false;
                debug.checked = false;
                state = null;
                errorText = localize('vertex_paygo.bridge.upgrade');
                return;
            }
            healthy = true;
            logsSupported = health.capabilities?.openaiBridgeLogs === true;
            debugSupported = health.capabilities?.openaiBridgeDebug === true;
            const result = await serverClient.readOpenAiBridge();
            if (disposed) return;
            if (!validateBridgeState(result)) throw new Error(localize('vertex_paygo.bridge.invalid_response'));
            state = result;
            debug.checked = debugSupported && result.debugLocalAccess === true;
        } catch (error) {
            if (disposed) return;
            healthy = false;
            state = null;
            debug.checked = false;
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
            debug.checked = debugSupported && result.debugLocalAccess === true;
        } catch (error) {
            if (disposed) return;
            healthy = false;
            state = null;
            debug.checked = false;
            errorText = describeError(error);
        } finally { busy = false; render(); }
    }
    const rawText = value => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    function renderLogs() {
        logsEntries.replaceChildren();
        for (const entry of entries) {
            const details = make('details', '', { class: 'vertex-paygo-bridge-log-entry' });
            const summary = make('summary');
            summary.textContent = `${entry.timestamp ?? ''} · ${entry.method ?? ''} ${entry.path ?? ''} · ${entry.status ?? '—'} · ${entry.durationMs ?? '—'} ms`;
            details.append(summary);
            if (entry.truncated) details.append(make('small', 'vertex_paygo.bridge.logs.truncated', { class: 'vertex-paygo-guidance' }));
            if (entry.interrupted) details.append(make('small', 'vertex_paygo.bridge.logs.interrupted', { class: 'vertex-paygo-guidance' }));
            if (entry.requestIncomplete) details.append(make('small', 'vertex_paygo.bridge.logs.request_incomplete', { class: 'vertex-paygo-guidance' }));
            const bodies = [['request', entry.requestBody], ['forwarded', entry.forwardedBody], ['response', entry.responseBody]];
            if (entry.upstreamResponseBody != null) bodies.push(['upstream_response', entry.upstreamResponseBody]);
            bodies.push(['error', entry.error]);
            for (const [key, value] of bodies) {
                const pre = make('pre', '', { class: 'vertex-paygo-bridge-log-body', tabindex: '0' });
                pre.textContent = rawText(value) || localize('vertex_paygo.bridge.logs.no_body');
                details.append(make('b', `vertex_paygo.bridge.logs.${key}`), pre);
            }
            logsEntries.append(details);
        }
    }
    async function manageLogs(clear = false) {
        if (busy || logsBusy || disposed || !healthy || !logsSupported) return;
        logsBusy = true; logsError = ''; render();
        try {
            const result = await (clear ? serverClient.clearOpenAiBridgeLogs() : serverClient.readOpenAiBridgeLogs());
            if (disposed) return;
            if (result?.ok !== true || !Array.isArray(result.entries)
                || result.entries.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
                throw new Error(localize('vertex_paygo.bridge.invalid_response'));
            }
            entries = result.entries;
            logsLoaded = true;
            renderLogs();
        } catch (error) {
            if (!disposed) logsError = describeError(error);
        } finally { logsBusy = false; render(); }
    }
    listen(logsRefresh, 'click', () => void manageLogs());
    listen(logsClear, 'click', () => void manageLogs(true));
    const connectionPayload = connection => ({ enabled: true, connection,
        ...(debugSupported ? { debugLocalAccess: debug.checked === true } : {}) });
    listen(enable, 'click', () => { const selected = current(); if (selected.ok) void change(connectionPayload(selected.connection), { resolveSecret: true }); });
    listen(disable, 'click', () => void change({ enabled: false }));
    listen(update, 'click', () => { const selected = current(); if (selected.ok) void change(connectionPayload(selected.connection), { resolveSecret: true }); });
    listen(debug, 'change', () => {
        if (debug.disabled) { debug.checked = state?.debugLocalAccess === true; return; }
        if (state?.enabled) void change({ enabled: true, debugLocalAccess: debug.checked === true });
    });
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
    // Own this toggle so both hosts keep visual state and ARIA in sync.
    // Their delegated jQuery drawer events do not include an open/closed state.
    listen(header, 'click', event => {
        event.stopPropagation();
        const open = header.getAttribute('aria-expanded') !== 'true';
        header.setAttribute('aria-expanded', String(open));
        drawerContent.style.display = open ? 'block' : 'none';
        drawerIcon.classList.toggle('down', !open);
        drawerIcon.classList.toggle('up', open);
        drawerIcon.classList.toggle('fa-circle-chevron-down', !open);
        drawerIcon.classList.toggle('fa-circle-chevron-up', open);
    });
    listen(header, 'keydown', event => { if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); header.click();
    } });
    render();
    void read();
    return { refresh: read, render, destroy() { disposed = true; for (const dispose of disposers) dispose();
        apiKey.value = ''; state = null; entries = []; logsEntries.replaceChildren(); root.remove(); } };
}
