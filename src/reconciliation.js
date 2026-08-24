import { VERTEX_SOURCE } from './constants.js';
import { normalizeState, requiresPlugin, validatePluginState } from './state-machine.js';

export function planPersistedReconciliation({ state, source, model, region }) {
    const current = normalizeState(state);
    if (source !== VERTEX_SOURCE) {
        return { type: 'skip', code: 'SOURCE_NOT_VERTEX', state: current };
    }

    if (!requiresPlugin(current)) {
        return { type: 'skip', code: 'PLUGIN_NOT_REQUIRED', state: current };
    }

    const modelId = typeof model === 'string' ? model.trim() : '';
    if (!modelId) {
        return { type: 'defer', code: 'MODEL_UNRESOLVED', state: current };
    }

    const validation = validatePluginState({ state: current, model: modelId, region });
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
