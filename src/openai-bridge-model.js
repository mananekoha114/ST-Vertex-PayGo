/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

import { AI_STUDIO_SOURCE, VERTEX_SOURCE } from './constants.js';

const MODEL_PATTERN = /^(?:google\/)?gemini-[a-z0-9][a-z0-9._-]*$/u;
const REGION_PATTERN = /^(?:global|[a-z0-9][a-z0-9-]{0,62})$/u;
const SECRET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export function isValidBridgeConnection(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (Object.keys(value).some(key => !['source', 'model', 'authMode', 'region', 'secretId'].includes(key))) return false;
    if (![AI_STUDIO_SOURCE, VERTEX_SOURCE].includes(value.source)
        || typeof value.model !== 'string' || !MODEL_PATTERN.test(value.model)) return false;
    if (value.secretId !== undefined && (typeof value.secretId !== 'string' || !SECRET_ID_PATTERN.test(value.secretId))) return false;
    if (value.source === VERTEX_SOURCE) {
        return value.authMode === 'full' && typeof value.region === 'string' && REGION_PATTERN.test(value.region);
    }
    return value.authMode === undefined && value.region === undefined;
}

export function currentBridgeConnection(context, documentRef = globalThis.document) {
    const settings = context?.chatCompletionSettings ?? {};
    const source = settings.chat_completion_source;
    if (source !== AI_STUDIO_SOURCE && source !== VERTEX_SOURCE) {
        return { ok: false, code: 'source' };
    }
    const selectedProfileId = context?.extensionSettings?.connectionManager?.selectedProfile;
    const profile = context?.extensionSettings?.connectionManager?.profiles?.find(
        item => item?.id === selectedProfileId && item?.mode === 'cc' && item?.api === source,
    );
    const reverseProxy = String(settings.reverse_proxy || settings[`${source}_reverse_proxy`]
        || profile?.reverse_proxy || profile?.reverseProxy || '').trim();
    if (reverseProxy) return { ok: false, code: 'proxy' };
    const input = documentRef?.getElementById?.('vertexai_model_id');
    const model = source === AI_STUDIO_SOURCE
        ? String(settings.google_model ?? documentRef?.getElementById?.('model_google_select')?.value ?? '').trim()
        : String(input?.value || settings.vertexai_model
            || (profile && !profile.exclude?.includes('model') ? profile.model : '')
            || documentRef?.getElementById?.('model_vertexai_select')?.value || '').trim();
    if (!model) return { ok: false, code: 'model' };
    if (!MODEL_PATTERN.test(model)) return { ok: false, code: 'model' };
    const connection = { source, model };
    if (source === VERTEX_SOURCE) {
        const authMode = String(settings.vertexai_auth_mode ?? documentRef?.getElementById?.('vertexai_auth_mode')?.value ?? 'express').trim().toLowerCase();
        if (authMode !== 'full') return { ok: false, code: 'express' };
        connection.authMode = 'full';
        connection.region = String(settings.vertexai_region ?? documentRef?.getElementById?.('vertexai_region')?.value ?? 'us-central1').trim();
        if (!REGION_PATTERN.test(connection.region)) return { ok: false, code: 'region' };
    }
    return { ok: true, connection };
}

export function validateBridgeState(data) {
    if (data?.ok !== true || typeof data.enabled !== 'boolean' || data.model !== 'st-current') return false;
    if (data.debugLocalAccess !== undefined && typeof data.debugLocalAccess !== 'boolean') return false;
    if (!data.enabled && data.debugLocalAccess === true) return false;
    if (data.mode !== undefined && !['openai', 'gemini'].includes(data.mode)) return false;
    if (data.tierSource !== undefined && !['independent', 'follow'].includes(data.tierSource)) return false;
    if (data.tier !== undefined && !['standard', 'flex', 'priority'].includes(data.tier)) return false;
    if (data.effectiveTier !== undefined && data.effectiveTier !== null
        && !['standard', 'flex', 'priority'].includes(data.effectiveTier)) return false;
    if (data.tierError !== undefined && data.tierError !== null
        && typeof data.tierError !== 'string') return false;
    if (!data.enabled) return data.baseUrl === null && data.apiKey === null && data.connection === null;
    try {
        const url = new URL(data.baseUrl);
        return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port)
            && !url.username && !url.password
            && url.pathname === '/openai/v1' && !url.search && !url.hash
            && typeof data.apiKey === 'string' && data.apiKey.length >= 16
            && isValidBridgeConnection(data.connection);
    } catch {
        return false;
    }
}
