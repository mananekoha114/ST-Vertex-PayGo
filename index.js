/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createLocalizer } from './src/i18n.js';
import { createRequestHook } from './src/request-hook.js';
import { createServerClient } from './src/server-client.js';
import { createPayGoUi } from './src/ui.js';

let initialized = false;
let controller = null;

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
        const context = globalThis.SillyTavern?.getContext?.();
        const localize = createLocalizer(
            typeof context?.translate === 'function'
                ? (fallback, key) => context.translate(fallback, key)
                : undefined,
        );
        if (!context) {
            throw new Error(localize('vertex_paygo.error.context_unavailable'));
        }
        await waitForVertexControls(10_000, localize);

        const serverClient = createServerClient({
            fetchImpl: globalThis.fetch.bind(globalThis),
            getRequestHeaders: context.getRequestHeaders,
        });
        controller = createPayGoUi({
            context,
            serverClient,
            notifyError: message => notify('error', message),
            notifyWarning: message => notify('warning', message),
            localize,
        });

        const requestHook = createRequestHook({
            stateProvider: controller.getState,
            serverClient,
            origin: globalThis.location.origin,
            notifyError: message => notify('error', message),
            notifyWarning: message => notify('warning', message),
            localize,
        });

        const eventName = context.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
        if (typeof context.eventSource.makeLast === 'function') {
            context.eventSource.makeLast(eventName, requestHook);
        } else {
            context.eventSource.on(eventName, requestHook);
        }
    } catch (error) {
        initialized = false;
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
