/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

function requireDocument(documentRef) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
        throw new TypeError('A document implementation is required.');
    }
    return documentRef;
}

export function buildLogFilename() {
    return 'st-vertex-paygo.log';
}

export function createLogViewerContent(text, {
    documentRef = globalThis.document,
    title = 'Vertex AI PayGo logs',
    description = '',
    emptyText = 'No log entries are available for this startup.',
} = {}) {
    const resolvedDocument = requireDocument(documentRef);
    const container = resolvedDocument.createElement('div');
    container.className = 'vertex-paygo-log-viewer';

    const heading = resolvedDocument.createElement('h3');
    heading.textContent = String(title);
    const guidance = resolvedDocument.createElement('p');
    guidance.className = 'vertex-paygo-log-description';
    guidance.textContent = String(description);
    const output = resolvedDocument.createElement('pre');
    output.className = 'vertex-paygo-log-output';
    output.textContent = String(text || emptyText);
    container.append(heading);
    if (description) container.append(guidance);
    container.append(output);
    return container;
}

export async function showLogViewer(text, {
    context,
    documentRef = globalThis.document,
    title,
    description,
    emptyText,
    closeText = 'Close',
} = {}) {
    if (typeof context?.Popup !== 'function' || context?.POPUP_TYPE?.TEXT === undefined) {
        throw new TypeError('SillyTavern Popup API is unavailable.');
    }
    const content = createLogViewerContent(text, { documentRef, title, description, emptyText });
    const popup = new context.Popup(content, context.POPUP_TYPE.TEXT, '', {
        okButton: closeText,
        wide: true,
        large: true,
        leftAlign: true,
        allowHorizontalScrolling: true,
        allowVerticalScrolling: true,
    });
    return await popup.show();
}

export function downloadLogText(text, {
    documentRef = globalThis.document,
    BlobImpl = globalThis.Blob,
    urlApi = globalThis.URL,
    filename = buildLogFilename(),
} = {}) {
    const resolvedDocument = requireDocument(documentRef);
    if (typeof BlobImpl !== 'function' || typeof urlApi?.createObjectURL !== 'function' || typeof urlApi?.revokeObjectURL !== 'function') {
        throw new TypeError('Browser download APIs are unavailable.');
    }

    const blob = new BlobImpl([String(text)], { type: 'text/plain;charset=utf-8' });
    let objectUrl;
    let link;
    try {
        objectUrl = urlApi.createObjectURL(blob);
        link = resolvedDocument.createElement('a');
        link.href = objectUrl;
        link.download = String(filename);
        link.hidden = true;
        resolvedDocument.body?.append(link);
        link.click();
    } finally {
        link?.remove?.();
        if (objectUrl !== undefined) urlApi.revokeObjectURL(objectUrl);
    }
    return filename;
}
