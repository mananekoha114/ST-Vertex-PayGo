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

async function waitForVertexControls(timeoutMs = 10_000) {
    if (document.getElementById('vertexai_region') && document.getElementById('model_vertexai_select')) {
        return;
    }

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            observer.disconnect();
            reject(new Error('Timed out waiting for SillyTavern Vertex AI controls.'));
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
        await waitForVertexControls();
        const context = globalThis.SillyTavern?.getContext?.();
        if (!context) {
            throw new Error('SillyTavern public extension context is unavailable.');
        }

        const serverClient = createServerClient({
            fetchImpl: globalThis.fetch.bind(globalThis),
            getRequestHeaders: context.getRequestHeaders,
        });
        controller = createPayGoUi({
            context,
            serverClient,
            notifyError: message => notify('error', message),
            notifyWarning: message => notify('warning', message),
        });

        const requestHook = createRequestHook({
            stateProvider: controller.getState,
            serverClient,
            origin: globalThis.location.origin,
            notifyError: message => notify('error', message),
            notifyWarning: message => notify('warning', message),
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
