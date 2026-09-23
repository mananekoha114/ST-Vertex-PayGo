/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

import { createCostContext } from './cost-context.js';
import { createCostUi } from './cost-ui.js';
import { createLocalizer } from './i18n.js';
import { MODEL_POLICY_REFRESH_INTERVAL_MS, refreshModelPolicyFromGitHub, restoreCachedModelPolicy } from './model-policy-updater.js';
import { createTauriConnections } from './tauri-connections.js';
import { installTauriTransport } from './tauri-transport.js';
import { createTauriUi } from './tauri-ui.js';
import { createTauriUsageClient } from './tauri-usage.js';

export function assertTauriCapabilities(context, platform) {
    const store = platform?.api?.extension?.store;
    if (!context?.chatCompletionSettings?.additional_parameters_by_source
        || typeof context.saveSettingsDebounced !== 'function'
        || typeof context.eventSource?.on !== 'function' || !context.eventTypes?.CHAT_COMPLETION_SETTINGS_READY
        || typeof context.Popup?.show?.confirm !== 'function' || context.POPUP_RESULT?.AFFIRMATIVE === undefined
        || typeof platform?.api?.llmConnections?.save !== 'function'
        || !['setJson', 'listKeys'].every(key => typeof store?.[key] === 'function')
        || (typeof store?.tryGetJson !== 'function' && typeof store?.getJson !== 'function')) {
        const error = new Error('TauriTavern native parameter and extension storage APIs are required (tested with 2.3.0).');
        error.code = 'TAURI_CAPABILITIES_UNAVAILABLE';
        throw error;
    }
    return store;
}

async function waitForControls(documentRef) {
    const available = () => documentRef.getElementById('extensionsMenu')
        && (documentRef.getElementById('extensions_settings2') || documentRef.getElementById('extensions_settings'));
    if (available()) return;
    await new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => { if (available()) finish(); });
        const timer = setTimeout(() => finish(new Error('TauriTavern extension controls are unavailable.')), 10_000);
        function finish(error) { clearTimeout(timer); observer.disconnect(); error ? reject(error) : resolve(); }
        observer.observe(documentRef.documentElement, { childList: true, subtree: true });
    });
}

export async function initTauriTavern({ target = globalThis, documentRef = target.document,
    getContext = () => target.SillyTavern?.getContext?.(),
    loadLibrary = () => import('/lib.js'), notifyError = () => {}, notifyWarning = () => {},
    factories = {},
} = {}) {
    await (target.__TAURITAVERN__?.ready ?? target.__TAURITAVERN_MAIN_READY__);
    let context;
    try { context = getContext(); }
    catch (cause) {
        const error = new Error('TauriTavern extension context is unavailable.', { cause });
        error.code = 'TAURI_CAPABILITIES_UNAVAILABLE';
        throw error;
    }
    const localize = createLocalizer((fallback, key) => context?.translate?.(fallback, key));
    const store = assertTauriCapabilities(context, target.__TAURITAVERN__);
    const { yaml } = await loadLibrary();
    if (typeof yaml?.parse !== 'function' || typeof yaml?.stringify !== 'function') {
        throw new Error(localize('vertex_paygo.tauri.yaml_missing'));
    }
    await waitForControls(documentRef);
    let controller;
    let costs;
    let costUi;
    let usage;
    let transport;
    let timer;
    let destroyed = false;
    const eventName = context.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
    const destroy = () => {
        destroyed = true;
        if (timer !== undefined) target.clearInterval(timer);
        if (transport) context.eventSource.removeListener?.(eventName, transport);
        transport?.destroy?.();
        controller?.destroy?.();
        costUi?.destroy?.();
        costs?.destroy?.();
        usage?.destroy?.();
    };
    async function refreshCatalog() {
        const result = await (factories.refreshPolicy ?? refreshModelPolicyFromGitHub)();
        if (!destroyed && result.changed) controller?.onModelPolicyChanged();
        return result;
    }
    try {
        restoreCachedModelPolicy();
        const connections = (factories.connections ?? createTauriConnections)({ getContext, api: target.__TAURITAVERN__.api, yaml });
        controller = (factories.ui ?? createTauriUi)({ getContext, connections, yaml, documentRef, localize, notifyError, notifyWarning });
        costs = (factories.costContext ?? createCostContext)({ getContext });
        usage = (factories.usage ?? createTauriUsageClient)({ store,
            notifyWarning: () => notifyWarning(localize('vertex_paygo.costs.recording_unavailable')) });
        costUi = (factories.costUi ?? createCostUi)({ context, serverClient: usage, documentRef,
            getChatId: costs.getChatId, getPrices: costs.getPrices, getPriceInfo: costs.getPriceInfo,
            setPrice: costs.setPrice, resetPrice: costs.resetPrice, refreshCatalog,
            getCurrentPricingKey: controller.getPricingKey,
            coverageNotice: localize('vertex_paygo.tauri.cost_coverage'),
        });
        transport = (factories.transport ?? installTauriTransport)({ context, target, yaml,
            stateProvider: controller.getState, usageClient: usage,
            captureUsageContext: costs.captureUsageContext, getUsagePrice: costs.getUsagePrice,
            notifyError, notifyWarning, localize,
        });
        if (typeof context.eventSource.makeLast === 'function') context.eventSource.makeLast(eventName, transport);
        else context.eventSource.on(eventName, transport);
        void refreshCatalog().catch(error => console.warn('[Vertex PayGo] Model policy refresh failed.', error));
        timer = target.setInterval(() => void refreshCatalog().catch(error =>
            console.warn('[Vertex PayGo] Model policy refresh failed.', error)), MODEL_POLICY_REFRESH_INTERVAL_MS);
        return { ...controller, destroy, usageClient: usage, mode: 'tauri' };
    } catch (error) { destroy(); throw error; }
}
