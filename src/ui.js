import { DEFAULT_STATE, TIER, VERTEX_SOURCE } from './constants.js';
import { getModelPolicy, getTierSupport } from './model-policy.js';
import {
    attachStateToProfile,
    normalizeImportedPreset,
    normalizeExportedPreset,
    readPersistedState,
    writeActiveProfileRegion,
    writePersistedState,
} from './persistence.js';
import {
    normalizeState,
    requiresPlugin,
    resolveModelChange,
    resolveRegionChange,
    resolveTierSelection,
    validatePluginState,
} from './state-machine.js';

const TIER_LABEL = Object.freeze({
    [TIER.STANDARD]: 'Standard',
    [TIER.FLEX]: 'Flex',
    [TIER.PRIORITY]: 'Priority',
});

function createElement(tag, attributes = {}, text = '') {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
        if (name === 'class') {
            element.className = value;
        } else {
            element.setAttribute(name, value);
        }
    }
    if (text) {
        element.textContent = text;
    }
    return element;
}

function buildControls() {
    const root = createElement('section', { id: 'vertex-paygo-settings', class: 'vertex-paygo-settings' });
    root.append(createElement('h4', {}, 'Vertex AI PayGo'));

    const tierRow = createElement('div', { class: 'vertex-paygo-row flex-container' });
    const tierLabel = createElement('label', { for: 'vertex-paygo-tier' }, 'Service tier:');
    const tierSelect = createElement('select', { id: 'vertex-paygo-tier', class: 'text_pole' });
    for (const tier of Object.values(TIER)) {
        tierSelect.append(createElement('option', { value: tier }, TIER_LABEL[tier]));
    }
    tierRow.append(tierLabel, tierSelect);

    const paygoLabel = createElement('label', { class: 'checkbox_label vertex-paygo-only' });
    const paygoOnly = createElement('input', { id: 'vertex-paygo-only', type: 'checkbox' });
    paygoLabel.append(paygoOnly, document.createTextNode(' Use PayGo only (bypass Provisioned Throughput)'));

    const guidance = createElement(
        'small',
        { class: 'vertex-paygo-guidance' },
        'Flex may add significant latency and is intended for non-real-time work. Flex and Priority currently require the global endpoint.',
    );
    const policyStatus = createElement('small', { class: 'vertex-paygo-status', 'aria-live': 'polite' });

    const serverRow = createElement('div', { class: 'vertex-paygo-server-row' });
    const serverStatus = createElement('small', { class: 'vertex-paygo-server-status', 'aria-live': 'polite' }, 'Server Plugin: checking…');
    const retryButton = createElement('button', { type: 'button', class: 'menu_button vertex-paygo-retry' }, 'Retry');
    serverRow.append(serverStatus, retryButton);

    root.append(tierRow, paygoLabel, guidance, policyStatus, serverRow);
    return { root, tierSelect, paygoOnly, policyStatus, serverStatus, retryButton };
}

