/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PROTOCOL_VERSION, REQUIRED_TRANSPORT } from './constants.js';
import { MODEL_POLICY_SNAPSHOT } from './model-policy.js';

export const MESSAGES = Object.freeze({
    'vertex_paygo.title': 'Vertex AI PayGo',
    'vertex_paygo.service_tier': 'Service tier:',
    'vertex_paygo.tier.standard': 'Standard',
    'vertex_paygo.tier.flex': 'Flex',
    'vertex_paygo.tier.priority': 'Priority',
    'vertex_paygo.paygo_only': 'Use PayGo only (bypass Provisioned Throughput)',
    'vertex_paygo.guidance': 'Flex may add significant latency and is intended for non-real-time work. Flex and Priority currently require the global endpoint.',
    'vertex_paygo.server.checking': 'Server Plugin: checking…',
    'vertex_paygo.server.ready': 'Server Plugin{version}: ready',
    'vertex_paygo.server.ready_detail': 'Protocol v1, loopback HTTP transport',
    'vertex_paygo.server.unavailable': 'Server Plugin: unavailable',
    'vertex_paygo.retry': 'Retry',
    'vertex_paygo.status.model_unresolved': 'Waiting for SillyTavern to load the Vertex AI model.',
    'vertex_paygo.status.non_gemini': 'PayGo routing is excluded for non-Gemini Vertex models.',
    'vertex_paygo.status.blocked': 'Blocked: {message}',
    'vertex_paygo.status.native_standard': 'Native Standard route; the Server Plugin is not used.',
    'vertex_paygo.status.standard_paygo_only': 'Standard PayGo-only routing will bypass Provisioned Throughput.',
    'vertex_paygo.status.tier_global': '{tier} PayGo will use the global endpoint.',
    'vertex_paygo.error.persist': 'Could not persist the PayGo setting: {error}',
    'vertex_paygo.error.controls_missing': 'SillyTavern Vertex AI controls were not found.',
    'vertex_paygo.error.controls_timeout': 'Timed out waiting for SillyTavern Vertex AI controls.',
    'vertex_paygo.error.context_unavailable': 'SillyTavern public extension context is unavailable.',
    'vertex_paygo.error.paygo_only_gemini': 'PayGo-only routing is available only for Gemini models.',
    'vertex_paygo.policy.gemini_only': 'PayGo tier controls are available only for native Vertex Gemini model IDs (gemini-*).',
    'vertex_paygo.policy.native_standard': 'Standard uses SillyTavern’s native Vertex AI route unless PayGo-only is enabled.',
    'vertex_paygo.policy.known': 'Supported for {tier} PayGo as of {date}.',
    'vertex_paygo.policy.unsupported': 'This model is in the {date} PayGo snapshot, but not in the {tier} list.',
    'vertex_paygo.policy.unverified': 'This Gemini model is not in the {date} snapshot; Vertex AI will perform the final validation.',
    'vertex_paygo.validation.non_gemini': 'Vertex PayGo routing was requested for a non-Gemini model.',
    'vertex_paygo.validation.global_required': '{tier} PayGo requires the global Vertex AI endpoint.',
    'vertex_paygo.popup.tier_region.title': '{tier} PayGo requires global',
    'vertex_paygo.popup.tier_region.body': 'The current Vertex AI region is “{region}”. Choose whether to switch both the service tier and region, or keep the current region with Standard.',
    'vertex_paygo.popup.tier_region.accept': 'Use {tier} and global',
    'vertex_paygo.popup.tier_region.decline': 'Keep region and Standard',
    'vertex_paygo.popup.region.title': 'Regional endpoints use Standard',
    'vertex_paygo.popup.region.body': '{tier} PayGo currently requires global. Keep the new region with Standard, or keep global with the current tier.',
    'vertex_paygo.popup.region.accept': 'Use new region and Standard',
    'vertex_paygo.popup.region.decline': 'Keep global and {tier}',
    'vertex_paygo.popup.model.reason_gemini': 'PayGo routing is restricted to Gemini models.',
    'vertex_paygo.popup.model.reason_unsupported': 'The selected model does not support this PayGo tier.',
    'vertex_paygo.popup.model.title': 'Model and PayGo tier conflict',
    'vertex_paygo.popup.model.body': '{reason} Use the new model with native Standard, or restore the previous model and keep the PayGo setting.',
    'vertex_paygo.popup.model.accept': 'Use new model and Standard',
    'vertex_paygo.popup.model.decline': 'Restore previous model',
    'vertex_paygo.popup.saved.title': 'Saved PayGo setting is incompatible',
    'vertex_paygo.popup.saved.body': '{message} Switch this connection to native Standard, or keep the saved setting blocked until you change the model.',
    'vertex_paygo.popup.saved.accept': 'Use Standard',
    'vertex_paygo.popup.saved.decline': 'Keep blocked setting',
    'vertex_paygo.hook.proxy_conflict': 'Vertex PayGo tiers are incompatible with a custom Vertex reverse proxy. Disable one of them before generating.',
    'vertex_paygo.hook.request_blocked': '{message} The request was blocked and was not sent to Vertex AI.',
    'vertex_paygo.server_error.invalid_proxy_url': 'Server Plugin returned an invalid proxy URL.',
    'vertex_paygo.server_error.unsafe_proxy_url': 'Server Plugin proxy URL is not an authenticated loopback HTTP endpoint.',
    'vertex_paygo.server_error.invalid_response': 'Server Plugin returned a non-JSON response.',
    'vertex_paygo.server_error.http': 'Server Plugin request failed: {message}',
    'vertex_paygo.server_error.timeout': 'Server Plugin request timed out.',
    'vertex_paygo.server_error.unavailable': 'Server Plugin is unavailable.',
    'vertex_paygo.server_error.protocol': 'Server Plugin protocol v{version} is required.',
    'vertex_paygo.server_error.transport': 'Server Plugin transport “{transport}” is required.',
    'vertex_paygo.server_error.ticket': 'Server Plugin ticket does not match its proxy URL.',
    'vertex_paygo.server_error.secret': 'Server Plugin returned an invalid proxy secret.',
});

