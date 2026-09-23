/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/
 */

import {
    AI_STUDIO_SOURCE,
    DEFAULT_STATE,
    TIER,
    VERTEX_SOURCE,
} from './constants.js';
import { normalizeState } from './state-machine.js';

/**
 * These are the only fields owned by the native adapter.  All other YAML
 * fields are copied through unchanged.  Header names are compared without
 * regard to case because HTTP field names are case insensitive.
 */
export const TAURI_MANAGED_HEADER_NAMES = Object.freeze([
    'X-Vertex-AI-LLM-Request-Type',
    'X-Vertex-AI-LLM-Shared-Request-Type',
    'X-Server-Timeout',
]);
export const TAURI_MANAGED_BODY_NAMES = Object.freeze(['service_tier']);
export const TAURI_MANAGED_EXCLUDE_NAMES = Object.freeze(['service_tier']);

const REQUEST_FIELD_NAMES = Object.freeze({
    body: ['custom_include_body', 'include_body', 'customIncludeBody'],
    exclude: ['custom_exclude_body', 'exclude_body', 'customExcludeBody'],
    headers: ['custom_include_headers', 'include_headers', 'customIncludeHeaders'],
});

const MANAGED_HEADER_KEYS = new Set(TAURI_MANAGED_HEADER_NAMES.map(name => name.toLowerCase()));
// JSON body names are case sensitive. Keep a user-defined `Service_Tier`
// field intact while managing the provider's canonical `service_tier`.
const MANAGED_BODY_KEYS = new Set(TAURI_MANAGED_BODY_NAMES);
const MANAGED_EXCLUDE_KEYS = new Set(TAURI_MANAGED_EXCLUDE_NAMES);

export class TauriParameterError extends Error {
    constructor(message, { code = 'TAURI_PARAMETER_ERROR', cause } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'TauriParameterError';
        this.code = code;
    }
}

function isObject(value) {
    return value !== null && typeof value === 'object';
}

function isRecord(value) {
    return isObject(value) && !Array.isArray(value);
}

function cloneValue(value) {
    if (Array.isArray(value)) return value.map(cloneValue);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
    return value;
}

function sourceOf(data) {
    const source = data?.chat_completion_source ?? data?.source ?? data?.provider;
    return String(source ?? '').trim().toLowerCase();
}

function ownFieldNames(container, kind) {
    if (!isRecord(container)) return [];
    return REQUEST_FIELD_NAMES[kind].filter(name => Object.hasOwn(container, name));
}

function hasParameterField(container) {
    return Object.values(REQUEST_FIELD_NAMES).some(names => names.some(name => Object.hasOwn(container ?? {}, name)));
}

function chooseContainer(data) {
    if (!isRecord(data)) {
        throw new TypeError('Tauri generation parameters must be an object.');
    }

    const nested = isRecord(data.parameters) ? data.parameters : null;
    if (nested && hasParameterField(nested)) {
        return { container: nested, nested: true };
    }
    if (hasParameterField(data)) {
        return { container: data, nested: false };
    }
    // A Tauri payload may wrap native additional parameters in `parameters`
    // before it has any of the three fields.  Prefer that shape when present.
    if (nested) return { container: nested, nested: true };
    return { container: data, nested: false };
}

function valueForField(container, kind) {
    for (const name of REQUEST_FIELD_NAMES[kind]) {
        if (Object.hasOwn(container, name)) return container[name];
    }
    return undefined;
}

function isStorageEntry(data, container, nested) {
    if (nested) return false;
    if (container !== data) return false;
    // `include_body` is the persistent Tauri setting spelling.  A bare
    // object without request metadata is therefore assumed to be such an
    // entry when the adapter has to create a missing field.
    return !('chat_completion_source' in data || 'model' in data || 'stream' in data);
}

function writeFieldNames(container, kind, { storage = false } = {}) {
    const existing = ownFieldNames(container, kind);
    if (existing.length) return existing;
    const aliases = REQUEST_FIELD_NAMES[kind];
    return [storage ? aliases[1] : aliases[0]];
}

function parserFor(yaml) {
    if (typeof yaml?.parse === 'function') return yaml.parse.bind(yaml);
    return null;
}

function stringifierFor(yaml) {
    if (typeof yaml?.stringify === 'function') return yaml.stringify.bind(yaml);
    return null;
}

