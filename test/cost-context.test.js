import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationId, createCostContext } from '../src/cost-context.js';
import { priceKey } from '../src/cost-model.js';

test('LAN HTTP browsers without randomUUID can still identify a conversation', () => {
    assert.equal(createConversationId({ getRandomValues: bytes => bytes.fill(31) }), '1f'.repeat(16));
    assert.match(createConversationId({}), /^chat-[a-z0-9-]+$/);
});

function fixture() {
    let next = 0;
    const listeners = {};
    const current = { characterId: 0, characters: [{ avatar: 'alice.png' }, { avatar: 'bob.png' }], chatId: 'chat-a',
        extensionSettings: {}, saves: 0, saveSettingsDebounced() { this.saves++; },
        eventTypes: { CHAT_RENAMED: 'renamed' }, eventSource: { on: (event, fn) => listeners[event] = fn } };
    const api = createCostContext({ getContext: () => current, idFactory: () => `conversation-${++next}` });
    return { current, api, listeners };
}

test('message placement defaults to footer and persists globally without changing pricing or chat data', () => {
    const { current, api } = fixture();
    assert.equal(api.getMessageCostPlacement(), 'footer');
    assert.equal(current.saves, 0);
    for (const placement of ['header', 'avatar', 'hidden', 'footer']) {
        api.setMessageCostPlacement(placement);
        const reload = createCostContext({ getContext: () => current });
        current.chatId = `another-${placement}`;
        assert.equal(reload.getMessageCostPlacement(), placement);
        reload.destroy();
    }
    assert.equal(current.saves, 4);
    assert.deepEqual(current.extensionSettings['vertex-paygo-costs'].conversations, {});
    assert.deepEqual(current.extensionSettings['vertex-paygo-costs'].prices, {});
    current.extensionSettings['vertex-paygo-costs'].messageCostPlacement = 'unsupported';
    assert.equal(api.getMessageCostPlacement(), 'footer');
    api.destroy();
});

test('conversation IDs persist across reload and separate characters, groups and branches', () => {
    const { current, api } = fixture();
    assert.equal(api.getChatId(), null);
    const first = api.captureUsageContext();
    assert.equal(api.captureUsageContext(), first);
    const reload = createCostContext({ getContext: () => current });
    assert.equal(reload.getChatId(), first);
    current.characterId = 1;
    assert.notEqual(api.captureUsageContext(), first);
    current.characterId = 0;
    current.chatId = 'branch';
    assert.notEqual(api.captureUsageContext(), first);
    current.chatId = 'chat-a';
    assert.equal(api.getChatId(), first);
    current.groupId = 'group-a';
    assert.notEqual(api.captureUsageContext(), first);
});

test('renaming preserves history while no active chat is not attributed', () => {
    const { current, api, listeners } = fixture();
    const first = api.captureUsageContext();
    listeners.renamed({ avatarId: 'alice.png', oldFileName: 'chat-a.jsonl', newFileName: 'renamed.jsonl' });
    current.chatId = 'renamed';
    assert.equal(api.getChatId(), first);
    current.chatId = undefined;
    assert.equal(api.captureUsageContext(), null);
});

test('pricing is isolated by provider/model/tier and captured as an independent snapshot', () => {
    const { api } = fixture();
    const key = { source: 'vertexai', model: 'gemini-test', tier: 'standard' };
    api.setPrices({ [priceKey(key)]: { input: 2, cachedInput: 0.2, output: 12 } });
    const data = { chat_completion_source: key.source, model: key.model };
    const snapshot = api.getUsagePrice(data, key);
    const changed = api.getPrices();
    changed[priceKey(key)].input = 9;
    assert.equal(api.getUsagePrice(data, key).input, 2);
    api.setPrices(changed);
    assert.equal(snapshot.input, 2);
    assert.equal(api.getUsagePrice(data, { tier: 'flex' }), null);
    assert.equal(api.getUsagePrice({ ...data, chat_completion_source: 'makersuite' }, key), null);
    assert.throws(() => api.setPrices({ bad: { input: -1 } }));
});
