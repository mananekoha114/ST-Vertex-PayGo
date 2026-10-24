import test from 'node:test';
import assert from 'node:assert/strict';
import { createFloatingTierUi } from '../src/floating-tier-ui.js';
import { createLocalizer } from '../src/i18n.js';
import { EXTENSION_ID } from '../src/constants.js';
import { nativeContext, nativeDocument } from './helpers/native-dom.js';

function fixture() {
    const documentRef = nativeDocument();
    const create = documentRef.createElement;
    documentRef.createElement = tag => {
        const node = create(tag);
        node.style = {};
        node.focus = () => { documentRef.activeElement = node; };
        node.getBoundingClientRect = () => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top) });
        return node;
    };
    const view = documentRef.createElement('window');
    view.innerWidth = 375;
    view.innerHeight = 667;
    documentRef.defaultView = view;
    const context = nativeContext();
    let saves = 0;
    context.saveSettingsDebounced = () => { saves++; };
    let target = { source: 'vertexai', model: 'gemini-3.8-flash', tier: 'standard', busy: false };
    const choices = [];
    let commit = async tier => { choices.push(tier); target.tier = tier; };
    const errors = [];
    const ui = createFloatingTierUi({ documentRef, getContext: () => context, getTarget: () => target,
        selectTier: tier => commit(tier), localize: createLocalizer(), notifyError: message => errors.push(message) });
    documentRef.body.append(ui.setting);
    const get = id => documentRef.getElementById(id);
    const root = get('vertex-paygo-floating');
    const ball = root.children[0];
    const panel = get('vertex-paygo-floating-options');
    const option = tier => panel.children.find(node => node['data-tier'] === tier);
    const preferences = () => context.extensionSettings[EXTENSION_ID]?.floatingTier;
    ui.render();
    return { ui, context, documentRef, view, root, ball, panel, option, choices, errors, preferences,
        saves: () => saves, setTarget: value => { target = value; }, setCommit: fn => { commit = fn; },
        async enable() { const input = get('vertex-paygo-floating-enabled'); input.checked = true; await input.fire('change'); } };
}

test('floating preference defaults off, restores globally, and follows source and model support', async () => {
    const f = fixture();
    assert.equal(f.root.hidden, true);
    await f.enable();
    assert.equal(f.root.hidden, false);
    assert.equal(f.preferences().enabled, true);
    assert.equal(f.saves(), 1);
    await f.ball.fire('click');
    assert.equal(f.panel.hidden, false);
    assert.equal(f.documentRef.activeElement, f.option('standard'));
    await f.option('flex').fire('click');
    assert.deepEqual(f.choices, ['flex']);
    assert.equal(f.ball.dataset.tier, 'flex');
    assert.equal(f.option('flex')['aria-pressed'], 'true');
    f.setTarget({ source: 'makersuite', model: 'gemini-2.5-pro', tier: 'standard' });
    f.ui.render();
    assert.equal(f.option('priority').hidden, true);
    await f.option('priority').fire('click');
    assert.deepEqual(f.choices, ['flex']);
    f.setTarget({ source: 'vertexai', model: 'not-a-gemini', tier: 'standard' });
    f.ui.render();
    assert.equal(f.option('flex').disabled, true);
    assert.equal(f.option('standard').disabled, false);
    await f.option('flex').fire('click');
    assert.deepEqual(f.choices, ['flex']);
    f.setTarget({ source: 'openai', model: '', tier: 'standard' });
    f.ui.render();
    assert.equal(f.root.hidden, true);
    f.context.extensionSettings[EXTENSION_ID].floatingTier.enabled = false;
    await f.context.eventSource.emit('settings');
    assert.equal(f.documentRef.getElementById('vertex-paygo-floating-enabled').checked, false);
    f.ui.destroy();
    assert.equal(f.documentRef.getElementById('vertex-paygo-floating'), null);
    assert.equal(f.documentRef.listeners.get('pointerdown').length, 0);
    assert.equal(f.view.listeners.get('resize').length, 0);
});

test('floating choices stay locked during transitions and recover after a rejected save', async () => {
    const f = fixture();
    await f.enable();
    let reject;
    f.setCommit(() => new Promise((_resolve, fail) => { reject = fail; }));
    const change = f.option('flex').fire('click');
    assert.equal(f.ball.disabled, true);
    await f.option('priority').fire('click');
    reject(new Error('save failed'));
    await change;
    assert.deepEqual(f.errors, ['save failed']);
    assert.equal(f.ball.disabled, false);
    f.setTarget({ source: 'vertexai', model: 'gemini-3.8-flash', tier: 'standard', busy: true });
    f.ui.render();
    assert.equal(f.ball.disabled, true);
    f.ui.destroy();
});

