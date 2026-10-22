import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { installGemini4HostCompatibility, selectedMedia } from '../src/gemini4-host.js';

const create = (host, prompt) => host.Message.fromPromptAsync(host.promptManager.preparePrompt({ name: 'N', content: 'text', ...prompt }));

function fixture() {
    class Message {
        static async fromPromptAsync(prompt) { return new Message(prompt); }
        constructor(prompt) { Object.assign(this, prompt); this.tokens = 10; this.content = []; }
        async setName(name) { this.name = name; this.tokens = 11; }
        async addImage(url) { this.content.push(url); this.tokens += 100; }
        async addVideo(url) { this.content.push(url); this.tokens += 200; }
        async addAudio(url) { this.content.push(url); this.tokens += 300; }
    }
    const listeners = new Map();
    const host = { Message, model_list: [], oai_settings: { chat_completion_source: 'makersuite', google_model: 'gemini-4-argon', media_inlining: true },
        promptManager: { preparePrompt: prompt => ({ ...prompt }) }, setOpenAIMessages: chat => [...chat].reverse().map(x => ({ name: 'N', content: 'text', ...x })), isImageInliningSupported: () => false,
        isVideoInliningSupported: () => false, isAudioInliningSupported: () => false };
    const context = { eventTypes: { GENERATION_STARTED: 'start' }, eventSource: { on: (event, fn) => listeners.set(event, fn), removeListener: event => listeners.delete(event) } };
    return { host, context, listeners };
}

test('selected media respects gallery index, list, and hidden display', () => {
    const media = [{ url: 'a' }, { url: 'b' }];
    assert.deepEqual(selectedMedia({ media, mediaDisplay: 'gallery', mediaIndex: 1 }), [media[1]]);
    assert.deepEqual(selectedMedia({ media, mediaDisplay: 'list' }), media);
    assert.deepEqual(selectedMedia({ media }), []);
});

test('factory adds exact intercepted history media before budget selection', async () => {
    const { host, context } = fixture();
    const original = host.Message.fromPromptAsync;
    const compat = await installGemini4HostCompatibility({ host, context });
    const chat = [{ role: 'user', mediaDisplay: 'list', media: [{ type: 'image', url: 'a' }, { type: 'video', url: 'v' }, { type: 'audio', url: 's' }] }, { role: 'assistant' }];
    compat.captureMessages(chat);
    const message = await create(host, { role: 'user', identifier: 'chatHistory-2' });
    assert.equal(message.tokens, 610);
    assert.equal(message.tokens <= 500, false, 'host budget rejects message including media cost');
    assert.deepEqual(message.content, ['a', 'v', 's']);
    assert.deepEqual((await create(host, { role: 'user', identifier: 'example-2' })).content, []);
    compat.cleanup();
    assert.equal(host.Message.fromPromptAsync, original);
});

test('name recount occurs before media cost and newer host media is not duplicated', async () => {
    const { host, context } = fixture();
    host.oai_settings.names_behavior = 1;
    host.isVideoInliningSupported = () => true;
    const compat = await installGemini4HostCompatibility({ host, context });
    compat.captureMessages([{ role: 'user', mediaDisplay: 'list', media: [{ url: 'a' }, { type: 'video', url: 'v' }] }]);
    const message = await create(host, { role: 'user', name: 'N', identifier: 'chatHistory-1' });
    await message.setName('N');
    assert.equal(message.tokens, 111);
    assert.deepEqual(message.content, ['a']);
    compat.cleanup();
});

test('generation start clears prior capture and media setting is respected', async () => {
    const { host, context, listeners } = fixture();
    const compat = await installGemini4HostCompatibility({ host, context });
    const chat = [{ role: 'user', mediaDisplay: 'list', media: [{ url: 'secret' }] }];
    compat.captureMessages(chat);
    listeners.get('start')();
    assert.deepEqual((await create(host, { role: 'user', identifier: 'chatHistory-1' })).content, []);
    compat.captureMessages(chat);
    host.oai_settings.media_inlining = false;
    assert.deepEqual((await create(host, { role: 'user', identifier: 'chatHistory-1' })).content, []);
    compat.cleanup();
});

