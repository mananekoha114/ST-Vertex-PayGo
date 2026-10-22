/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

// All extension settings share one entry, independently of the active API source.
// Native details provides keyboard support without relying on host drawer events.
export function mountExtensionSettings(section, { documentRef = globalThis.document } = {}) {
    const host = documentRef.getElementById('extensions_settings2')
        ?? documentRef.getElementById('extensions_settings');
    if (!host) throw new Error('Extension settings are unavailable.');
    let content = documentRef.getElementById('vertex-paygo-extension-settings-content');
    if (!content) {
        const drawer = documentRef.createElement('details');
        drawer.id = 'vertex-paygo-extension-settings';
        const summary = documentRef.createElement('summary');
        summary.textContent = 'ST-Vertex-PayGo';
        content = documentRef.createElement('div');
        content.id = 'vertex-paygo-extension-settings-content';
        drawer.append(summary, content);
        host.append(drawer);
    }
    content.append(section);
    let mounted = true;
    return () => {
        if (!mounted) return;
        mounted = false;
        if ([...content.children].includes(section)) section.remove();
        if (!content.children.length) content.parentElement?.remove();
    };
}