function parseValue(value, yaml, kind) {
    if (value === undefined || value === null || value === '') return undefined;
    if (isObject(value)) return cloneValue(value);
    if (typeof value !== 'string') {
        throw new TauriParameterError(`The native ${kind} parameter is not YAML or an object.`, {
            code: 'INVALID_TAURI_PARAMETER_TYPE',
        });
    }
    try {
        const parse = parserFor(yaml);
        if (!parse) {
            throw new TauriParameterError('The host YAML parser is required for native additional parameters.', {
                code: 'TAURI_YAML_PARSER_REQUIRED',
            });
        }
        return parse(value);
    } catch (cause) {
        if (cause instanceof TauriParameterError) throw cause;
        throw new TauriParameterError(`Could not parse native ${kind} parameters.`, {
            code: 'INVALID_TAURI_YAML',
            cause,
        });
    }
}

function stringifyValue(value, original, yaml, kind) {
    const needsString = typeof original === 'string' || original === undefined || original === null;
    if (!needsString) return cloneValue(value);
    if (value === undefined || (isRecord(value) && !Object.keys(value).length)
        || (Array.isArray(value) && !value.length)) return '';
    const stringify = stringifierFor(yaml);
    if (stringify) {
        try {
            return String(stringify(value));
        } catch (cause) {
            throw new TauriParameterError(`Could not serialize native ${kind} parameters.`, {
                code: 'INVALID_TAURI_YAML',
                cause,
            });
        }
    }
    throw new TauriParameterError('The host YAML serializer is required for native additional parameters.', {
        code: 'TAURI_YAML_STRINGIFIER_REQUIRED',
    });
}

function headerEntries(parsed) {
    if (parsed === undefined) return [];
    if (Array.isArray(parsed)) {
        const entries = [];
        for (const item of parsed) {
            if (!isRecord(item)) {
                throw new TauriParameterError('Native headers must be a YAML object.', {
                    code: 'INVALID_TAURI_HEADERS',
                });
            }
            entries.push(...Object.entries(item));
        }
        return entries;
    }
    if (!isRecord(parsed)) {
        throw new TauriParameterError('Native headers must be a YAML object.', {
            code: 'INVALID_TAURI_HEADERS',
        });
    }
    return Object.entries(parsed);
}

function normalizeHeaders(parsed) {
    const map = new Map();
    for (const [name, value] of headerEntries(parsed)) {
        const key = String(name);
        const lower = key.toLowerCase();
        // Setting the same lower-case key again intentionally replaces the
        // previous spelling, yielding one deterministic header.
        map.set(lower, { name: key, value: cloneValue(value) });
    }
    return Object.fromEntries([...map.values()].map(({ name, value }) => [name, value]));
}

function bodyObject(parsed) {
    if (parsed === undefined) return {};
    if (Array.isArray(parsed)) {
        const body = {};
        for (const item of parsed) {
            if (isRecord(item)) Object.assign(body, cloneValue(item));
        }
        return body;
    }
    if (!isRecord(parsed)) {
        throw new TauriParameterError('Native body parameters must be a YAML object.', {
            code: 'INVALID_TAURI_BODY',
        });
    }
    return cloneValue(parsed);
}

function exclusionInfo(parsed) {
    if (parsed === undefined) return { keys: [], values: new Map(), kind: 'missing' };
    if (Array.isArray(parsed)) {
        const keys = [];
        const values = new Map();
        for (const key of parsed) {
            if (typeof key !== 'string') continue;
            const value = String(key);
            // Body parameter names are case-sensitive.  Preserve distinct
            // exclusions such as Foo and foo while collapsing only exact
            // duplicate entries.
            if (!values.has(value)) keys.push(value);
            values.set(value, value);
        }
        return { keys, values, kind: 'array' };
    }
    if (isRecord(parsed)) {
        const keys = Object.keys(parsed);
        return {
            keys,
            values: new Map(keys.map(key => [key, cloneValue(parsed[key])])),
            kind: 'object',
        };
    }
    if (typeof parsed === 'string') {
        return { keys: [parsed], values: new Map([[parsed, undefined]]), kind: 'string' };
    }
    throw new TauriParameterError('Native excluded body parameters must be a YAML array.', {
        code: 'INVALID_TAURI_EXCLUDE',
    });
}

