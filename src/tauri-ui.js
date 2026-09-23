/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

import { AI_STUDIO_SOURCE, DEFAULT_STATE, isGoogleSource, TIER, VERTEX_SOURCE } from './constants.js';
import { createLocalizer, localizeSupport, localizeValidation } from './i18n.js';
import { getModelPolicy, getTierSupport } from './model-policy.js';
import { validatePluginState } from './state-machine.js';
import { applyTauriParameters, readTauriState } from './tauri-parameters.js';

const CURRENT = '__current__';

export function currentTauriRequest(context) {
    const settings = context.chatCompletionSettings;
    const source = settings.chat_completion_source;
    const entry = settings.additional_parameters_by_source?.[source] ?? {};
    return {
        chat_completion_source: source,
        model: source === VERTEX_SOURCE ? settings.vertexai_model
            : source === AI_STUDIO_SOURCE ? settings.google_model : '',
        vertexai_region: settings.vertexai_region,
        custom_include_body: entry.include_body ?? '',
        custom_exclude_body: entry.exclude_body ?? '',
        custom_include_headers: entry.include_headers ?? '',
    };
}

// The native settings are the source of truth: presets and manual Additional
// Parameters edits therefore cannot diverge from a second extension-only tier.
export function createTauriUi({ getContext, connections, yaml, documentRef = globalThis.document,
    localize = createLocalizer(), notifyError = () => {}, notifyWarning = () => {} }) {
    const container = documentRef.getElementById('extensions_settings2')
        ?? documentRef.getElementById('extensions_settings');
    if (!container) throw new Error(localize('vertex_paygo.tauri.controls_missing'));
    function element(tag, text, attributes = {}) {
        const node = documentRef.createElement(tag);
        if (text) node.textContent = text;
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
        return node;
    }
    const root = element('section', '', { id: 'vertex-paygo-settings', class: 'vertex-paygo-settings' });
    root.append(element('h4', localize('vertex_paygo.tauri.title')));
    root.append(element('small', localize('vertex_paygo.tauri.native'), { class: 'vertex-paygo-guidance' }));
    const scope = element('select', '', { id: 'vertex-paygo-scope', class: 'text_pole' });
    const scopeLabel = element('label', localize('vertex_paygo.tauri.scope'), { for: 'vertex-paygo-scope' });
    const refresh = element('button', localize('vertex_paygo.tauri.refresh'), { type: 'button', class: 'menu_button' });
    const modelLabel = element('small', '', { class: 'vertex-paygo-guidance' });
    const tier = element('select', '', { id: 'vertex-paygo-tier', class: 'text_pole' });
    for (const value of Object.values(TIER)) tier.append(element('option', localize(`vertex_paygo.tier.${value}`), { value }));
    const tierLabel = element('label', localize('vertex_paygo.service_tier'), { for: 'vertex-paygo-tier' });
    const paygoLabel = element('label', '', { class: 'checkbox_label vertex-paygo-only' });
    const paygo = element('input', '', { type: 'checkbox', id: 'vertex-paygo-only' });
    paygoLabel.append(paygo, element('span', localize('vertex_paygo.paygo_only')));
    const status = element('small', '', { class: 'vertex-paygo-status', 'aria-live': 'polite' });
    root.append(scopeLabel, scope, refresh, modelLabel, tierLabel, tier, paygoLabel, status,
        element('small', localize('vertex_paygo.tauri.persistence'), { class: 'vertex-paygo-guidance' }),
        element('small', localize('vertex_paygo.tauri.cost_notice'), { class: 'vertex-paygo-guidance' }));
    container.append(root);
    let busy = false;
    let destroyed = false;
    const disposers = [];
    const listen = (node, event, handler) => {
        node.addEventListener(event, handler);
        disposers.push(() => node.removeEventListener(event, handler));
    };
    function selected() {
        if (scope.value && scope.value !== CURRENT) return connections.read(scope.value);
        const data = currentTauriRequest(getContext());
        return { id: CURRENT, source: data.chat_completion_source, model: data.model,
            region: data.vertexai_region, state: readTauriState(data, { yaml }), data };
    }
    function currentState(data) {
        return readTauriState(data ?? currentTauriRequest(getContext()), { yaml });
    }
    function render() {
        if (destroyed) return;
        try {
            const item = selected();
            if (!item) throw new Error(localize('vertex_paygo.tauri.target_missing'));
            if (item.error) throw new Error(item.error);
            const google = isGoogleSource(item.source);
            const aiStudio = item.source === AI_STUDIO_SOURCE;
            const policy = getModelPolicy(item.model, item.source);
            tier.value = item.state?.tier ?? DEFAULT_STATE.tier;
            paygo.checked = item.state?.paygoOnly === true;
            paygoLabel.hidden = aiStudio || !google;
            scope.disabled = busy;
            refresh.disabled = busy;
            tier.disabled = busy || !google;
            paygo.disabled = busy || !google || (!policy.isGemini && !paygo.checked);
            modelLabel.textContent = google
                ? `${aiStudio ? 'Google AI Studio' : 'Vertex AI'} · ${item.model || '—'}${aiStudio ? '' : ` · ${item.region || 'us-central1'}`}`
                : localize('vertex_paygo.tauri.select_google');
            for (const option of tier.children) {
                const value = option.value;
                option.hidden = aiStudio && value === TIER.PRIORITY;
                option.disabled = value !== TIER.STANDARD && !getTierSupport(item.model, value, item.source).allowed;
            }
            const validation = validatePluginState({ ...item, state: item.state ?? DEFAULT_STATE });
            status.classList.toggle('vertex-paygo-status--error', google && !validation.ok);
            status.textContent = !google ? '' : !validation.ok
                ? localizeValidation(localize, validation, item.state)
                : localize('vertex_paygo.tauri.applied', { tier: item.state.tier });
        } catch (error) {
            tier.disabled = paygo.disabled = true;
            scope.disabled = refresh.disabled = busy;
            status.textContent = error.message;
            status.classList.add('vertex-paygo-status--error');
        }
    }
    function reload() {
        const previous = scope.value || CURRENT;
        try {
            scope.replaceChildren(element('option', localize('vertex_paygo.tauri.current'), { value: CURRENT }),
                ...connections.list().map(item => element('option', `Agent · ${item.name}`, { value: item.id })));
            scope.value = [...scope.children].some(option => option.value === previous) ? previous : CURRENT;
            render();
        } catch (error) { notifyError(error.message); }
    }
    function signature(item) {
        return JSON.stringify([item.id, item.source, item.model, item.region, item.state, item.data]);
    }
    async function change() {
        if (busy || destroyed) return;
        const requested = { tier: tier.value, paygoOnly: paygo.checked };
        const context = getContext();
        const beforeSettings = context.chatCompletionSettings;
        busy = true;
        scope.disabled = tier.disabled = paygo.disabled = refresh.disabled = true;
        try {
            const item = selected();
            if (!item || !isGoogleSource(item.source)) throw new Error(localize('vertex_paygo.tauri.select_google'));
            if (item.source === AI_STUDIO_SOURCE) requested.paygoOnly = false;
            const before = signature(item);
            let region = item.region;
            if (item.source === VERTEX_SOURCE && requested.tier !== TIER.STANDARD && region !== 'global') {
                const result = await context.Popup.show.confirm(
                    localize('vertex_paygo.popup.tier_region.title', { tier: requested.tier }),
                    localize('vertex_paygo.popup.tier_region.body', { region: region || 'us-central1' }),
                    { okButton: localize('vertex_paygo.popup.tier_region.accept', { tier: requested.tier }),
                        cancelButton: localize('vertex_paygo.tauri.cancel'), defaultResult: context.POPUP_RESULT.NEGATIVE });
                if (result !== context.POPUP_RESULT.AFFIRMATIVE) return;
                region = 'global';
            }
            const liveContext = getContext();
            const afterItem = selected();
            if (destroyed || liveContext.chatCompletionSettings !== beforeSettings || !afterItem || signature(afterItem) !== before) {
                throw new Error(localize('vertex_paygo.tauri.settings_changed'));
            }
            const validation = validatePluginState({ source: item.source, model: item.model, region, state: requested });
            if (!validation.ok) throw new Error(localizeValidation(localize, validation, requested));
            if (item.id !== CURRENT) {
                await connections.save(item.id, requested, { syncGlobal: region === 'global' });
            } else {
                const data = applyTauriParameters({ ...item.data, vertexai_region: region }, requested, { yaml });
                const settings = liveContext.chatCompletionSettings;
                const store = settings.additional_parameters_by_source;
                const previousEntry = store[item.source];
                const previousRegion = settings.vertexai_region;
                const savedEntry = { ...previousEntry, include_body: data.custom_include_body,
                    exclude_body: data.custom_exclude_body, include_headers: data.custom_include_headers };
                store[item.source] = savedEntry;
                if (item.source === VERTEX_SOURCE) settings.vertexai_region = region;
                try { await liveContext.saveSettingsDebounced(); }
                catch (error) {
                    if (store[item.source] === savedEntry) {
                        if (previousEntry === undefined) delete store[item.source];
                        else store[item.source] = previousEntry;
                    }
                    if (settings.vertexai_region === region) settings.vertexai_region = previousRegion;
                    throw error;
                }
                if (getContext().chatCompletionSettings !== settings || store[item.source] !== savedEntry) {
                    throw new Error(localize('vertex_paygo.tauri.settings_changed'));
                }
                const regionInput = documentRef.getElementById('vertexai_region');
                if (regionInput && item.source === VERTEX_SOURCE) regionInput.value = region;
            }
            if (validation.support?.level === 'unverified') {
                notifyWarning(localizeSupport(localize, validation.support, requested.tier));
            }
        } catch (error) { notifyError(error.message); }
        finally { busy = false; reload(); }
    }
    listen(scope, 'change', render);
    listen(tier, 'change', change);
    listen(paygo, 'change', change);
    listen(refresh, 'click', reload);
    const changed = event => { if (!root.contains(event.target) && !busy) reload(); };
    listen(documentRef, 'change', changed);
    listen(documentRef, 'input', changed);
    const context = getContext();
    for (const key of ['SETTINGS_LOADED', 'OAI_PRESET_CHANGED_AFTER', 'CONNECTION_PROFILE_LOADED',
        'MODEL_TARGET_LOADED', 'MODEL_TARGET_CREATED', 'MODEL_TARGET_UPDATED', 'MODEL_TARGET_DELETED']) {
        const event = context.eventTypes?.[key];
        if (!event) continue;
        context.eventSource?.on(event, reload);
        disposers.push(() => context.eventSource?.removeListener?.(event, reload));
    }
    reload();
    return {
        getState: currentState,
        getPricingKey() {
            const item = selected();
            return { source: item?.source, model: item?.model, tier: item?.state?.tier ?? 'standard' };
        },
        onModelPolicyChanged: reload,
        destroy() { destroyed = true; for (const dispose of disposers) dispose(); root.remove(); },
    };
}
