/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountExtensionSettings } from '../src/extension-settings.js';
import { nativeDocument } from './helpers/native-dom.js';

function fixture({ stored = null } = {}) {
    const documentRef = nativeDocument();
    const saved = new Map(stored ? [['vertex-paygo-settings-tab', stored]] : []);
    documentRef.defaultView = { localStorage: {
        getItem: key => saved.get(key) ?? null,
        setItem: (key, value) => saved.set(key, value),
    } };
    const get = id => documentRef.getElementById(id);
    const section = id => { const node = documentRef.createElement('section'); node.id = id; return node; };
    return { documentRef, get, section, saved };
}

test('one drawer hosts ordered tabs and hides the tab strip for a single section', () => {
    const f = fixture();
    const unmountPricing = mountExtensionSettings(f.section('pricing'), { documentRef: f.documentRef, tab: 'pricing', label: 'Pricing' });
    assert.equal(f.get('extensions_settings2').children.length, 1);
    const tablist = f.get('vertex-paygo-extension-settings-content').children[0];
    assert.equal(tablist.attributes.role, 'tablist');
    assert.equal(tablist.hidden, true);
    assert.equal(f.get('vertex-paygo-settings-panel-pricing').hidden, false);

    const unmountGeneral = mountExtensionSettings(f.section('general'), { documentRef: f.documentRef, label: 'General' });
    assert.equal(tablist.hidden, false);
    // The first mounted tab stays selected; later tabs do not steal focus.
    assert.equal(f.get('vertex-paygo-settings-tab-pricing').attributes['aria-selected'], 'true');
    assert.equal(f.get('vertex-paygo-settings-tab-general').attributes['aria-selected'], 'false');
    assert.equal(f.get('vertex-paygo-settings-panel-general').hidden, true);
    assert.equal(f.get('vertex-paygo-settings-tab-general').children[1].textContent, 'General');

    unmountPricing();
    assert.equal(f.get('vertex-paygo-settings-tab-pricing'), null);
    assert.equal(f.get('vertex-paygo-settings-panel-general').hidden, false);
    assert.equal(tablist.hidden, true);
    unmountGeneral();
    assert.equal(f.get('vertex-paygo-extension-settings'), null);
    assert.doesNotThrow(unmountGeneral);
});

test('the header owns open state, ARIA and refreshes of the visible tab', async () => {
    const f = fixture();
    const shown = [];
    mountExtensionSettings(f.section('general'), { documentRef: f.documentRef, onShow: () => shown.push('general') });
    mountExtensionSettings(f.section('pricing'), { documentRef: f.documentRef, tab: 'pricing', onShow: () => shown.push('pricing') });
    const header = f.get('vertex-paygo-extension-settings-header');
    const content = f.get('vertex-paygo-extension-settings-content');
    assert.equal(content.hidden, true);
    assert.equal(header.attributes['aria-expanded'], 'false');

    // Switching while closed does not refresh hidden content.
    await f.get('vertex-paygo-settings-tab-pricing').fire('click');
    assert.deepEqual(shown, []);
    assert.equal(f.saved.get('vertex-paygo-settings-tab'), 'pricing');

    let propagationStopped = false;
    await header.fire('click', { stopPropagation: () => { propagationStopped = true; } });
    assert.equal(propagationStopped, true, 'host drawer handlers must not toggle the shell a second time');
    assert.equal(content.hidden, false);
    assert.equal(header.attributes['aria-expanded'], 'true');
    assert.match(header.children[1].className, /fa-circle-chevron-up up/u);
    assert.deepEqual(shown, ['pricing']);

    await f.get('vertex-paygo-settings-tab-general').fire('click');
    assert.deepEqual(shown, ['pricing', 'general']);
    await f.get('vertex-paygo-settings-tab-general').fire('click');
    assert.deepEqual(shown, ['pricing', 'general'], 'reselecting the visible tab does not refresh it');

    await header.fire('keydown', { key: 'Enter' });
    assert.equal(content.hidden, true);
    assert.match(header.children[1].className, /fa-circle-chevron-down down/u);
    await header.fire('keydown', { key: 'a' });
    assert.equal(content.hidden, true);
});

test('arrow, Home and End keys move between tabs in their fixed order', async () => {
    const f = fixture();
    const focused = [];
    for (const tab of ['pricing', 'general', 'bridge']) {
        mountExtensionSettings(f.section(tab), { documentRef: f.documentRef, tab });
        f.get(`vertex-paygo-settings-tab-${tab}`).focus = () => focused.push(tab);
    }
    const tablist = f.get('vertex-paygo-extension-settings-content').children[0];
    const selected = () => ['general', 'bridge', 'pricing']
        .filter(tab => f.get(`vertex-paygo-settings-tab-${tab}`).attributes['aria-selected'] === 'true');
    assert.deepEqual(selected(), ['pricing']);
    await tablist.fire('keydown', { key: 'ArrowRight' });
    assert.deepEqual(selected(), ['general']);
    await tablist.fire('keydown', { key: 'ArrowLeft' });
    assert.deepEqual(selected(), ['pricing']);
    await tablist.fire('keydown', { key: 'Home' });
    assert.deepEqual(selected(), ['general']);
    await tablist.fire('keydown', { key: 'End' });
    assert.deepEqual(selected(), ['pricing']);
    assert.deepEqual(focused, ['general', 'pricing', 'general', 'pricing']);
    assert.equal(f.get('vertex-paygo-settings-tab-pricing').attributes.tabindex, '0');
    assert.equal(f.get('vertex-paygo-settings-tab-bridge').attributes.tabindex, '-1');
});

test('a remembered tab is restored when it mounts, until the user picks another tab', async () => {
    const f = fixture({ stored: 'pricing' });
    mountExtensionSettings(f.section('general'), { documentRef: f.documentRef });
    assert.equal(f.get('vertex-paygo-settings-panel-general').hidden, false);
    mountExtensionSettings(f.section('bridge'), { documentRef: f.documentRef, tab: 'bridge' });
    assert.equal(f.get('vertex-paygo-settings-panel-general').hidden, false);
    mountExtensionSettings(f.section('pricing'), { documentRef: f.documentRef, tab: 'pricing' });
    assert.equal(f.get('vertex-paygo-settings-panel-pricing').hidden, false);
    assert.equal(f.get('vertex-paygo-settings-panel-general').hidden, true);

    await f.get('vertex-paygo-settings-tab-bridge').fire('click');
    const unmountExtra = mountExtensionSettings(f.section('extra'), { documentRef: f.documentRef, tab: 'pricing' });
    assert.equal(f.get('vertex-paygo-settings-panel-bridge').hidden, false, 'a later mount keeps the chosen tab');
    unmountExtra();
    assert.equal(f.get('vertex-paygo-settings-panel-bridge').hidden, false);
    assert.equal(f.saved.get('vertex-paygo-settings-tab'), 'bridge');
});

test('storage failures never prevent mounting', () => {
    const f = fixture();
    f.documentRef.defaultView = { get localStorage() { throw new Error('denied'); } };
    const unmount = mountExtensionSettings(f.section('general'), { documentRef: f.documentRef });
    assert.equal(f.get('vertex-paygo-settings-panel-general').hidden, false);
    assert.doesNotThrow(() => f.get('vertex-paygo-settings-tab-general').fire('click'));
    unmount();
});