export function createPayGoUi({ context, serverClient, notifyError = () => {}, notifyWarning = () => {} }) {
    const regionInput = document.getElementById('vertexai_region');
    const modelSelect = document.getElementById('model_vertexai_select');
    if (!(regionInput instanceof HTMLInputElement) || !(modelSelect instanceof HTMLSelectElement)) {
        throw new Error('SillyTavern Vertex AI controls were not found.');
    }

    const controls = buildControls();
    const regionContainer = regionInput.closest('.flex-container.flexFlowColumn') ?? regionInput.parentElement;
    regionContainer.after(controls.root);

    let state = readPersistedState(context);
    let lastModel = String(context.chatCompletionSettings.vertexai_model || modelSelect.value || '');
    let transitionPending = false;
    let revertingModel = false;
    let healthState = { status: 'checking', message: 'Server Plugin: checking…' };
    let reconcileSequence = 0;

    const popup = context.Popup;
    const popupResult = context.POPUP_RESULT;

    function getModel() {
        return String(context.chatCompletionSettings.vertexai_model || modelSelect.value || '');
    }

    function getRegion() {
        return String(context.chatCompletionSettings.vertexai_region || regionInput.value || 'us-central1');
    }

    function isVertexSelected() {
        return context.chatCompletionSettings.chat_completion_source === VERTEX_SOURCE;
    }

    function applyState(nextState, { persist = true } = {}) {
        state = normalizeState(nextState);
        if (persist) {
            void Promise.resolve(writePersistedState(context, state)).catch(error => {
                notifyError(`Could not persist the PayGo setting: ${error instanceof Error ? error.message : String(error)}`);
            });
        }
        render();
        return state;
    }

    function setRegion(region, { updateProfile = true } = {}) {
        regionInput.value = region;
        regionInput.dispatchEvent(new Event('input', { bubbles: true }));
        if (updateProfile) {
            writeActiveProfileRegion(context, region);
        }
    }

    function renderPolicyStatus(policy) {
        controls.policyStatus.classList.remove('vertex-paygo-status--warning', 'vertex-paygo-status--error');

        if (!policy.isGemini) {
            controls.policyStatus.textContent = 'PayGo routing is excluded for non-Gemini Vertex models.';
            controls.policyStatus.classList.add('vertex-paygo-status--error');
            return;
        }

        const support = state.tier === TIER.STANDARD ? null : getTierSupport(policy.model, state.tier);
        if (support?.level === 'unverified') {
            controls.policyStatus.textContent = support.reason;
            controls.policyStatus.classList.add('vertex-paygo-status--warning');
            return;
        }

        const validation = validatePluginState({ state, model: policy.model, region: getRegion() });
        if (!validation.ok) {
            controls.policyStatus.textContent = `Blocked: ${validation.message}`;
            controls.policyStatus.classList.add('vertex-paygo-status--error');
            return;
        }

        if (state.tier === TIER.STANDARD && !state.paygoOnly) {
            controls.policyStatus.textContent = 'Native Standard route; the Server Plugin is not used.';
        } else if (state.tier === TIER.STANDARD) {
            controls.policyStatus.textContent = 'Standard PayGo-only routing will bypass Provisioned Throughput.';
        } else {
            controls.policyStatus.textContent = `${TIER_LABEL[state.tier]} PayGo will use the global endpoint.`;
        }
    }

    function render() {
        const policy = getModelPolicy(getModel());
        controls.tierSelect.value = state.tier;
        controls.paygoOnly.checked = state.paygoOnly;
        // A stale invalid value must remain switchable off even when the new
        // model is not Gemini.
        controls.paygoOnly.disabled = (!policy.isGemini && !state.paygoOnly) || transitionPending;
        controls.tierSelect.disabled = transitionPending;

        const flexOption = controls.tierSelect.querySelector(`option[value="${TIER.FLEX}"]`);
        const priorityOption = controls.tierSelect.querySelector(`option[value="${TIER.PRIORITY}"]`);
        flexOption.disabled = !policy.flex.allowed;
        flexOption.title = policy.flex.reason;
        priorityOption.disabled = !policy.priority.allowed;
        priorityOption.title = policy.priority.reason;

        controls.root.dataset.active = String(isVertexSelected());
        controls.root.dataset.serverStatus = healthState.status;
        controls.serverStatus.textContent = healthState.message;
        controls.serverStatus.title = healthState.detail || '';
        controls.retryButton.disabled = healthState.status === 'checking';
        renderPolicyStatus(policy);
    }

    async function showTierRegionConflict(tier, decision) {
        return await popup.show.confirm(
            `${TIER_LABEL[tier]} PayGo requires global`,
            `The current Vertex AI region is “${decision.decline.region}”. Choose whether to switch both the service tier and region, or keep the current region with Standard.`,
            {
                okButton: `Use ${TIER_LABEL[tier]} and global`,
                cancelButton: 'Keep region and Standard',
                defaultResult: popupResult.NEGATIVE,
            },
        );
    }

    async function onTierChanged() {
        if (transitionPending) return;
        const requestedTier = controls.tierSelect.value;
        const decision = resolveTierSelection({ state, requestedTier, region: getRegion(), model: getModel() });

        if (decision.type === 'reject') {
            notifyError(decision.support.reason);
            render();
            return;
        }

        if (decision.type === 'apply') {
            applyState(decision.state);
            return;
        }

        transitionPending = true;
        render();
        try {
            const result = await showTierRegionConflict(requestedTier, decision);
            const selected = result === popupResult.AFFIRMATIVE ? decision.accept : decision.decline;
            if (selected.region !== getRegion()) {
                setRegion(selected.region);
            }
            applyState(selected.state);
        } finally {
            transitionPending = false;
            render();
        }
    }

    function onPaygoOnlyChanged() {
        const policy = getModelPolicy(getModel());
        if (!policy.isGemini && controls.paygoOnly.checked) {
            notifyError('PayGo-only routing is available only for Gemini models.');
            controls.paygoOnly.checked = false;
            return;
        }
        applyState({ ...state, paygoOnly: controls.paygoOnly.checked });
    }

    async function onRegionChanged() {
        if (transitionPending || !isVertexSelected()) return;
        const decision = resolveRegionChange({ state, requestedRegion: regionInput.value });
        if (decision.type === 'apply') {
            render();
            return;
        }

        transitionPending = true;
        render();
        try {
            const result = await popup.show.confirm(
                'Regional endpoints use Standard',
                `${TIER_LABEL[state.tier]} PayGo currently requires global. Keep the new region with Standard, or keep global with the current tier.`,
                {
                    okButton: 'Use new region and Standard',
                    cancelButton: `Keep global and ${TIER_LABEL[state.tier]}`,
                    defaultResult: popupResult.NEGATIVE,
                },
            );
            const selected = result === popupResult.AFFIRMATIVE ? decision.accept : decision.decline;
            if (selected.region !== getRegion()) {
                setRegion(selected.region);
            } else {
                writeActiveProfileRegion(context, selected.region);
            }
            applyState(selected.state);
        } finally {
            transitionPending = false;
            render();
        }
    }

    async function onModelChanged(model) {
        const nextModel = String(model ?? getModel());
        if (!isVertexSelected()) {
            render();
            return;
        }

        if (revertingModel) {
            revertingModel = false;
            lastModel = nextModel;
            render();
            return;
        }

        const previousModel = lastModel;
        lastModel = nextModel;
        const decision = resolveModelChange({ state, model: nextModel });
        if (decision.type === 'apply') {
            render();
            return;
        }

        transitionPending = true;
        render();
        try {
            const reason = decision.code === 'PAYGO_REQUIRES_GEMINI'
                ? 'PayGo routing is restricted to Gemini models.'
                : decision.support?.reason || 'The selected model does not support this PayGo tier.';
            const result = await popup.show.confirm(
                'Model and PayGo tier conflict',
                `${reason} Use the new model with native Standard, or restore the previous model and keep the PayGo setting.`,
                {
                    okButton: 'Use new model and Standard',
                    cancelButton: 'Restore previous model',
                    defaultResult: popupResult.NEGATIVE,
                },
            );

            if (result === popupResult.AFFIRMATIVE || !previousModel || previousModel === nextModel) {
                applyState(decision.accept.state);
            } else {
                revertingModel = true;
                lastModel = previousModel;
                modelSelect.value = previousModel;
                modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } finally {
            transitionPending = false;
            render();
        }
    }

    async function refreshHealth() {
        healthState = { status: 'checking', message: 'Server Plugin: checking…' };
        render();
        try {
            const health = await serverClient.checkHealth();
            const version = health.pluginVersion ? ` ${health.pluginVersion}` : '';
            healthState = { status: 'ready', message: `Server Plugin${version}: ready`, detail: 'Protocol v1, loopback HTTP transport' };
        } catch (error) {
            healthState = {
                status: 'unavailable',
                message: 'Server Plugin: unavailable',
                detail: error instanceof Error ? error.message : String(error),
            };
        }
        render();
        return healthState;
    }

    async function reconcilePersistedState() {
        const sequence = ++reconcileSequence;
        state = readPersistedState(context);
        lastModel = getModel();
        render();
        if (!requiresPlugin(state) || transitionPending) return;

        const validation = validatePluginState({ state, model: getModel(), region: getRegion() });
        if (validation.ok || sequence !== reconcileSequence) return;

        if (validation.code === 'TIER_REQUIRES_GLOBAL') {
            const decision = resolveTierSelection({ state, requestedTier: state.tier, region: getRegion(), model: getModel() });
            if (decision.type === 'conflict') {
                transitionPending = true;
                render();
                try {
                    const result = await showTierRegionConflict(state.tier, decision);
                    if (sequence !== reconcileSequence) return;
                    const selected = result === popupResult.AFFIRMATIVE ? decision.accept : decision.decline;
                    if (selected.region !== getRegion()) setRegion(selected.region);
                    applyState(selected.state);
                } finally {
                    transitionPending = false;
                    render();
                }
            }
            return;
        }

        transitionPending = true;
        render();
        try {
            const result = await popup.show.confirm(
                'Saved PayGo setting is incompatible',
                `${validation.message} Switch this connection to native Standard, or keep the saved setting blocked until you change the model.`,
                {
                    okButton: 'Use Standard',
                    cancelButton: 'Keep blocked setting',
                    defaultResult: popupResult.NEGATIVE,
                },
            );
            if (sequence === reconcileSequence && result === popupResult.AFFIRMATIVE) {
                applyState({ ...DEFAULT_STATE });
            }
        } finally {
            transitionPending = false;
            render();
        }
    }

    controls.tierSelect.addEventListener('change', onTierChanged);
    controls.paygoOnly.addEventListener('change', onPaygoOnlyChanged);
    regionInput.addEventListener('change', onRegionChanged);
    controls.retryButton.addEventListener('click', refreshHealth);

    const events = context.eventTypes;
    context.eventSource.on(events.CHATCOMPLETION_SOURCE_CHANGED, () => {
        lastModel = getModel();
        render();
    });
    context.eventSource.on(events.CHATCOMPLETION_MODEL_CHANGED, onModelChanged);
    context.eventSource.on(events.OAI_PRESET_CHANGED_AFTER, reconcilePersistedState);
    context.eventSource.on(events.OAI_PRESET_IMPORT_READY, normalizeImportedPreset);
    context.eventSource.on(events.OAI_PRESET_EXPORT_READY, normalizeExportedPreset);
    context.eventSource.on(events.CONNECTION_PROFILE_CREATED, profile => {
        if (profile?.mode === 'cc' && profile?.api === VERTEX_SOURCE) {
            attachStateToProfile(profile, state);
            // Connection Manager emitted CREATED after its first save.
            context.saveSettingsDebounced();
        }
    });
    context.eventSource.on(events.CONNECTION_PROFILE_LOADED, reconcilePersistedState);
    context.eventSource.on(events.CONNECTION_PROFILE_UPDATED, (_oldProfile, newProfile) => {
        if (newProfile?.mode === 'cc' && newProfile?.api === VERTEX_SOURCE && !Object.hasOwn(newProfile, 'vertex-paygo')) {
            attachStateToProfile(newProfile, state);
            context.saveSettingsDebounced();
        }
    });

    render();
    void reconcilePersistedState();
    void refreshHealth();

    return {
        getState: () => ({ ...state }),
        refreshHealth,
        render,
    };
}
