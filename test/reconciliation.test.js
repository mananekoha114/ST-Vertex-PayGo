import test from 'node:test';
import assert from 'node:assert/strict';

import { TIER, VERTEX_SOURCE } from '../src/constants.js';
import { createReconcileGuard, planPersistedReconciliation } from '../src/reconciliation.js';

const flexState = Object.freeze({ version: 1, tier: TIER.FLEX, paygoOnly: false });

test('startup reconciliation defers an unresolved Vertex model without weakening request validation', () => {
    const plan = planPersistedReconciliation({
        state: flexState,
        source: VERTEX_SOURCE,
        model: '   ',
        region: 'global',
    });

    assert.equal(plan.type, 'defer');
    assert.equal(plan.code, 'MODEL_UNRESOLVED');
    assert.equal(plan.state.tier, TIER.FLEX);
});

test('saved PayGo state is not reconciled while another source is active', () => {
    const plan = planPersistedReconciliation({
        state: flexState,
        source: 'custom',
        model: 'claude-sonnet-4',
        region: 'global',
    });

    assert.equal(plan.type, 'skip');
    assert.equal(plan.code, 'SOURCE_NOT_VERTEX');
});

test('a stable non-Gemini Vertex model still produces a saved-state conflict', () => {
    const plan = planPersistedReconciliation({
        state: flexState,
        source: VERTEX_SOURCE,
        model: 'gemma-3-27b-it',
        region: 'global',
    });

    assert.equal(plan.type, 'conflict');
    assert.equal(plan.validation.code, 'PAYGO_REQUIRES_GEMINI');
});

test('a pending popup cannot commit after its configuration snapshot is invalidated', async () => {
    const guard = createReconcileGuard();
    const token = guard.begin();
    let resolvePopup;
    const popupResult = new Promise(resolve => {
        resolvePopup = resolve;
    });
    let commits = 0;
    const settling = guard.settle(token, popupResult, () => {
        commits += 1;
    });

    guard.invalidate();
    resolvePopup(1);

    assert.deepEqual(await settling, { status: 'stale', result: 1 });
    assert.equal(commits, 0);
});

test('a current popup token can commit only once', async () => {
    const guard = createReconcileGuard();
    const token = guard.begin();
    let commits = 0;
    const outcome = await guard.settle(token, Promise.resolve(1), () => {
        commits += 1;
        return 'saved';
    });

    assert.deepEqual(outcome, { status: 'committed', result: 1, value: 'saved' });
    assert.equal(commits, 1);

    const duplicate = await guard.settle(token, Promise.resolve(2), () => {
        commits += 1;
    });
    assert.deepEqual(duplicate, { status: 'stale', result: 2 });
    assert.equal(commits, 1);
});
