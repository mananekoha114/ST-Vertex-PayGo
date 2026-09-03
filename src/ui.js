/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

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
    getActiveProfile,
    normalizeImportedPreset,
    normalizeExportedPreset,
    readPersistedState,
    writeActiveProfileRegion,
    writePersistedState,
} from './persistence.js';
import { createReconcileGuard, planPersistedReconciliation } from './reconciliation.js';
import {
    normalizeState,
    resolveModelChange,
    resolveRegionChange,
    resolveTierSelection,
    validatePluginState,
} from './state-machine.js';

const RECONCILE_STABILITY_MS = 250;
const PROFILE_TRANSITION_TIMEOUT_MS = 30_000;

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

export function resolveVertexModel({ profile, inputValue, settingsValue, selectValue } = {}) {
    const profileOwnsModel = profile?.mode === 'cc'
        && profile?.api === VERTEX_SOURCE
        && !profile?.exclude?.includes('model');
    const candidates = [
        inputValue,
        settingsValue,
        profileOwnsModel ? profile.model : '',
        selectValue,
    ];
    return candidates
        .map(value => typeof value === 'string' ? value.trim() : '')
        .find(Boolean) ?? '';
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
    const initialModelInput = document.getElementById('vertexai_model_id');
    if (!(regionInput instanceof HTMLInputElement) || !(modelSelect instanceof HTMLSelectElement)) {
        throw new Error(localize('vertex_paygo.error.controls_missing'));
    }

    const controls = buildControls(localize);
    const regionContainer = regionInput.closest('.flex-container.flexFlowColumn') ?? regionInput.parentElement;
    regionContainer.after(controls.root);

    let state = readPersistedState(context);
    let lastModel = resolveVertexModel({
        profile: getActiveProfile(context),
        inputValue: initialModelInput instanceof HTMLInputElement ? initialModelInput.value : '',
        settingsValue: context.chatCompletionSettings.vertexai_model,
        selectValue: modelSelect.value,
    });
    let transitionPending = false;
    let revertingModel = false;
    let healthState = { status: 'checking', message: localize('vertex_paygo.server.checking') };
    let appReady = false;
    let reconcileQueued = false;
    let reconcileTimer = null;
    let profileTransitionPending = false;
    let profileTransitionTimer = null;
    let profileTransitionTargetId = null;
    const reconcileGuard = createReconcileGuard();

    const popup = context.Popup;
    const popupResult = context.POPUP_RESULT;

    function getModelInput() {
        const element = document.getElementById('vertexai_model_id');
        return element instanceof HTMLInputElement ? element : null;
    }

    function getModel() {
        const modelInput = getModelInput();
        return resolveVertexModel({
            profile: getActiveProfile(context),
            inputValue: modelInput instanceof HTMLInputElement ? modelInput.value : '',
            settingsValue: context.chatCompletionSettings.vertexai_model,
            selectValue: modelSelect.value,
        });
    }

    function getRegion() {
        return String(context.chatCompletionSettings.vertexai_region || regionInput.value || 'us-central1');
    }

    function isVertexSelected() {
        return context.chatCompletionSettings.chat_completion_source === VERTEX_SOURCE;
    }

    function syncPersistedState() {
        state = readPersistedState(context);
        render();
    }

    function schedulePersistedReconciliation({ invalidate = true } = {}) {
        if (invalidate) {
            reconcileGuard.invalidate();
        }
        reconcileQueued = true;
        if (!appReady || transitionPending || profileTransitionPending) return;

        if (reconcileTimer !== null) {
            clearTimeout(reconcileTimer);
        }
        reconcileTimer = setTimeout(() => {
            reconcileTimer = null;
            if (!appReady || transitionPending || profileTransitionPending || !reconcileQueued) return;
            reconcileQueued = false;
            void reconcilePersistedState().catch(error => {
                console.error('[Vertex PayGo] Saved-state reconciliation failed.', error);
            });
        }, RECONCILE_STABILITY_MS);
    }

    function beginProfileTransition() {
        const profileSelect = document.getElementById('connection_profiles');
        const selectedProfileId = profileSelect instanceof HTMLSelectElement
            ? profileSelect.value
            : context.extensionSettings?.connectionManager?.selectedProfile;
        profileTransitionTargetId = String(selectedProfileId ?? '');
        profileTransitionPending = true;
        reconcileGuard.invalidate();
        reconcileQueued = true;
        if (reconcileTimer !== null) {
            clearTimeout(reconcileTimer);
            reconcileTimer = null;
        }
        if (profileTransitionTimer !== null) {
            clearTimeout(profileTransitionTimer);
        }
        profileTransitionTimer = setTimeout(() => {
            profileTransitionTimer = null;
            profileTransitionPending = false;
            profileTransitionTargetId = null;
            syncPersistedState();
            schedulePersistedReconciliation();
        }, PROFILE_TRANSITION_TIMEOUT_MS);
    }

    function finishProfileTransition(loadedProfileName) {
        if (profileTransitionPending && typeof loadedProfileName === 'string') {
            const manager = context.extensionSettings?.connectionManager;
            const selectedProfileId = String(manager?.selectedProfile ?? '');
            const selectedProfile = manager?.profiles?.find(profile => profile?.id === selectedProfileId);
            const expectedName = selectedProfile?.name ?? '<None>';
            if (selectedProfileId !== profileTransitionTargetId || loadedProfileName !== expectedName) {
                return;
            }
        }
        if (profileTransitionTimer !== null) {
            clearTimeout(profileTransitionTimer);
            profileTransitionTimer = null;
        }
        profileTransitionPending = false;
        profileTransitionTargetId = null;
        syncPersistedState();
        schedulePersistedReconciliation();
    }

    function finishTransition() {
        transitionPending = false;
        render();
        if (reconcileQueued) {
            schedulePersistedReconciliation({ invalidate: false });
        }
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

        if (!policy.model) {
            controls.policyStatus.textContent = localize('vertex_paygo.status.model_unresolved');
            return;
        }

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

    function commitTierRegionChoice(requestedTier, result) {
        const latestDecision = resolveTierSelection({
            state,
            requestedTier,
            region: getRegion(),
            model: getModel(),
        });

        if (result === popupResult.AFFIRMATIVE) {
            if (latestDecision.type === 'reject') {
                notifyError(localizeSupport(localize, latestDecision.support, requestedTier));
                render();
                return false;
            }
            const selected = latestDecision.type === 'conflict'
                ? latestDecision.accept
                : latestDecision;
            if (selected.region !== getRegion()) setRegion(selected.region);
            applyState(selected.state);
            return true;
        }

        // The negative button promises to keep the current region and use
        // Standard, even if the live policy changed while the popup was open.
        const selected = latestDecision.type === 'conflict'
            ? latestDecision.decline
            : { state: { ...state, tier: TIER.STANDARD }, region: getRegion() };
        if (selected.region !== getRegion()) setRegion(selected.region);
        applyState(selected.state);
        return true;
    }

    async function onTierChanged() {
        if (transitionPending) {
            reconcileGuard.invalidate();
            reconcileQueued = true;
            render();
            return;
        }
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

        const token = reconcileGuard.begin();
        transitionPending = true;
        render();
        try {
            await reconcileGuard.settle(
                token,
                showTierRegionConflict(requestedTier, decision),
                result => commitTierRegionChoice(requestedTier, result),
            );
        } finally {
            finishTransition();
        }
    }

    function onPaygoOnlyChanged() {
        if (transitionPending) {
            reconcileGuard.invalidate();
            reconcileQueued = true;
            render();
            return;
        }
        const policy = getModelPolicy(getModel());
        if (!policy.isGemini && controls.paygoOnly.checked) {
            notifyError(localize('vertex_paygo.error.paygo_only_gemini'));
            controls.paygoOnly.checked = false;
            return;
        }
        applyState({ ...state, paygoOnly: controls.paygoOnly.checked });
    }

    async function onRegionChanged() {
        if (!isVertexSelected()) return;
        if (transitionPending) {
            reconcileGuard.invalidate();
            reconcileQueued = true;
            render();
            return;
        }
        const decision = resolveRegionChange({ state, requestedRegion: regionInput.value });
        if (decision.type === 'apply') {
            render();
            return;
        }

        const token = reconcileGuard.begin();
        transitionPending = true;
        render();
        try {
            const tierLabel = getTierLabel(localize, state.tier);
            await reconcileGuard.settle(
                token,
                popup.show.confirm(
                    localize('vertex_paygo.popup.region.title'),
                    localize('vertex_paygo.popup.region.body', { tier: tierLabel }),
                    {
                        okButton: localize('vertex_paygo.popup.region.accept'),
                        cancelButton: localize('vertex_paygo.popup.region.decline', { tier: tierLabel }),
                        defaultResult: popupResult.NEGATIVE,
                    },
                ),
                result => {
                    const selected = result === popupResult.AFFIRMATIVE ? decision.accept : decision.decline;
                    const regionChanged = selected.region !== getRegion();
                    if (regionChanged) {
                        setRegion(selected.region);
                    }
                    const latestValidation = validatePluginState({
                        state: selected.state,
                        region: selected.region,
                        model: getModel(),
                    });
                    if (!latestValidation.ok) {
                        notifyError(localizeValidation(localize, latestValidation, selected.state));
                        render();
                        return;
                    }
                    if (!regionChanged) {
                        writeActiveProfileRegion(context, selected.region);
                    }
                    applyState(selected.state);
                },
            );
        } finally {
            finishTransition();
        }
    }

    async function onModelChanged() {
        const nextModel = getModel();
        if (!isVertexSelected()) {
            reconcileGuard.invalidate();
            render();
            return;
        }

        if (!nextModel) {
            reconcileGuard.invalidate();
            if (appReady) {
                reconcileQueued = true;
            }
            render();
            return;
        }

        if (profileTransitionPending) {
            reconcileGuard.invalidate();
            reconcileQueued = true;
            lastModel = nextModel;
            render();
            return;
        }

        if (revertingModel) {
            revertingModel = false;
            lastModel = nextModel;
            render();
            if (reconcileQueued) {
                schedulePersistedReconciliation();
            }
            return;
        }

        if (!appReady) {
            reconcileGuard.invalidate();
            lastModel = nextModel;
            render();
            return;
        }

        if (nextModel === lastModel) {
            render();
            if (reconcileQueued) {
                schedulePersistedReconciliation();
            }
            return;
        }

        if (transitionPending) {
            reconcileGuard.invalidate();
            lastModel = nextModel;
            schedulePersistedReconciliation({ invalidate: false });
            render();
            return;
        }

        const previousModel = lastModel;
        lastModel = nextModel;
        const decision = resolveModelChange({ state, model: nextModel });
        if (decision.type === 'apply') {
            render();
            schedulePersistedReconciliation();
            return;
        }

        const token = reconcileGuard.begin();
        transitionPending = true;
        render();
        try {
            const reason = decision.code === 'PAYGO_REQUIRES_GEMINI'
                ? localize('vertex_paygo.popup.model.reason_gemini')
                : localize('vertex_paygo.popup.model.reason_unsupported');
            await reconcileGuard.settle(
                token,
                popup.show.confirm(
                    localize('vertex_paygo.popup.model.title'),
                    localize('vertex_paygo.popup.model.body', { reason }),
                    {
                        okButton: localize('vertex_paygo.popup.model.accept'),
                        cancelButton: localize('vertex_paygo.popup.model.decline'),
                        defaultResult: popupResult.NEGATIVE,
                    },
                ),
                result => {
                    const latestDecision = resolveModelChange({ state, model: nextModel });
                    if (result === popupResult.AFFIRMATIVE || !previousModel || previousModel === nextModel) {
                        if (latestDecision.type === 'apply') {
                            render();
                        } else {
                            applyState(latestDecision.accept.state);
                        }
                        return;
                    }

                    const restoreDecision = resolveModelChange({ state, model: previousModel });
                    if (restoreDecision.type !== 'apply') {
                        const previousValidation = validatePluginState({
                            state,
                            region: getRegion(),
                            model: previousModel,
                        });
                        notifyError(localizeValidation(localize, previousValidation, state));
                        render();
                        schedulePersistedReconciliation({ invalidate: false });
                        return;
                    }

                    lastModel = previousModel;
                    const modelInput = getModelInput();
                    if (modelInput) {
                        modelInput.value = previousModel;
                        modelInput.dispatchEvent(new Event('input', { bubbles: true }));
                    } else {
                        revertingModel = true;
                        modelSelect.value = previousModel;
                        modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                },
            );
        } finally {
            finishTransition();
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

    function onModelPolicyChanged() {
        render();
        // Do not silently invalidate a confirmation already shown to the user.
        // The queued reconciliation revalidates its result after that transition.
        schedulePersistedReconciliation({ invalidate: false });
    }

    async function reconcilePersistedState() {
        if (!appReady || transitionPending || profileTransitionPending) {
            reconcileQueued = true;
            return;
        }

        syncPersistedState();
        if (document.activeElement === getModelInput()) {
            reconcileQueued = true;
            return;
        }
        const model = getModel();
        if (model) {
            lastModel = model;
        }

        const region = getRegion();
        const plan = planPersistedReconciliation({
            state,
            source: context.chatCompletionSettings.chat_completion_source,
            model,
            region,
        });
        if (plan.type === 'defer') {
            reconcileQueued = true;
            return;
        }
        if (plan.type !== 'conflict') return;

        const validation = plan.validation;

        if (validation.code === 'TIER_REQUIRES_GLOBAL') {
            const decision = resolveTierSelection({ state, requestedTier: state.tier, region, model });
            if (decision.type === 'conflict') {
                const token = reconcileGuard.begin();
                transitionPending = true;
                render();
                try {
                    await reconcileGuard.settle(
                        token,
                        showTierRegionConflict(state.tier, decision),
                        result => commitTierRegionChoice(state.tier, result),
                    );
                } finally {
                    finishTransition();
                }
            }
            return;
        }

        const token = reconcileGuard.begin();
        transitionPending = true;
        render();
        try {
            const validationMessage = localizeValidation(localize, validation, state);
            await reconcileGuard.settle(
                token,
                popup.show.confirm(
                    localize('vertex_paygo.popup.saved.title'),
                    localize('vertex_paygo.popup.saved.body', { message: validationMessage }),
                    {
                        okButton: localize('vertex_paygo.popup.saved.accept'),
                        cancelButton: localize('vertex_paygo.popup.saved.decline'),
                        defaultResult: popupResult.NEGATIVE,
                    },
                ),
                result => {
                    const latestValidation = validatePluginState({ state, region: getRegion(), model: getModel() });
                    if (latestValidation.ok) {
                        render();
                        return;
                    }
                    if (result === popupResult.AFFIRMATIVE) {
                        applyState({ ...DEFAULT_STATE });
                    }
                },
            );
        } finally {
            finishTransition();
        }
    }

    controls.tierSelect.addEventListener('change', onTierChanged);
    controls.paygoOnly.addEventListener('change', onPaygoOnlyChanged);
    regionInput.addEventListener('change', onRegionChanged);
    const onVertexModelInput = event => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.id !== 'vertexai_model_id') return;
        reconcileGuard.invalidate();
        render();
        if (reconcileQueued || transitionPending || profileTransitionPending) {
            schedulePersistedReconciliation({ invalidate: false });
        }
    };
    const onVertexModelChange = event => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.id !== 'vertexai_model_id') return;
        void onModelChanged();
    };
    const onVertexModelFocusOut = event => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.id !== 'vertexai_model_id') return;
        if (reconcileQueued) {
            schedulePersistedReconciliation();
        }
    };
    const jquery = globalThis.jQuery ?? globalThis.$;
    if (typeof jquery === 'function') {
        jquery(document).on('input.vertexPaygo', '#vertexai_model_id', onVertexModelInput);
        jquery(document).on('change.vertexPaygo', '#vertexai_model_id', onVertexModelChange);
        jquery(document).on('focusout.vertexPaygo', '#vertexai_model_id', onVertexModelFocusOut);
    } else {
        document.addEventListener('input', onVertexModelInput);
        document.addEventListener('change', onVertexModelChange);
        document.addEventListener('focusout', onVertexModelFocusOut);
    }
    document.addEventListener('change', event => {
        const target = event.target;
        if (target instanceof Element && target.closest('#connection_profiles')) {
            beginProfileTransition();
        }
    }, true);
    document.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const profileSelect = document.getElementById('connection_profiles');
        if (target.closest('#reload_connection_profile')
            && profileSelect instanceof HTMLSelectElement
            && profileSelect.value) {
            beginProfileTransition();
        }
    }, true);
    controls.retryButton.addEventListener('click', refreshHealth);

    const events = context.eventTypes;
    context.eventSource.on(events.CHATCOMPLETION_SOURCE_CHANGED, () => {
        const model = getModel();
        if (model) {
            lastModel = model;
        }
        render();
        schedulePersistedReconciliation();
    });
    context.eventSource.on(events.CHATCOMPLETION_MODEL_CHANGED, onModelChanged);
    context.eventSource.on(events.OAI_PRESET_CHANGED_AFTER, () => {
        syncPersistedState();
        schedulePersistedReconciliation();
    });
    context.eventSource.on(events.OAI_PRESET_IMPORT_READY, normalizeImportedPreset);
    context.eventSource.on(events.OAI_PRESET_EXPORT_READY, normalizeExportedPreset);
    context.eventSource.on(events.CONNECTION_PROFILE_CREATED, profile => {
        reconcileGuard.invalidate();
        if (profile?.mode === 'cc' && profile?.api === VERTEX_SOURCE) {
            attachStateToProfile(profile, state);
            // Connection Manager emitted CREATED after its first save.
            context.saveSettingsDebounced();
        }
        syncPersistedState();
        if (!profileTransitionPending) {
            schedulePersistedReconciliation({ invalidate: false });
        }
    });
    context.eventSource.on(events.CONNECTION_PROFILE_LOADED, finishProfileTransition);
    context.eventSource.on(events.CONNECTION_PROFILE_UPDATED, (_oldProfile, newProfile) => {
        reconcileGuard.invalidate();
        if (newProfile?.mode === 'cc' && newProfile?.api === VERTEX_SOURCE && !Object.hasOwn(newProfile, 'vertex-paygo')) {
            attachStateToProfile(newProfile, state);
            context.saveSettingsDebounced();
        }
        syncPersistedState();
        if (!profileTransitionPending) {
            schedulePersistedReconciliation({ invalidate: false });
        }
    });

    context.eventSource.once(events.APP_READY, () => {
        appReady = true;
        syncPersistedState();
        schedulePersistedReconciliation();
    });

    render();
    void refreshHealth();

    return {
        getState: () => ({ ...state }),
        refreshHealth,
        onModelPolicyChanged,
        render,
    };
}