test('model metadata and UI limits permit the window without altering user preferences', async () => {
    const { host, context } = fixture();
    const record = { id: 'gemini-4-argon' };
    host.model_list.push(record);
    host.oai_settings.openai_max_context = 900000;
    host.oai_settings.openai_max_tokens = 1000;
    const elements = Object.fromEntries(['openai_max_context', 'openai_max_context_counter', 'openai_max_tokens'].map(id => [id, { max: '128000' }]));
    const doc = { getElementById: id => elements[id] };
    const compat = await installGemini4HostCompatibility({ host, context, document: doc });
    assert.equal(host.model_list.find(model => model.id === 'gemini-4-argon').inputTokenLimit, 1048576);
    assert.equal(elements.openai_max_tokens.max, '1048576');
    assert.equal(host.oai_settings.openai_max_tokens, 1000);
    assert.equal(host.oai_settings.openai_max_context, 900000);
    host.oai_settings.google_model = 'gemini-2.5-pro';
    compat.refresh();
    assert.equal(elements.openai_max_tokens.max, '128000');
    compat.cleanup();
    assert.deepEqual(host.model_list, [{ id: 'gemini-4-argon' }]);
});

test('installation and host refresh events never create Argon options or model records', async () => {
    const { host, context, listeners } = fixture();
    Object.assign(context.eventTypes, { CHATCOMPLETION_MODEL_CHANGED: 'model', CHATCOMPLETION_SOURCE_CHANGED: 'source', OAI_PRESET_CHANGED_AFTER: 'preset' });
    const selects = Object.fromEntries(['model_google_select', 'model_vertexai_select'].map(id => [id, { options: [], append() { assert.fail('must not append model options'); } }]));
    let beforeChange;
    const doc = { getElementById: id => selects[id], createElement() { assert.fail('must not create model options'); },
        addEventListener: (event, handler) => { beforeChange = handler; }, removeEventListener() {} };
    const compat = await installGemini4HostCompatibility({ host, context, document: doc });
    assert.deepEqual(host.model_list, [], 'installation does not seed the model list');
    for (const select of Object.values(selects)) assert.deepEqual(select.options, []);
    for (const source of ['openai', 'vertexai', 'makersuite']) {
        host.oai_settings.chat_completion_source = source;
        host.model_list = [{ id: 'unrelated-host-model' }];
        compat.refresh();
        for (const event of ['model', 'source', 'preset']) listeners.get(event)();
        for (const id of [...Object.keys(selects), 'chat_completion_source']) beforeChange({ target: { id } });
        assert.deepEqual(host.model_list, [{ id: 'unrelated-host-model' }]);
        for (const select of Object.values(selects)) assert.deepEqual(select.options, []);
    }
    compat.cleanup();
    assert.equal(listeners.size, 0);
});

test('existing Argon options and records remain owned by the host with reversible metadata enrichment', async () => {
    const { host, context } = fixture();
    const argon = { id: 'gemini-4-argon', inputTokenLimit: 500000 };
    const cyber = { id: 'gemini-4-argon-cyber-permissive', inputTokenLimit: null, outputTokenLimit: 100000 };
    host.model_list = [argon, cyber];
    const options = [argon, cyber].map(record => ({ value: record.id, remove() { assert.fail('must not remove existing options'); } }));
    const select = { options, append() { assert.fail('must not duplicate existing options'); } };
    const compat = await installGemini4HostCompatibility({ host, context, document: { getElementById: () => select } });
    assert.equal(argon.inputTokenLimit, 500000);
    assert.equal(argon.outputTokenLimit, 1048576);
    assert.equal(cyber.inputTokenLimit, 1048576);
    assert.equal(cyber.outputTokenLimit, 100000);
    host.oai_settings.chat_completion_source = 'openai';
    compat.refresh();
    assert.deepEqual(host.model_list, [argon, cyber]);
    host.oai_settings.chat_completion_source = 'vertexai';
    compat.refresh();
    // A later host update must survive cleanup of our missing-field defaults.
    argon.outputTokenLimit = 200000;
    compat.cleanup();
    assert.deepEqual(host.model_list, [
        { id: 'gemini-4-argon', inputTokenLimit: 500000, outputTokenLimit: 200000 },
        { id: 'gemini-4-argon-cyber-permissive', inputTokenLimit: null, outputTokenLimit: 100000 },
    ]);
    assert.equal(select.options, options);
    assert.equal(select.options.length, 2);
});

