/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

// All extension settings share one host drawer, independently of the active API
// source. Each feature mounts into its own tab so the drawer stays short on
// phones, while every section keeps its own controls and listeners.
export const SETTINGS_TABS = Object.freeze(['general', 'bridge', 'pricing']);
const TAB_ICONS = Object.freeze({ general: 'fa-sliders', bridge: 'fa-plug', pricing: 'fa-coins' });
const TAB_STORAGE_KEY = 'vertex-paygo-settings-tab';
const ROOT_ID = 'vertex-paygo-extension-settings';
const CONTENT_ID = 'vertex-paygo-extension-settings-content';
const shells = new WeakMap();

function make(documentRef, tag, attributes = {}, text = '') {
    const node = documentRef.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
        if (name === 'class') node.className = value;
        else node.setAttribute(name, value);
    }
    if (text) node.textContent = text;
    return node;
}

function readStoredTab(documentRef) {
    try { return documentRef.defaultView?.localStorage?.getItem(TAB_STORAGE_KEY) ?? null; }
    catch { return null; }
}

function storeTab(documentRef, tab) {
    try { documentRef.defaultView?.localStorage?.setItem(TAB_STORAGE_KEY, tab); }
    catch { /* Remembering the tab is a convenience only. */ }
}

function orderedTabs(shell) {
    const rank = tab => {
        const index = SETTINGS_TABS.indexOf(tab);
        return index === -1 ? SETTINGS_TABS.length : index;
    };
    return [...shell.tabs.keys()].sort((left, right) => rank(left) - rank(right));
}

function notifyShown(shell) {
    for (const onShow of shell.tabs.get(shell.active)?.sections.values() ?? []) {
        try { onShow?.(); }
        catch (error) { console.error('[Vertex PayGo] Settings tab refresh failed.', error); }
    }
}

function activate(shell, tab, { remember = false, focus = false } = {}) {
    if (!shell.tabs.has(tab)) return;
    const changed = shell.active !== tab;
    shell.active = tab;
    for (const [name, entry] of shell.tabs) {
        const selected = name === tab;
        entry.button.setAttribute('aria-selected', String(selected));
        entry.button.setAttribute('tabindex', selected ? '0' : '-1');
        entry.panel.hidden = !selected;
    }
    // A single section needs no tab strip.
    shell.tablist.hidden = shell.tabs.size < 2;
    if (remember) {
        shell.chosen = true;
        storeTab(shell.documentRef, tab);
    }
    if (focus) shell.tabs.get(tab).button.focus?.();
    if (changed && shell.open) notifyShown(shell);
}

function activatePreferred(shell) {
    // Sections mount one after another at startup, so the remembered tab wins
    // whenever it appears, until the user picks a tab in this session.
    const stored = shell.chosen ? null : readStoredTab(shell.documentRef);
    const tabs = orderedTabs(shell);
    const preferred = tabs.includes(stored) ? stored
        : shell.tabs.has(shell.active) ? shell.active : tabs[0];
    if (preferred) activate(shell, preferred);
}

function setOpen(shell, open) {
    shell.open = open;
    shell.header.setAttribute('aria-expanded', String(open));
    shell.icon.className = `inline-drawer-icon fa-solid ${open ? 'fa-circle-chevron-up up' : 'fa-circle-chevron-down down'}`;
    shell.content.hidden = !open;
    if (open) notifyShown(shell);
}

