// Minimal DOM fixture for native adapter behavior; no browser-only globals.
export function nativeDocument() {
    class Node {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {};
            this.listeners = new Map(); this.dataset = {}; this.value = ''; this.textContent = '';
            const classes = new Set();
            this.classList = { add: (...names) => names.forEach(name => classes.add(name)),
                remove: (...names) => names.forEach(name => classes.delete(name)),
                toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
                contains: name => classes.has(name) };
        }
        setAttribute(name, value) { this.attributes[name] = value; this[name] = value; }
        append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
        replaceChildren(...children) { this.children = []; this.append(...children); }
        addEventListener(name, fn) { const list = this.listeners.get(name) ?? []; list.push(fn); this.listeners.set(name, list); }
        removeEventListener(name, fn) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== fn)); }
        async fire(name, event = {}) { for (const fn of this.listeners.get(name) ?? []) await fn({ target: this, preventDefault() {}, ...event }); }
        contains(node) { return node === this || this.children.some(child => child.contains(node)); }
        remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); }
        querySelector() { return null; }
    }
    const doc = new Node('document');
    doc.createElement = tag => new Node(tag);
    doc.body = new Node('body'); doc.append(doc.body);
    const find = (root, id) => root.id === id ? root : root.children.map(child => find(child, id)).find(Boolean);
    doc.getElementById = id => find(doc, id) ?? null;
    for (const id of ['extensions_settings2', 'extensionsMenu', 'vertexai_region']) {
        const node = doc.createElement(id === 'vertexai_region' ? 'input' : 'div'); node.id = id; doc.body.append(node);
    }
    return doc;
}

export function nativeContext() {
    const events = new Map();
    const context = {
        extensionSettings: {}, characterId: 0, characters: [{ avatar: 'test.png' }],
        getCurrentChatId: () => 'chat', saveSettingsDebounced() {},
        chatCompletionSettings: { chat_completion_source: 'vertexai', vertexai_model: 'gemini-3.8-flash',
            google_model: 'gemini-3.8-flash', vertexai_region: 'global', additional_parameters_by_source: {} },
        eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'request', SETTINGS_LOADED: 'settings' },
        eventSource: {
            on(name, fn) { events.set(name, [...(events.get(name) ?? []), fn]); },
            makeLast(name, fn) { this.on(name, fn); },
            removeListener(name, fn) { events.set(name, (events.get(name) ?? []).filter(item => item !== fn)); },
            async emit(name, ...args) { for (const fn of events.get(name) ?? []) await fn(...args); },
        },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 }, POPUP_TYPE: { TEXT: 1 },
        Popup: class { static show = { confirm: async () => 1 }; async show() {} },
    };
    return context;
}

export function nativeStore() {
    const files = new Map();
    const path = ({ namespace, table, key }) => `${namespace}/${table}/${key}`;
    return {
        files,
        async setJson(args) { files.set(path(args), structuredClone(args.value)); },
        async getJson(args) { if (!files.has(path(args))) throw new Error('missing'); return structuredClone(files.get(path(args))); },
        async tryGetJson(args) { return files.has(path(args)) ? { found: true, value: await this.getJson(args) } : { found: false }; },
        async listKeys({ namespace, table }) { const prefix = `${namespace}/${table}/`; return [...files.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)); },
    };
}
