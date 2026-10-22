/** Runtime compatibility for hosts whose Gemini allowlists predate Argon. */
export const GEMINI4_MODELS = ['gemini-4-argon', 'gemini-4-argon-cyber-permissive'];
export const isGemini4Model = model => GEMINI4_MODELS.includes(model);

export function selectedMedia(prompt) {
    if (!Array.isArray(prompt?.media)) return [];
    if (prompt.mediaDisplay === 'list') return prompt.media;
    if (prompt.mediaDisplay === 'gallery') return [prompt.media[prompt.mediaIndex]].filter(Boolean);
    return [];
}

/**
 * captureMessages must be called by the manifest's generate_interceptor. The
 * reference is deliberately retained: later interceptors may edit that array.
 * No attachment is sourced from the full (possibly excluded) persisted chat.
 */
export async function installGemini4HostCompatibility({
    context, host, document: doc = globalThis.document,
    models = GEMINI4_MODELS.map(id => ({ id, inputTokenLimit: 1048576, outputTokenLimit: 1048576 })), isEnabled = () => true,
} = {}) {
    host ??= await import('/scripts/openai.js');
    const settings = () => host.oai_settings ?? context?.chatCompletionSettings ?? {};
    const active = () => {
        const s = settings();
        return isEnabled() && ['makersuite', 'vertexai'].includes(s.chat_completion_source)
            && isGemini4Model(s.chat_completion_source === 'vertexai' ? s.vertexai_model : s.google_model);
    };
    let captured = null;
    let prepared = new WeakMap();
    let consumed = new Map();
    const consume = prompt => {
        const key = JSON.stringify([prompt.role, prompt.name, prompt.content]);
        const matches = host.setOpenAIMessages(captured).filter(source => source
            && source.role === prompt.role && source.name === prompt.name && source.content === prompt.content);
        const index = consumed.get(key) ?? 0;
        if (!matches[index]) return undefined;
        consumed.set(key, index + 1);
        return matches[index];
    };
    let manager;
    let originalPrepare;
    let prepareWrapper;
    const captureMessages = chat => {
        captured = active() && Array.isArray(chat) ? chat : null;
        prepared = new WeakMap();
        consumed = new Map();
        if (host.promptManager && host.promptManager !== manager) {
            if (manager && manager.preparePrompt === prepareWrapper) manager.preparePrompt = originalPrepare;
            manager = host.promptManager;
            originalPrepare = manager.preparePrompt;
            prepareWrapper = function (prompt, ...args) {
                const result = originalPrepare.call(this, prompt, ...args);
                if (active() && captured && prompt?.name != null
                    && (prompt.identifier == null || /^chatHistory-[1-9]\d*$/u.test(prompt.identifier))) {
                    // The host reverses history, inserts prompts and removes a
                    // continuation before assigning chatHistory-N. Match the
                    // raw, pre-substitution Prompt instead of that index.
                    // Both this traversal and setOpenAIMessages are newest
                    // first. Name-less injected prompts never consume history.
                    const source = consume(prompt);
                    if (source) prepared.set(result, source);
                }
                return result;
            };
            manager.preparePrompt = prepareWrapper;
        }
    };
    const reset = () => { captured = null; };
    const original = host.Message?.fromPromptAsync;
    if (typeof original !== 'function' || typeof host.setOpenAIMessages !== 'function') {
        throw new Error('Gemini 4 compatibility requires the host Message factory and setOpenAIMessages exports.');
    }
    const attach = async (message, prompt, source) => {
        if (!active() || !settings().media_inlining || !captured) return message;
        if (!source) return message;
        const media = selectedMedia(source);
        const add = async () => {
            for (const item of media) {
                if (!item?.url) continue;
                const type = item.type || 'image';
                const supported = { image: 'isImageInliningSupported', video: 'isVideoInliningSupported', audio: 'isAudioInliningSupported' }[type];
                // Newer hosts already insert these after the factory returns.
                if (!supported || host[supported]?.()) continue;
                await message[{ image: 'addImage', video: 'addVideo', audio: 'addAudio' }[type]](item.url);
            }
        };
        // The host calls setName immediately after this factory in completion
        // name mode; its recount must precede attachment token accounting.
        if (settings().names_behavior === 1 && prompt.name && /^(chatHistory-|continuePrefill$)/u.test(prompt.identifier ?? '')) {
            const setName = message.setName;
            message.setName = async function (...nameArgs) {
                this.setName = setName;
                const result = await setName.apply(this, nameArgs);
                await add();
                return result;
            };
        } else await add();
        return message;
    };
    const wrapper = async function (prompt, ...args) {
        return attach(await original.call(this, prompt, ...args), prompt, prepared.get(prompt));
    };
    const originalCreate = host.Message.createAsync;
    const createWrapper = async function (role, content, identifier, ...args) {
        const message = await originalCreate.call(this, role, content, identifier, ...args);
        if (identifier !== 'continuePrefill' || !active() || !captured) return message;
        // On Google/Vertex the host does not prepend assistant_prefill. It
        // shifts exactly the most recent message before in-chat injections.
        const source = host.setOpenAIMessages(captured)[0];
        if (!source || source.role !== role || source.content !== content) return message;
        const prompt = { role, content, identifier, name: source.name };
        return attach(message, prompt, consume(prompt));
    };
    if (typeof originalCreate === 'function') host.Message.createAsync = createWrapper;
    host.Message.fromPromptAsync = wrapper;
    const filledMetadata = new Map();
    const changedLimits = new Map();
    const refresh = () => {
        if (!isEnabled()) return;
        // Enrich only models supplied by the host or another extension. Creating
        // records or options here would compete with their model-list ownership.
        if (['makersuite', 'vertexai'].includes(settings().chat_completion_source) && Array.isArray(host.model_list)) {
            for (const existing of host.model_list) {
                const model = models.find(model => model.id === existing.id);
                if (!model) continue;
                for (const key of ['inputTokenLimit', 'outputTokenLimit']) {
                    if (existing[key] == null && Number.isFinite(model[key])) {
                        if (!filledMetadata.has(existing)) filledMetadata.set(existing, new Map());
                        filledMetadata.get(existing).set(key, { had: Object.hasOwn(existing, key), old: existing[key], applied: model[key] });
                        existing[key] = model[key];
                    }
                }
            }
        }
        if (!active()) {
            for (const [element, { old, applied }] of changedLimits) {
                if (element.max === applied) element.max = old;
            }
            changedLimits.clear();
            return;
        }
        const s = settings();
        const model = models.find(model => model.id === (s.chat_completion_source === 'vertexai' ? s.vertexai_model : s.google_model));
        for (const [id, limit] of [['openai_max_context', model?.inputTokenLimit], ['openai_max_context_counter', model?.inputTokenLimit], ['openai_max_tokens', model?.outputTokenLimit]]) {
            const element = doc?.getElementById(id);
            if (element && Number.isFinite(limit) && limit > 0) {
                if (!changedLimits.has(element)) changedLimits.set(element, { old: element.max, applied: String(limit) });
                else changedLimits.get(element).applied = String(limit);
                element.max = String(limit);
            }
        }
    };
    // Capture phase runs before the host's jQuery change handler calculates
    // its context ceiling, including after a model-list fetch replaces it.
    const beforeChange = event => {
        if (['model_google_select', 'model_vertexai_select', 'chat_completion_source'].includes(event.target?.id)) refresh();
    };
    doc?.addEventListener?.('change', beforeChange, true);
    const events = context?.eventTypes ?? context?.event_types ?? {};
    const source = context?.eventSource;
    const listeners = [];
    for (const [key, handler] of [['GENERATION_STARTED', reset], ['CHATCOMPLETION_MODEL_CHANGED', refresh], ['CHATCOMPLETION_SOURCE_CHANGED', refresh], ['OAI_PRESET_CHANGED_AFTER', refresh]]) {
        if (events[key] && source?.on) {
            source.on(events[key], handler);
            listeners.push([events[key], handler]);
        }
    }
    refresh();
    return { captureMessages, refresh, cleanup() {
        reset();
        if (host.Message.fromPromptAsync === wrapper) host.Message.fromPromptAsync = original;
        if (host.Message.createAsync === createWrapper) host.Message.createAsync = originalCreate;
        if (manager && manager.preparePrompt === prepareWrapper) manager.preparePrompt = originalPrepare;
        doc?.removeEventListener?.('change', beforeChange, true);
        for (const [element, { old, applied }] of changedLimits) {
            if (element.max === applied) element.max = old;
        }
        for (const [event, handler] of listeners) source.removeListener?.(event, handler);
        for (const [record, fields] of filledMetadata) {
            for (const [key, { had, old, applied }] of fields) {
                if (record[key] !== applied) continue;
                if (had) record[key] = old;
                else delete record[key];
            }
        }
    } };
}
