import { DEFAULT_STATE, TIER, VERTEX_SOURCE } from './constants.js';
import {
    createLocalizer,
    getTierLabel,
    localizeError,
    localizeSupport,
    localizeValidation,
} from './i18n.js';
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

function buildControls(localize) {
    const root = createElement('section', { id: 'vertex-paygo-settings', class: 'vertex-paygo-settings' });
    root.append(createElement('h4', { 'data-i18n': 'vertex_paygo.title' }, localize('vertex_paygo.title')));

    const tierRow = createElement('div', { class: 'vertex-paygo-row flex-container' });
    const tierLabel = createElement(
        'label',
        { for: 'vertex-paygo-tier', 'data-i18n': 'vertex_paygo.service_tier' },
        localize('vertex_paygo.service_tier'),
    );
    const tierSelect = createElement('select', { id: 'vertex-paygo-tier', class: 'text_pole' });
    for (const tier of Object.values(TIER)) {
        const key = `vertex_paygo.tier.${tier}`;
        tierSelect.append(createElement('option', { value: tier, 'data-i18n': key }, localize(key)));
    }
    tierRow.append(tierLabel, tierSelect);

    const paygoLabel = createElement('label', { class: 'checkbox_label vertex-paygo-only' });
    const paygoOnly = createElement('input', { id: 'vertex-paygo-only', type: 'checkbox' });
    const paygoText = createElement(
        'span',
        { 'data-i18n': 'vertex_paygo.paygo_only' },
        localize('vertex_paygo.paygo_only'),
    );
    paygoLabel.append(paygoOnly, paygoText);

    const guidance = createElement(
        'small',
        { class: 'vertex-paygo-guidance', 'data-i18n': 'vertex_paygo.guidance' },
        localize('vertex_paygo.guidance'),
    );
    const policyStatus = createElement('small', { class: 'vertex-paygo-status', 'aria-live': 'polite' });

    const serverRow = createElement('div', { class: 'vertex-paygo-server-row' });
    const serverStatus = createElement(
        'small',
        {
            class: 'vertex-paygo-server-status',
            'aria-live': 'polite',
        },
        localize('vertex_paygo.server.checking'),
    );
    const retryButton = createElement(
        'button',
        { type: 'button', class: 'menu_button vertex-paygo-retry', 'data-i18n': 'vertex_paygo.retry' },
        localize('vertex_paygo.retry'),
    );
    serverRow.append(serverStatus, retryButton);

    root.append(tierRow, paygoLabel, guidance, policyStatus, serverRow);
    return { root, tierSelect, paygoOnly, policyStatus, serverStatus, retryButton };
}