test('options explain each tier in visible text, including why a tier is unavailable', () => {
    const f = fixture();
    const hint = tier => f.option(tier).children[1].textContent;
    assert.equal(f.option('standard').children[0].textContent, 'Standard');
    assert.equal(hint('flex'), 'Cheaper but slower; may fail when Google is busy');
    assert.equal(f.option('flex').dataset.support, 'ok');
    assert.equal(f.panel.children[0].children[1].textContent, 'gemini-3.8-flash');
    f.setTarget({ source: 'vertexai', model: 'not-a-gemini', tier: 'standard' });
    f.ui.render();
    assert.equal(f.option('flex').dataset.support, 'blocked');
    assert.match(hint('flex'), /Gemini/);
    assert.equal(hint('standard'), 'Default price and speed');
    f.setTarget({ source: 'vertexai', model: 'gemini-99-preview', tier: 'standard' });
    f.ui.render();
    assert.equal(f.option('flex').disabled, false);
    assert.equal(f.option('flex').dataset.support, 'caution');
    assert.equal(hint('flex'), f.option('flex').title);
    f.ui.destroy();
});

test('arrow keys move between available options and wrap around', async () => {
    const f = fixture();
    await f.enable();
    await f.ball.fire('click');
    assert.equal(f.documentRef.activeElement, f.option('standard'));
    await f.root.fire('keydown', { key: 'ArrowDown' });
    assert.equal(f.documentRef.activeElement, f.option('flex'));
    await f.root.fire('keydown', { key: 'End' });
    assert.equal(f.documentRef.activeElement, f.option('priority'));
    await f.root.fire('keydown', { key: 'ArrowDown' });
    assert.equal(f.documentRef.activeElement, f.option('standard'));
    await f.root.fire('keydown', { key: 'ArrowUp' });
    assert.equal(f.documentRef.activeElement, f.option('priority'));
    f.ui.destroy();
});

test('dragging snaps to the nearest side edge without clicking; narrow-screen menus remain in view', async () => {
    const f = fixture();
    await f.enable();
    assert.equal(f.root.dataset.side, 'right');
    const x = parseFloat(f.root.style.left);
    const y = parseFloat(f.root.style.top);
    await f.ball.fire('pointerdown', { button: 0, pointerId: 1, clientX: x, clientY: y });
    await f.ball.fire('pointermove', { pointerId: 1, clientX: 100, clientY: 200 });
    assert.equal(f.root.classList.contains('vertex-paygo-floating--dragging'), true);
    assert.equal(parseFloat(f.root.style.left), 100);
    await f.ball.fire('pointerup', { pointerId: 1 });
    assert.equal(f.root.classList.contains('vertex-paygo-floating--dragging'), false);
    assert.equal(f.preferences().position.side, 'left');
    assert.ok(Math.abs(f.preferences().position.y * 667 - 200) < 1);
    assert.equal(parseFloat(f.root.style.left), 12, 'snapped to the left edge');
    assert.equal(f.root.dataset.placement, 'below');
    await f.ball.fire('click');
    assert.equal(f.panel.hidden, true, 'drag must not open the menu');
    await f.ball.fire('click');
    assert.equal(f.panel.hidden, false);
    const panelLeft = parseFloat(f.root.style.left) + parseFloat(f.panel.style.left);
    assert.ok(panelLeft >= 8);
    assert.ok(panelLeft + parseFloat(f.panel.style.width) <= 375 - 8);
    await f.root.fire('keydown', { key: 'Escape' });
    await f.ball.fire('pointerdown', { button: 0, pointerId: 2, clientX: 12, clientY: 200 });
    await f.ball.fire('pointermove', { pointerId: 2, clientX: 300, clientY: 600 });
    await f.ball.fire('pointerup', { pointerId: 2 });
    assert.equal(f.preferences().position.side, 'right');
    assert.equal(parseFloat(f.root.style.left), 375 - 60 - 12);
    assert.equal(f.root.dataset.placement, 'above');
    await f.ball.fire('click'); // The click that ends a drag is swallowed.
    await f.ball.fire('click');
    assert.equal(f.panel.hidden, false);
    const rightPanelLeft = parseFloat(f.root.style.left) + parseFloat(f.panel.style.left);
    assert.equal(rightPanelLeft + parseFloat(f.panel.style.width), 375 - 12, 'menu aligns with the ball edge');
    await f.root.fire('keydown', { key: 'Escape' });
    assert.equal(f.panel.hidden, true);
    assert.equal(f.documentRef.activeElement, f.ball);
    await f.ball.fire('click');
    await f.documentRef.fire('pointerdown', { target: f.documentRef.body });
    assert.equal(f.panel.hidden, true);
    f.view.innerWidth = 280;
    f.view.innerHeight = 320;
    await f.view.fire('resize');
    assert.equal(parseFloat(f.root.style.left), 280 - 60 - 12, 'resizing keeps the ball on its edge');
    assert.ok(parseFloat(f.root.style.top) + 60 <= 320 - 8);
    const saved = structuredClone(f.preferences().position);
    f.ui.destroy();
    assert.equal(saved.side, 'right');
    assert.ok(saved.y > 0 && saved.y < 1);
});