function serializeExclusions(info, original, yaml) {
    if (info.kind === 'array' || (info.kind === 'missing' && Array.isArray(original))) {
        return stringifyValue(info.keys, original, yaml, 'excluded body');
    }
    if (info.kind === 'object' || (info.kind === 'missing' && isRecord(original))) {
        const object = {};
        for (const key of info.keys) object[key] = info.values.get(key);
        return stringifyValue(object, original, yaml, 'excluded body');
    }
    if (info.kind === 'string') {
        if (!info.keys.length) return '';
        return stringifyValue(info.keys.length === 1 ? info.keys[0] : info.keys, original, yaml, 'excluded body');
    }
    return stringifyValue(info.keys, original, yaml, 'excluded body');
}

function hasManagedBody(body) {
    return Object.keys(body).some(key => MANAGED_BODY_KEYS.has(key));
}

function removeManagedBody(body) {
    for (const key of Object.keys(body)) {
        if (MANAGED_BODY_KEYS.has(key)) delete body[key];
    }
}

function removeManagedHeaders(headers) {
    for (const key of Object.keys(headers)) {
        if (!MANAGED_HEADER_KEYS.has(key.toLowerCase())) continue;
        // Only the 1800 value is written by this adapter. Preserve other
        // timeout settings belonging to the user or another native feature.
        if (key.toLowerCase() === 'x-server-timeout'
            && String(headers[key]).trim() !== '1800') continue;
        delete headers[key];
    }
}

function isManagedHeader(name, value) {
    const key = String(name).toLowerCase();
    if (key === 'x-server-timeout') return String(value).trim() === '1800';
    return MANAGED_HEADER_KEYS.has(key);
}

function removeManagedExclusions(info) {
    info.keys = info.keys.filter(key => !MANAGED_EXCLUDE_KEYS.has(String(key)));
}

function setHeader(headers, name, value) {
    // normalizeHeaders already removed case-only duplicates.  Delete any
    // managed spelling before inserting the canonical spelling.
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
    }
    headers[name] = value;
}

function sourceFromData(data) {
    const source = sourceOf(data);
    return source || VERTEX_SOURCE;
}

/**
 * Return true when the supplied request/config object contains one of the
 * native adapter's managed settings.  This lets transport prefer a preset or
 * background request snapshot over the foreground UI state.
 */
export function hasTauriManagedParameters(data, { yaml } = {}) {
    if (!isRecord(data)) return false;
    const { container } = chooseContainer(data);
    const body = valueForField(container, 'body');
    const headers = valueForField(container, 'headers');
    const exclude = valueForField(container, 'exclude');
    try {
        if (body !== undefined) {
            const parsed = bodyObject(parseValue(body, yaml, 'body'));
            if (hasManagedBody(parsed)) return true;
        }
        if (headers !== undefined) {
            const parsed = normalizeHeaders(parseValue(headers, yaml, 'headers'));
            if (Object.entries(parsed).some(([key, value]) => isManagedHeader(key, value))) return true;
        }
        if (exclude !== undefined) {
            const parsed = exclusionInfo(parseValue(exclude, yaml, 'excluded body'));
            if (parsed.keys.some(key => MANAGED_EXCLUDE_KEYS.has(String(key)))) return true;
        }
    } catch {
        // Invalid data is still handled by applyTauriParameters at the final
        // fetch boundary.  This helper only chooses state precedence.
    }
    return false;
}

/**
 * Return true only when the request carries an explicit tier/paygo value.
 * An exclusion of service_tier is a conflict candidate, but by itself does
 * not say whether the request intended Standard or Flex.
 */
export function hasExplicitTauriState(data, { yaml } = {}) {
    if (!isRecord(data)) return false;
    const { container } = chooseContainer(data);
    const body = bodyObject(parseValue(valueForField(container, 'body'), yaml, 'body'));
    const headers = normalizeHeaders(parseValue(valueForField(container, 'headers'), yaml, 'headers'));
    if (Object.hasOwn(body, 'service_tier')) return true;
    return Object.entries(headers).some(([key, value]) => {
        const lower = key.toLowerCase();
        return lower === 'x-vertex-ai-llm-request-type'
            || lower === 'x-vertex-ai-llm-shared-request-type';
    });
}

/**
 * A host-generated request includes the three custom fields even when each is
 * empty.  That empty snapshot is an explicit native Standard selection and
 * must take precedence over a legacy extension state carried by an old
 * preset/profile.
 */