// Execute the checked-out host's functions rather than a hand-written copy of
// its history ordering, injection, filtering or Message token accounting.
async function realHost(t, { group = false } = {}) {
    let source;
    let promptSource;
    try {
        source = await readFile(new URL('../../SillyTavern-1.18.0/public/scripts/openai.js', import.meta.url), 'utf8');
        promptSource = await readFile(new URL('../../SillyTavern-1.18.0/public/scripts/PromptManager.js', import.meta.url), 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') { t.skip('Local SillyTavern 1.18 checkout unavailable'); return; }
        throw error;
    }
    const declaration = (text, name) => {
        const match = new RegExp(`(?:async )?function ${name}\\([^]*?^}|(?:export )?class ${name}(?: extends \\w+)? \\{[^]*?^}`, 'm').exec(text);
        assert.ok(match, `host declaration ${name} found`);
        return match[0].replace(/^export /u, '');
    };
    const ignore = Symbol('ignore');
    const settings = { chat_completion_source: 'makersuite', google_model: 'gemini-4-argon', media_inlining: true, names_behavior: 1, inline_image_quality: 'low', new_chat_prompt: '', new_group_chat_prompt: '' };
    const sandbox = {
        console, structuredClone, IGNORE_SYMBOL: ignore, DEFAULT_ORDER: 100,
        oai_settings: settings, default_settings: { inline_image_quality: 'low' },
        selected_group: group, name1: 'User', name2: 'A',
        system_message_types: { NARRATOR: 'narrator' }, character_names_behavior: { NONE: -1, DEFAULT: 0, COMPLETION: 1, CONTENT: 2 },
        chat_completion_sources: { MAKERSUITE: 'makersuite', VERTEXAI: 'vertexai' },
        getChatCompletionModel: () => settings.google_model,
        getMediaDisplay: chat => chat.extra?.media_display ?? 'list', getMediaIndex: chat => chat.extra?.media_index ?? 0,
        tokenHandler: { countAsync: async () => 10 }, isDataURL: value => value.startsWith('data:'),
        substituteParams: value => value ?? '', substituteParamsExtended: value => value ?? '',
        MEDIA_TYPE: { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio' }, MEDIA_DISPLAY: { LIST: 'list', GALLERY: 'gallery' },
        isImageInliningSupported: () => false, isVideoInliningSupported: () => false, isAudioInliningSupported: () => false,
        ToolManager: { isToolCallingSupported: () => false }, isReasoningSignatureSupported: () => false,
        interleaved_reasoning_providers: [], tool_reasoning_modes: { DISABLED: 'disabled' },
        extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 }, extension_prompt_types: { IN_CHAT: 1 },
        getExtensionPromptMaxDepth: () => 0, getExtensionPrompt: async () => 'injected',
    };
    vm.createContext(sandbox);
    const classes = ['Message', 'MessageCollection', 'ChatCompletion', 'IdentifierNotFoundError', 'TokenBudgetExceededError'].map(name => declaration(source, name));
    vm.runInContext([declaration(promptSource, 'Prompt'), ...classes,
        ...['setOpenAIMessages', 'populationInjectionPrompts', 'populateChatHistory'].map(name => declaration(source, name)),
        'globalThis.host = { Message, MessageCollection, ChatCompletion, Prompt, setOpenAIMessages, populationInjectionPrompts, populateChatHistory };',
    ].join('\n'), sandbox);
    const host = sandbox.host;
    const preparePromptMethod = /^    preparePrompt\(prompt, original = null\) \{[^]*?^    }/m.exec(promptSource)?.[0];
    assert.ok(preparePromptMethod, 'actual host preparePrompt found');
    const preparePrompt = vm.runInContext(`({ ${preparePromptMethod} }).preparePrompt`, sandbox);
    Object.assign(host, { oai_settings: settings, model_list: [], isImageInliningSupported: sandbox.isImageInliningSupported, isVideoInliningSupported: sandbox.isVideoInliningSupported, isAudioInliningSupported: sandbox.isAudioInliningSupported,
        promptManager: { serviceSettings: settings, preparePrompt, getActiveGroupCharacters: () => [], isValidName: () => true, sanitizeName: name => name } });
    sandbox.promptManager = host.promptManager;
    return { host, sandbox, ignore };
}

test('real host history: injections, ignored entries, groups and continuation preserve attachment ownership', async t => {
    const fixture = await realHost(t, { group: true });
    if (!fixture) return;
    const { host, sandbox, ignore } = fixture;
    const compat = await installGemini4HostCompatibility({ host });
    const chat = [
        { is_user: true, name: 'User', mes: 'first', extra: { media: [{ url: 'data:image/png;base64,first' }] } },
        { is_system: true, is_user: true, name: 'User', mes: 'hidden', extra: { media: [{ url: 'data:image/png;base64,hidden' }] } },
        { is_user: false, name: 'A', mes: 'A reply', extra: { media: [{ url: 'data:image/png;base64,A' }] } },
        { is_user: false, name: 'B', mes: 'B reply', extra: { media: [{ url: 'data:image/png;base64,B' }] } },
    ];
    const coreChat = chat.filter(x => !x.is_system);
    compat.captureMessages(coreChat);
    const messages = await host.populationInjectionPrompts([], host.setOpenAIMessages(coreChat));
    const completion = new host.ChatCompletion();
    completion.setTokenBudget(10000, 100);
    const prompts = { has: id => id === 'chatHistory', index: () => 0 };
    await host.populateChatHistory(messages, prompts, completion);
    const output = completion.getChat();
    for (const [text, url] of [['first', 'first'], ['A reply', 'A'], ['B reply', 'B']]) {
        const message = output.find(x => Array.isArray(x.content) && x.content.some(p => p.text === text));
        assert.ok(message, text);
        assert.equal(message.content.find(p => p.type === 'image_url')?.image_url.url, `data:image/png;base64,${url}`);
    }
    assert.equal(JSON.stringify(output).includes('hidden'), false);
    assert.equal(output.filter(x => x.content === 'injected').length, 3);
    // continue_prefill is a direct createAsync call, outside the Prompt factory.
    compat.captureMessages(coreChat);
    const latest = host.setOpenAIMessages(coreChat)[0];
    const prefill = await host.Message.createAsync(latest.role, latest.content, 'continuePrefill');
    await prefill.setName(latest.name);
    assert.equal(prefill.content.find(p => p.type === 'image_url').image_url.url, 'data:image/png;base64,B');
    assert.equal(prefill.tokens, 95);
    compat.captureMessages(coreChat);
    const continued = new host.ChatCompletion();
    continued.setTokenBudget(10000, 100);
    const continueHistory = await host.populationInjectionPrompts([], host.setOpenAIMessages(coreChat));
    await host.populateChatHistory(continueHistory, prompts, continued, 'continue', 'B reply');
    assert.equal(JSON.stringify(continued.getChat()).includes('data:image/png;base64,B'), true);
    compat.cleanup();
});

test('real host duplicates consume latest first through injections and both continuation paths', async t => {
    const fixture = await realHost(t);
    if (!fixture) return;
    const { host, sandbox } = fixture;
    const compat = await installGemini4HostCompatibility({ host });
    const chat = ['older', 'latest'].map(id => ({ is_user: false, name: 'A', mes: 'same', extra: { media: [{ url: `data:image/png;base64,${id}` }] } }));
    // A same-text assistant injection must not consume either named message.
    sandbox.getExtensionPrompt = async (type, depth, separator, role) => role === 2 ? 'same' : '';
    const prompts = { has: id => id === 'chatHistory', index: () => 0 };
    for (const mode of ['normal', 'prefill', 'nudge']) {
        compat.captureMessages(chat);
        let messages = host.setOpenAIMessages(chat);
        let prefill;
        if (mode === 'prefill') {
            const latest = messages.shift();
            prefill = await host.Message.createAsync(latest.role, latest.content, 'continuePrefill');
            await prefill.setName(latest.name);
        }
        messages = await host.populationInjectionPrompts([], messages);
        const completion = new host.ChatCompletion();
        completion.setTokenBudget(1000, 100);
        await host.populateChatHistory(messages, prompts, completion, mode === 'nudge' ? 'continue' : null, mode === 'nudge' ? 'same' : null);
        const output = completion.getChat();
        if (prefill) output.push(prefill);
        const media = output.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url').map(part => part.image_url.url) : []);
        assert.deepEqual(Array.from(media).sort(), ['data:image/png;base64,latest', 'data:image/png;base64,older'], mode);
        const injection = output.find(message => message.content === 'same' && !message.name);
        assert.ok(injection, `${mode}: injected prompt remains text only`);
        const history = completion.getMessages().collection.find(collection => collection.identifier === 'chatHistory');
        const budgeted = history.collection.filter(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
        assert.ok(budgeted.every(message => message.getTokens() === 95), `${mode}: original attachment accounting retained`);
        if (prefill) assert.equal(prefill.getTokens(), 95);
        if (mode === 'normal') {
            assert.deepEqual(Array.from(budgeted, message => message.content.find(part => part.type === 'image_url').image_url.url), ['data:image/png;base64,older', 'data:image/png;base64,latest']);
            assert.equal(history.getTokens(), 200, 'two 95-token messages plus a 10-token injection');
        }
    }
    compat.captureMessages(chat);
    const limited = new host.ChatCompletion();
    limited.setTokenBudget(150, 10);
    await host.populateChatHistory(await host.populationInjectionPrompts([], host.setOpenAIMessages(chat)), prompts, limited);
    const limitedMedia = limited.getChat().flatMap(message => Array.isArray(message.content)
        ? message.content.filter(part => part.type === 'image_url').map(part => part.image_url.url) : []);
    assert.deepEqual(Array.from(limitedMedia), ['data:image/png;base64,latest'], 'native budget excludes older message using attachment cost');
    compat.cleanup();
});
