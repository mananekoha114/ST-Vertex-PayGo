/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createClientLogger, getSafeErrorContext } from './src/client-logger.js';
import { CLIENT_VERSION, PROTOCOL_VERSION } from './src/constants.js';
import { createLocalizer } from './src/i18n.js';
import {
    MODEL_POLICY_REFRESH_INTERVAL_MS,
    refreshModelPolicyFromGitHub,
    restoreCachedModelPolicy,
} from './src/model-policy-updater.js';
import { installRequestTransport } from './src/request-transport.js';
import { createServerClient } from './src/server-client.js';
import { createPayGoUi } from './src/ui.js';
import { createCostContext } from './src/cost-context.js';
import { createCostUi } from './src/cost-ui.js';
import { isTauriTavern, showTauriTavernNotice } from './src/tauritavern.js';

let initialized = false;
let controller = null;
let modelPolicyRefreshTimer = null;
let clientLogger = null;
let costUi = null;
let costContext = null;

function notify(kind, message) {
    const toaster = globalThis.toastr?.[kind];
    if (typeof toaster === 'function') {
        toaster.call(globalThis.toastr, message, 'Vertex AI PayGo', { preventDuplicates: true, timeOut: 10_000 });
    } else {
        console[kind === 'error' ? 'error' : 'warn'](`[Vertex PayGo] ${message}`);
    }
}

async function waitForVertexControls(timeoutMs = 10_000, localize = createLocalizer()) {
    if (document.getElementById('vertexai_region') && document.getElementById('model_vertexai_select')) {
        return;
    }

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            observer.disconnect();
            reject(new Error(localize('vertex_paygo.error.controls_timeout')));
        }, timeoutMs);
        const observer = new MutationObserver(() => {
            if (document.getElementById('vertexai_region') && document.getElementById('model_vertexai_select')) {
                clearTimeout(timeout);
                observer.disconnect();
                resolve();
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    });
}

export async function init() {
    if (initialized) return;
    initialized = true;

    try {
        const unsupportedHost = isTauriTavern();
        let context;
        try {
            context = globalThis.SillyTavern?.getContext?.();
        } catch (error) {
            if (!unsupportedHost) throw error;
            // Detection and the native notice do not depend on the compatibility API.
            console.warn('[Vertex PayGo] TauriTavern extension context is not ready.', error);
        }
        const localize = createLocalizer(
            typeof context?.translate === 'function'
                ? (fallback, key) => context.translate(fallback, key)
                : undefined,
        );
        if (unsupportedHost) {
            // Do not hold up host startup while the user reads the notice. Keep the
            // initialization guard set so both activation paths show it only once.
            void showTauriTavernNotice({ context, localize }).catch(error => {
                console.error('[Vertex PayGo] Could not display the TauriTavern notice.', error);
                notify('error', localize('vertex_paygo.tauritavern.unavailable'));
            });
            return;
        }
        if (!context) {
            throw new Error(localize('vertex_paygo.error.context_unavailable'));
        }
        const serverClient = createServerClient({
            fetchImpl: globalThis.fetch.bind(globalThis),
            getRequestHeaders: context.getRequestHeaders,
        });
        clientLogger = createClientLogger({
            sendEntry: entry => serverClient.writeClientLog(entry),
            clientVersion: CLIENT_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            deliveryEnabled: false,
        });
        clientLogger.event('info', 'extension.init_started', { phase: 'started' });

        const restoredPolicy = restoreCachedModelPolicy({ logger: clientLogger });
        clientLogger.event('info', 'policy.restore_completed', {
            phase: restoredPolicy.applied
                ? (restoredPolicy.changed ? 'cache_changed' : 'cache_unchanged')
                : 'bundled',
            ...getSafeErrorContext(restoredPolicy.error),
        });
        await waitForVertexControls(10_000, localize);

        controller = createPayGoUi({
            context,
            serverClient,
            notifyError: message => notify('error', message),
            notifyWarning: message => notify('warning', message),
            logger: clientLogger,
            localize,
        });

        costContext = createCostContext({ getContext: () => globalThis.SillyTavern.getContext() });
        costUi = createCostUi({
            context,
            serverClient,
            getChatId: costContext.getChatId,
            getPrices: costContext.getPrices,
            getPriceInfo: costContext.getPriceInfo,
            setPrice: costContext.setPrice,
            resetPrice: costContext.resetPrice,
            refreshCatalog: () => refreshModelPolicy(),
            getCurrentPricingKey: () => {
                const current = globalThis.SillyTavern.getContext();
                return {
                    source: current.chatCompletionSettings?.chat_completion_source,
                    model: current.getChatCompletionModel?.(),
                    tier: controller.getState().tier,
                };
            },
        });

        const requestHook = installRequestTransport({
            context,
            stateProvider: controller.getState,
            serverClient,
            origin: globalThis.location.origin,
            notifyError: message => notify('error', message),
            notifyWarning: message => notify('warning', message),
            logger: clientLogger,
            localize,
            captureUsageContext: costContext.captureUsageContext,
            getUsagePrice: costContext.getUsagePrice,
        });

        const eventName = context.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
        if (typeof context.eventSource.makeLast === 'function') {
            context.eventSource.makeLast(eventName, requestHook);
        } else {
            context.eventSource.on(eventName, requestHook);
        }

        const refreshModelPolicy = async () => {
            clientLogger?.event('info', 'policy.refresh_started', { phase: 'started' });
            try {
                const result = await refreshModelPolicyFromGitHub({ logger: clientLogger });
                if (result.changed) controller?.onModelPolicyChanged();
                clientLogger?.event(result.applied ? 'info' : 'warn', result.applied
                    ? 'policy.refresh_completed'
                    : 'policy.refresh_failed', {
                    phase: result.applied ? (result.changed ? 'changed' : 'unchanged') : 'failed',
                    ...getSafeErrorContext(result.error),
                });
                return result;
            } catch (error) {
                clientLogger?.event('error', 'policy.refresh_failed', {
                    phase: 'failed',
                    ...getSafeErrorContext(error),
                });
                console.warn('[Vertex PayGo] Could not apply the refreshed model policy.', error);
                return { applied: false, error };
            }
        };
        void refreshModelPolicy();
        modelPolicyRefreshTimer ??= setInterval(refreshModelPolicy, MODEL_POLICY_REFRESH_INTERVAL_MS);
        clientLogger.event('info', 'extension.init_ready', { phase: 'ready' });
    } catch (error) {
        costUi?.destroy();
        costContext?.destroy();
        initialized = false;
        if (modelPolicyRefreshTimer !== null) {
            clearInterval(modelPolicyRefreshTimer);
            modelPolicyRefreshTimer = null;
        }
        clientLogger?.event('error', 'extension.init_failed', {
            phase: 'failed',
            ...getSafeErrorContext(error),
        });
        console.error('[Vertex PayGo] Extension initialization failed.', error);
        notify('error', error instanceof Error ? error.message : String(error));
    }
}

export function getControllerForDebug() {
    return controller;
}

export function installLegacyActivationFallback({
    documentRef = globalThis.document,
    activate = init,
    logger = console,
} = {}) {
    if (!documentRef || typeof activate !== 'function') return false;

    const run = () => {
        Promise.resolve()
            .then(activate)
            .catch(error => logger.error('[Vertex PayGo] Legacy activation fallback failed.', error));
    };

    if (documentRef.readyState === 'loading') {
        documentRef.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
        run();
    }
    return true;
}

installLegacyActivationFallback();