export function formatMessage(message, parameters = {}) {
    return String(message).replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, name) => (
        Object.hasOwn(parameters, name) ? String(parameters[name]) : match
    ));
}

export function createLocalizer(translate = undefined) {
    const translateImpl = typeof translate === 'function' ? translate : (fallback => fallback);
    return (key, parameters = {}) => {
        const fallback = MESSAGES[key] ?? key;
        let localized = fallback;
        try {
            const translated = translateImpl(fallback, key);
            if (typeof translated === 'string' && translated.length > 0) {
                localized = translated;
            }
        } catch {
            // Localization must never prevent the extension from loading.
        }
        return formatMessage(localized, parameters);
    };
}

export function getTierLabel(localize, tier) {
    const key = `vertex_paygo.tier.${tier}`;
    return localize(key);
}

export function localizeSupport(localize, support, tier) {
    const tierLabel = getTierLabel(localize, tier);
    switch (support?.level) {
        case 'excluded':
            return localize('vertex_paygo.policy.gemini_only');
        case 'native':
            return localize('vertex_paygo.policy.native_standard');
        case 'known':
            return localize('vertex_paygo.policy.known', { tier: tierLabel, date: MODEL_POLICY_SNAPSHOT });
        case 'unsupported':
            return localize('vertex_paygo.policy.unsupported', { tier: tierLabel, date: MODEL_POLICY_SNAPSHOT });
        case 'unverified':
            return localize('vertex_paygo.policy.unverified', { date: MODEL_POLICY_SNAPSHOT });
        default:
            return String(support?.reason ?? '');
    }
}

export function localizeValidation(localize, validation, state = undefined) {
    switch (validation?.code) {
        case 'PAYGO_REQUIRES_GEMINI':
            return localize('vertex_paygo.validation.non_gemini');
        case 'MODEL_UNSUPPORTED':
            return localizeSupport(localize, validation.support, state?.tier);
        case 'TIER_REQUIRES_GLOBAL':
            return localize('vertex_paygo.validation.global_required', {
                tier: getTierLabel(localize, state?.tier),
            });
        default:
            return String(validation?.message ?? '');
    }
}

export function localizeError(
    localize,
    error,
    { protocolVersion = PROTOCOL_VERSION, transport = REQUIRED_TRANSPORT } = {},
) {
    const keyByCode = {
        INVALID_PROXY_URL: 'vertex_paygo.server_error.invalid_proxy_url',
        UNSAFE_PROXY_URL: 'vertex_paygo.server_error.unsafe_proxy_url',
        INVALID_RESPONSE: 'vertex_paygo.server_error.invalid_response',
        TIMEOUT: 'vertex_paygo.server_error.timeout',
        UNAVAILABLE: 'vertex_paygo.server_error.unavailable',
        PROTOCOL_MISMATCH: 'vertex_paygo.server_error.protocol',
        TRANSPORT_MISMATCH: 'vertex_paygo.server_error.transport',
        INVALID_PROXY_TICKET: 'vertex_paygo.server_error.ticket',
        INVALID_PROXY_SECRET: 'vertex_paygo.server_error.secret',
    };

    if (error?.code === 'HTTP_ERROR') {
        return localize('vertex_paygo.server_error.http', {
            message: error instanceof Error ? error.message : String(error),
        });
    }

    const key = keyByCode[error?.code];
    if (key) {
        return localize(key, { version: protocolVersion, transport });
    }
    return error instanceof Error ? error.message : String(error);
}