function createShell(documentRef, host) {
    const root = make(documentRef, 'div', { id: ROOT_ID, class: 'inline-drawer vertex-paygo-shell' });
    const header = make(documentRef, 'div', { id: `${ROOT_ID}-header`, class: 'inline-drawer-toggle inline-drawer-header',
        role: 'button', tabindex: '0', 'aria-expanded': 'false', 'aria-controls': CONTENT_ID });
    const title = make(documentRef, 'b', { class: 'vertex-paygo-shell-title' }, 'ST-Vertex-PayGo');
    const icon = make(documentRef, 'div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down', 'aria-hidden': 'true' });
    header.append(title, icon);
    const content = make(documentRef, 'div', { id: CONTENT_ID, class: 'inline-drawer-content vertex-paygo-shell-content' });
    content.hidden = true;
    const tablist = make(documentRef, 'div', { class: 'vertex-paygo-tabs', role: 'tablist', 'aria-label': 'ST-Vertex-PayGo' });
    tablist.hidden = true;
    content.append(tablist);
    root.append(header, content);
    host.append(root);

    const shell = { documentRef, root, header, title, icon, content, tablist, tabs: new Map(), active: null, open: false, chosen: false, disposers: [] };
    const listen = (node, event, handler) => {
        node.addEventListener(event, handler);
        shell.disposers.push(() => node.removeEventListener(event, handler));
    };
    // Own the toggle: the hosts' delegated jQuery handlers animate the content
    // but report no open state, which would leave ARIA and tab refreshes stale.
    listen(header, 'click', event => {
        event?.stopPropagation?.();
        setOpen(shell, !shell.open);
    });
    listen(header, 'keydown', event => {
        if (event?.key !== 'Enter' && event?.key !== ' ') return;
        event.preventDefault?.();
        setOpen(shell, !shell.open);
    });
    listen(tablist, 'keydown', event => {
        const tabs = orderedTabs(shell);
        const index = tabs.indexOf(shell.active);
        const target = { ArrowLeft: tabs[(index - 1 + tabs.length) % tabs.length],
            ArrowRight: tabs[(index + 1) % tabs.length], Home: tabs[0], End: tabs.at(-1) }[event?.key];
        if (!target) return;
        event.preventDefault?.();
        activate(shell, target, { remember: true, focus: true });
    });
    shells.set(documentRef, shell);
    return shell;
}

function ensureTab(shell, tab, label) {
    let entry = shell.tabs.get(tab);
    if (entry) return entry;
    const { documentRef } = shell;
    const panelId = `vertex-paygo-settings-panel-${tab}`;
    const button = make(documentRef, 'button', { id: `vertex-paygo-settings-tab-${tab}`, type: 'button',
        class: 'vertex-paygo-tab', role: 'tab', 'data-tab': tab, 'aria-controls': panelId,
        'aria-selected': 'false', tabindex: '-1', title: label });
    button.append(make(documentRef, 'i', { class: `fa-solid ${TAB_ICONS[tab] ?? 'fa-gear'}`, 'aria-hidden': 'true' }),
        make(documentRef, 'span', { class: 'vertex-paygo-tab-label' }, label));
    const panel = make(documentRef, 'div', { id: panelId, class: 'vertex-paygo-panel', role: 'tabpanel',
        'data-tab': tab, 'aria-labelledby': button.id });
    panel.hidden = true;
    const onClick = () => activate(shell, tab, { remember: true });
    button.addEventListener('click', onClick);
    shell.tablist.append(button);
    shell.content.append(panel);
    entry = { button, panel, sections: new Map(), dispose: () => button.removeEventListener('click', onClick) };
    shell.tabs.set(tab, entry);
    return entry;
}

/**
 * Mounts a settings section into the shared PayGo drawer.
 * @param {HTMLElement} section
 * @param {{ documentRef?: Document, tab?: string, label?: string, onShow?: () => void }} [options]
 *   `onShow` runs whenever the section's tab becomes visible.
 * @returns {() => void} Unmounts the section; the drawer disappears with its last section.
 */
export function mountExtensionSettings(section, { documentRef = globalThis.document, tab = 'general', label = tab, onShow } = {}) {
    const host = documentRef.getElementById('extensions_settings2')
        ?? documentRef.getElementById('extensions_settings');
    if (!host) throw new Error('Extension settings are unavailable.');
    let shell = shells.get(documentRef);
    if (!shell || documentRef.getElementById(ROOT_ID) !== shell.root) shell = createShell(documentRef, host);
    const entry = ensureTab(shell, tab, label);
    entry.panel.append(section);
    entry.sections.set(section, onShow);
    activatePreferred(shell);
    let mounted = true;
    return () => {
        if (!mounted) return;
        mounted = false;
        entry.sections.delete(section);
        if ([...entry.panel.children].includes(section)) section.remove();
        if (!entry.panel.children.length) {
            entry.dispose();
            entry.button.remove();
            entry.panel.remove();
            shell.tabs.delete(tab);
        }
        if (shell.tabs.size) {
            activatePreferred(shell);
            return;
        }
        for (const dispose of shell.disposers) dispose();
        shell.root.remove();
        if (shells.get(documentRef) === shell) shells.delete(documentRef);
    };
}
