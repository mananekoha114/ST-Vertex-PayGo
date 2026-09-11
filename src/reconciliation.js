/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { isGoogleSource } from './constants.js';
import { normalizeState, requiresPlugin, validatePluginState } from './state-machine.js';

export function planPersistedReconciliation({ state, source, model, region }) {
    const current = normalizeState(state);
    if (!isGoogleSource(source)) {
        return { type: 'skip', code: 'SOURCE_NOT_VERTEX', state: current };
    }

    if (!requiresPlugin(current, source)) {
        return { type: 'skip', code: 'PLUGIN_NOT_REQUIRED', state: current };
    }

    const modelId = typeof model === 'string' ? model.trim() : '';
    if (!modelId) {
        return { type: 'defer', code: 'MODEL_UNRESOLVED', state: current };
    }

    const validation = validatePluginState({ state: current, model: modelId, region, source });
    return validation.ok
        ? { type: 'valid', state: current, validation }
        : { type: 'conflict', state: current, validation };
}

export function createReconcileGuard() {
    let revision = 0;

    return {
        begin() {
            revision += 1;
            return revision;
        },
        invalidate() {
            revision += 1;
        },
        isCurrent(token) {
            return token === revision;
        },
        async settle(token, promise, commit = () => undefined) {
            const result = await promise;
            if (token !== revision) {
                return { status: 'stale', result };
            }

            revision += 1;
            const value = await commit(result);
            return { status: 'committed', result, value };
        },
    };
}