export function hasTauriParameterSnapshot(data, { yaml } = {}) {
    if (!isRecord(data)) return false;
    const { container } = chooseContainer(data);
    // Managed tier values are authoritative even when unrelated native
    // settings share the same YAML fields.  Exclusions are deliberately
    // omitted: excluding service_tier is a conflict candidate, but does not
    // tell us whether the caller selected Standard or Flex.  For Standard,
    // the UI's all-empty native snapshot is the only value that can
    // distinguish an intentional native reset from an old extension state;
    // arbitrary temperature/header values alone remain eligible for the
    // caller's existing state resolution.
    try {
        const body = bodyObject(parseValue(valueForField(container, 'body'), yaml, 'body'));
        if (hasManagedBody(body)) return true;
        const headers = normalizeHeaders(parseValue(valueForField(container, 'headers'), yaml, 'headers'));
        if (Object.entries(headers).some(([key, value]) => isManagedHeader(key, value))) return true;
    } catch {
        // Invalid strings are rejected by read/apply at the final boundary.
    }
    const ownValues = Object.values(REQUEST_FIELD_NAMES).map(names => {
        const values = names.filter(name => Object.hasOwn(container, name)).map(name => container[name]);
        return values.length ? values : null;
    });
    if (ownValues.some(values => values === null)) return false;
    return ownValues.flat().every(value => value === undefined || value === null
        || (typeof value === 'string' && value.trim() === ''));
}

/**
 * Infer the adapter state already represented by native additional params.
 * The result is deliberately independent from the active UI state.
 */
export function readTauriState(data, { yaml } = {}) {
    const normalized = { ...DEFAULT_STATE };
    if (!isRecord(data)) return normalized;
    const source = sourceFromData(data);
    const { container } = chooseContainer(data);
    const bodyRaw = valueForField(container, 'body');
    const headersRaw = valueForField(container, 'headers');
    const body = bodyObject(parseValue(bodyRaw, yaml, 'body'));
    const headers = normalizeHeaders(parseValue(headersRaw, yaml, 'headers'));
    const getHeader = name => {
        const wanted = name.toLowerCase();
        const key = Object.keys(headers).find(item => item.toLowerCase() === wanted);
        return key === undefined ? undefined : headers[key];
    };

    const shared = String(getHeader('X-Vertex-AI-LLM-Shared-Request-Type') ?? '').trim().toLowerCase();
    const requestType = String(getHeader('X-Vertex-AI-LLM-Request-Type') ?? '').trim().toLowerCase();
    if (shared && ![TIER.STANDARD, TIER.FLEX, TIER.PRIORITY].includes(shared)) {
        throw new TauriParameterError(`Unsupported native shared request type: ${shared}`, {
            code: 'TAURI_UNKNOWN_SHARED_REQUEST_TYPE',
        });
    }
    if (requestType && requestType !== 'shared') {
        throw new TauriParameterError(`Unsupported native request type: ${requestType}`, {
            code: 'TAURI_UNKNOWN_REQUEST_TYPE',
        });
    }
    const hasServiceTier = Object.hasOwn(body, 'service_tier');
    const serviceTier = String(body.service_tier ?? '').trim().toLowerCase();
    if (hasServiceTier && !['', TIER.STANDARD, TIER.FLEX].includes(serviceTier)) {
        throw new TauriParameterError(`Unsupported native service_tier: ${serviceTier}`, {
            code: 'TAURI_UNKNOWN_SERVICE_TIER',
        });
    }

    if (source === AI_STUDIO_SOURCE || (!sourceOf(data) && serviceTier)) {
        normalized.tier = serviceTier === TIER.FLEX ? TIER.FLEX : TIER.STANDARD;
        normalized.paygoOnly = false;
    } else if (source === VERTEX_SOURCE || !sourceOf(data)) {
        normalized.tier = shared === TIER.FLEX || shared === TIER.PRIORITY ? shared : TIER.STANDARD;
        normalized.paygoOnly = requestType === 'shared';
    }
    return normalizeState(normalized);
}

/**
 * Apply the native request policy while retaining every unrelated parameter.
 * `data` can be a generation payload (`custom_*` fields), a Tauri native
 * `parameters` wrapper, or one persistent `include_*` settings entry.
 */
