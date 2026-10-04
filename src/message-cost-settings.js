/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

export const MESSAGE_COST_PLACEMENTS = Object.freeze(['footer', 'header', 'avatar', 'hidden']);

export function normalizeMessageCostPlacement(value) {
    return MESSAGE_COST_PLACEMENTS.includes(value) ? value : 'footer';
}

export function createMessageCostPlacementControl({ documentRef = globalThis.document, localize,
    getMessageCostPlacement = () => 'footer', setMessageCostPlacement = () => {} }) {
    const element = (tag, attributes, key) => {
        const node = documentRef.createElement(tag);
        for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
        if (key) { node.setAttribute('data-i18n', key); node.textContent = localize(key); }
        return node;
    };
    const root = element('div', { class: 'vertex-paygo-message-cost-setting' });
    const label = element('label', { for: 'vertex-paygo-message-cost-placement' }, 'vertex_paygo.message_cost.placement');
    const select = element('select', { id: 'vertex-paygo-message-cost-placement', class: 'text_pole',
        'aria-describedby': 'vertex-paygo-message-cost-placement-guidance' });
    for (const value of MESSAGE_COST_PLACEMENTS) {
        select.append(element('option', { value }, `vertex_paygo.message_cost.placement.${value}`));
    }
    const guidance = element('small', { id: 'vertex-paygo-message-cost-placement-guidance', class: 'vertex-paygo-guidance' },
        'vertex_paygo.message_cost.placement.guidance');
    root.append(label, select, guidance);
    const render = () => { select.value = normalizeMessageCostPlacement(getMessageCostPlacement()); };
    const change = () => {
        setMessageCostPlacement(normalizeMessageCostPlacement(select.value));
        render();
    };
    select.addEventListener('change', change);
    render();
    return { root, select, render, destroy() { select.removeEventListener('change', change); } };
}