export function createPayGoUi({
    context,
    serverClient,
    notifyError = () => {},
    notifyWarning = () => {},
    localize,
}) {
    localize ??= createLocalizer((fallback, key) => context?.translate?.(fallback, key));
    const regionInput = document.getElementById('vertexai_region');
    const modelSelect = document.getElementById('model_vertexai_select');
    if (!(regionInput instanceof HTMLInputElement) || !(modelSelect instanceof HTMLSelectElement)) {
        throw new Error(localize('vertex_paygo.error.controls_missing'));
    }

    const controls = buildControls(localize);
    const regionContainer = regionInput.closest('.flex-container.flexFlowColumn') ?? regionInput.parentElement;
    regionContainer.after(controls.root);

    let state = readPersistedState(context);
    let lastModel = String(context.chatCompletionSettings.vertexai_model || modelSelect.value || '');
    let transitionPending = false;
    let revertingModel = false;
    let healthState = { status: 'checking', message: localize('vertex_paygo.server.checking') };
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
                notifyError(localize('vertex_paygo.error.persist', {
                    error: error instanceof Error ? error.message : String(error),
                }));
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
            controls.policyStatus.textContent = localize('vertex_paygo.status.non_gemini');
            controls.policyStatus.classList.add('vertex-paygo-status--error');
            return;
        }

        const support = state.tier === TIER.STANDARD ? null : getTierSupport(policy.model, state.tier);
        if (support?.level === 'unverified') {
            controls.policyStatus.textContent = localizeSupport(localize, support, state.tier);
            controls.policyStatus.classList.add('vertex-paygo-status--warning');
            return;
        }

        const validation = validatePluginState({ state, model: policy.model, region: getRegion() });
        if (!validation.ok) {
            controls.policyStatus.textContent = localize('vertex_paygo.status.blocked', {
                message: localizeValidation(localize, validation, state),
            });
            controls.policyStatus.classList.add('vertex-paygo-status--error');
            return;
        }

        if (state.tier === TIER.STANDARD && !state.paygoOnly) {
            controls.policyStatus.textContent = localize('vertex_paygo.status.native_standard');
        } else if (state.tier === TIER.STANDARD) {
            controls.policyStatus.textContent = localize('vertex_paygo.status.standard_paygo_only');
        } else {
            controls.policyStatus.textContent = localize('vertex_paygo.status.tier_global', {
                tier: getTierLabel(localize, state.tier),
            });
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
        flexOption.title = localizeSupport(localize, policy.flex, TIER.FLEX);
        priorityOption.disabled = !policy.priority.allowed;
        priorityOption.title = localizeSupport(localize, policy.priority, TIER.PRIORITY);

        controls.root.dataset.active = String(isVertexSelected());
        controls.root.dataset.serverStatus = healthState.status;
        controls.serverStatus.textContent = healthState.message;
        controls.serverStatus.title = healthState.detail || '';
        controls.retryButton.disabled = healthState.status === 'checking';
        renderPolicyStatus(policy);
    }

    async function showTierRegionConflict(tier, decision) {
        const tierLabel = getTierLabel(localize, tier);
        return await popup.show.confirm(
            localize('vertex_paygo.popup.tier_region.title', { tier: tierLabel }),
            localize('vertex_paygo.popup.tier_region.body', { region: decision.decline.region }),
            {
                okButton: localize('vertex_paygo.popup.tier_region.accept', { tier: tierLabel }),
                cancelButton: localize('vertex_paygo.popup.tier_region.decline'),
                defaultResult: popupResult.NEGATIVE,
            },
        );
    }

    async function onTierChanged() {
        if (transitionPending) return;
        const requestedTier = controls.tierSelect.value;
        const decision = resolveTierSelection({ state, requestedTier, region: getRegion(), model: getModel() });

        if (decision.type === 'reject') {
            notifyError(localizeSupport(localize, decision.support, requestedTier));
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
            notifyError(localize('vertex_paygo.error.paygo_only_gemini'));
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
            const tierLabel = getTierLabel(localize, state.tier);
            const result = await popup.show.confirm(
                localize('vertex_paygo.popup.region.title'),
                localize('vertex_paygo.popup.region.body', { tier: tierLabel }),
                {
                    okButton: localize('vertex_paygo.popup.region.accept'),
                    cancelButton: localize('vertex_paygo.popup.region.decline', { tier: tierLabel }),
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
                ? localize('vertex_paygo.popup.model.reason_gemini')
                : localize('vertex_paygo.popup.model.reason_unsupported');
            const result = await popup.show.confirm(
                localize('vertex_paygo.popup.model.title'),
                localize('vertex_paygo.popup.model.body', { reason }),
                {
                    okButton: localize('vertex_paygo.popup.model.accept'),
                    cancelButton: localize('vertex_paygo.popup.model.decline'),
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
        healthState = { status: 'checking', message: localize('vertex_paygo.server.checking') };
        render();
        try {
            const health = await serverClient.checkHealth();
            const version = health.pluginVersion ? ` ${health.pluginVersion}` : '';
            healthState = {
                status: 'ready',
                message: localize('vertex_paygo.server.ready', { version }),
                detail: localize('vertex_paygo.server.ready_detail'),
            };
        } catch (error) {
            healthState = {
                status: 'unavailable',
                message: localize('vertex_paygo.server.unavailable'),
                detail: localizeError(localize, error),
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
            const validationMessage = localizeValidation(localize, validation, state);
            const result = await popup.show.confirm(
                localize('vertex_paygo.popup.saved.title'),
                localize('vertex_paygo.popup.saved.body', { message: validationMessage }),
                {
                    okButton: localize('vertex_paygo.popup.saved.accept'),
                    cancelButton: localize('vertex_paygo.popup.saved.decline'),
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