export function applyTauriParameters(data, state, { yaml } = {}) {
    if (!isRecord(data)) throw new TypeError('Tauri generation parameters must be an object.');
    const output = { ...data };
    if (isRecord(data.parameters)) output.parameters = { ...data.parameters };
    const { container: sourceContainer, nested } = chooseContainer(data);
    const container = nested ? output.parameters : output;
    const storage = isStorageEntry(data, sourceContainer, nested);
    const source = sourceFromData(data);
    const current = normalizeState(state);
    if (source === AI_STUDIO_SOURCE) current.paygoOnly = false;
    const bodyFieldNames = writeFieldNames(sourceContainer, 'body', { storage });
    const excludeFieldNames = writeFieldNames(sourceContainer, 'exclude', { storage });
    const headerFieldNames = writeFieldNames(sourceContainer, 'headers', { storage });
    const bodyOriginal = valueForField(sourceContainer, 'body');
    const excludeOriginal = valueForField(sourceContainer, 'exclude');
    const headersOriginal = valueForField(sourceContainer, 'headers');

    const body = bodyObject(parseValue(bodyOriginal, yaml, 'body'));
    const headers = normalizeHeaders(parseValue(headersOriginal, yaml, 'headers'));
    const exclusions = exclusionInfo(parseValue(excludeOriginal, yaml, 'excluded body'));
    const existingHeaderValue = name => {
        const wanted = name.toLowerCase();
        const key = Object.keys(headers).find(item => item.toLowerCase() === wanted);
        return key === undefined ? undefined : headers[key];
    };
    const shared = String(existingHeaderValue('X-Vertex-AI-LLM-Shared-Request-Type') ?? '').trim().toLowerCase();
    const requestType = String(existingHeaderValue('X-Vertex-AI-LLM-Request-Type') ?? '').trim().toLowerCase();
    if (shared && ![TIER.STANDARD, TIER.FLEX, TIER.PRIORITY].includes(shared)) {
        throw new TauriParameterError(`Unsupported native shared request type: ${shared}`, {
            code: 'TAURI_UNKNOWN_SHARED_REQUEST_TYPE',
        });
    }
    if (requestType && requestType !== 'shared') {
        throw new TauriParameterError(`Unsupported native request type: ${requestType}`, {
            code: 'TAURI_UNKNOWN_REQUEST_TYPE',
        });
    }
    if (Object.hasOwn(body, 'service_tier')) {
        const value = String(body.service_tier ?? '').trim().toLowerCase();
        if (!['', TIER.STANDARD, TIER.FLEX].includes(value)) {
            throw new TauriParameterError(`Unsupported native service_tier: ${value}`, {
                code: 'TAURI_UNKNOWN_SERVICE_TIER',
            });
        }
    }

    // First remove all values owned by this adapter.  This also strips stale
    // Vertex headers when a saved source/preset is switched to AI Studio, and
    // strips service_tier when a Gemini source is switched back to Standard.
    removeManagedBody(body);
    removeManagedHeaders(headers);
    removeManagedExclusions(exclusions);

    if (source === VERTEX_SOURCE) {
        if (current.paygoOnly) setHeader(headers, 'X-Vertex-AI-LLM-Request-Type', 'shared');
        if (current.tier === TIER.FLEX || current.tier === TIER.PRIORITY) {
            setHeader(headers, 'X-Vertex-AI-LLM-Shared-Request-Type', current.tier);
        }
        if (current.tier === TIER.FLEX) setHeader(headers, 'X-Server-Timeout', '1800');
    } else if (source === AI_STUDIO_SOURCE && current.tier === TIER.FLEX) {
        // The Tauri makersuite adapter consumes this body field.  An existing
        // exclusion would run after include-body merging and silently remove
        // it, so fail before the request can reach Rust.
        const rawExclusions = exclusionInfo(parseValue(excludeOriginal, yaml, 'excluded body'));
        if (rawExclusions.keys.some(key => MANAGED_EXCLUDE_KEYS.has(String(key)))) {
            throw new TauriParameterError('Native AI Studio Flex conflicts with an excluded service_tier field.', {
                code: 'TAURI_EXCLUDE_CONFLICT',
            });
        }
        body.service_tier = TIER.FLEX;
        setHeader(headers, 'X-Server-Timeout', '1800');
    }

    const bodyValue = stringifyValue(body, bodyOriginal, yaml, 'body');
    const headerValue = stringifyValue(headers, headersOriginal, yaml, 'headers');
    const excludeValue = serializeExclusions(exclusions, excludeOriginal, yaml);
    for (const name of bodyFieldNames) container[name] = cloneValue(bodyValue);
    for (const name of excludeFieldNames) container[name] = cloneValue(excludeValue);
    for (const name of headerFieldNames) container[name] = cloneValue(headerValue);
    return output;
}

// These aliases make the intent discoverable to callers without forcing them
// to know whether a request uses the `custom_*` or persistent `include_*` form.
export const getTauriState = readTauriState;
export const applyNativeTauriParameters = applyTauriParameters;
