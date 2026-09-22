/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createLocalizer } from './i18n.js';

export function isTauriTavern(host = globalThis) {
    return host.__TAURITAVERN__ !== null && typeof host.__TAURITAVERN__ === 'object';
}

export function createTauriTavernNotice({
    documentRef = globalThis.document,
    localize = createLocalizer(),
} = {}) {
    const content = documentRef.createElement('div');
    content.className = 'vertex-paygo-tauritavern-notice';
    const add = (tag, key) => {
        const element = documentRef.createElement(tag);
        element.textContent = localize(`vertex_paygo.tauritavern.${key}`);
        content.append(element);
    };
    add('h3', 'title');
    add('p', 'unavailable');
    add('h4', 'vertex_title');
    add('p', 'vertex_steps');
    add('pre', 'vertex_flex');
    add('p', 'vertex_tiers');
    add('h4', 'ai_studio_title');
    add('p', 'ai_studio_steps');
    add('pre', 'ai_studio_flex');
    add('p', 'ai_studio_standard');
    add('p', 'finish');
    return content;
}

export async function showTauriTavernNotice({
    context,
    documentRef = globalThis.document,
    localize = createLocalizer(),
} = {}) {
    if (!documentRef.body && documentRef.readyState === 'loading') {
        await new Promise(resolve => documentRef.addEventListener('DOMContentLoaded', resolve, { once: true }));
    }
    const content = createTauriTavernNotice({ documentRef, localize });
    if (typeof context?.Popup === 'function' && context?.POPUP_TYPE?.TEXT !== undefined) {
        try {
            const popup = new context.Popup(content, context.POPUP_TYPE.TEXT, '', {
                okButton: localize('vertex_paygo.tauritavern.close'),
                wide: true,
                leftAlign: true,
                allowVerticalScrolling: true,
            });
            await popup.show();
            return;
        } catch (error) {
            console.warn('[Vertex PayGo] Host popup unavailable; using a native dialog.', error);
        }
    }

    // The unsupported-host notice must also work before the extension context is ready.
    const dialog = documentRef.createElement('dialog');
    dialog.className = 'vertex-paygo-tauritavern-dialog';
    dialog.setAttribute('aria-label', localize('vertex_paygo.tauritavern.title'));
    const close = documentRef.createElement('button');
    close.type = 'button';
    close.className = 'menu_button';
    close.textContent = localize('vertex_paygo.tauritavern.close');
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.append(content, close);
    documentRef.body.append(dialog);
    dialog.showModal();
}
