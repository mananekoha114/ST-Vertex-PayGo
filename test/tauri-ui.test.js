import test from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'yaml';
import { createTauriUi } from '../src/tauri-ui.js';
import { nativeContext, nativeDocument } from './helpers/native-dom.js';

function fixture() {
    const context = nativeContext(); const documentRef = nativeDocument(); const errors = [];
    const ui = createTauriUi({ getContext: () => context, documentRef, yaml,
        connections: { list: () => [], read: () => null }, notifyError: text => errors.push(text) });
    return { context, documentRef, errors, ui };
}

test('native tier UI preserves unrelated YAML and persists Flex/global through native settings', async () => {
    const { context, documentRef, errors, ui } = fixture();
    context.chatCompletionSettings.vertexai_region = 'us-central1';
    context.chatCompletionSettings.additional_parameters_by_source.vertexai = {
        include_body: 'temperature: 0.25\nmetadata:\n  app: test\n',
        include_headers: 'X-Custom: keep\n', exclude_body: '- seed\n',
    };
    const tier = documentRef.getElementById('vertex-paygo-tier'); tier.value = 'flex'; await tier.fire('change');
    assert.deepEqual(errors, []);
    const saved = context.chatCompletionSettings.additional_parameters_by_source.vertexai;
    assert.equal(yaml.parse(saved.include_headers)['X-Vertex-AI-LLM-Shared-Request-Type'], 'flex');
    assert.equal(yaml.parse(saved.include_headers)['X-Custom'], 'keep');
    assert.deepEqual(yaml.parse(saved.include_body), { temperature: 0.25, metadata: { app: 'test' } });
    assert.equal(context.chatCompletionSettings.vertexai_region, 'global');
    assert.equal(documentRef.getElementById('vertexai_region').value, 'global');
    tier.value = 'standard'; await tier.fire('change');
    assert.deepEqual(yaml.parse(context.chatCompletionSettings.additional_parameters_by_source.vertexai.include_headers), { 'X-Custom': 'keep' });
    ui.destroy();
});

test('cancelled global confirmation and a source change while confirming never write stale settings', async () => {
    const { context, documentRef, errors, ui } = fixture();
    context.chatCompletionSettings.vertexai_region = 'us-central1';
    context.Popup.show.confirm = async () => 0;
    const tier = documentRef.getElementById('vertex-paygo-tier'); tier.value = 'flex'; await tier.fire('change');
    assert.deepEqual(context.chatCompletionSettings.additional_parameters_by_source, {});
    context.Popup.show.confirm = async () => { context.chatCompletionSettings.chat_completion_source = 'makersuite'; return 1; };
    tier.value = 'flex'; await tier.fire('change');
    assert.deepEqual(context.chatCompletionSettings.additional_parameters_by_source, {});
    assert.equal(errors.length, 1);
    assert.equal(context.chatCompletionSettings.vertexai_region, 'us-central1');
    ui.destroy();
});

test('native preset and manual parameter edits update displayed source-specific state', async () => {
    const { context, documentRef, ui } = fixture();
    context.chatCompletionSettings.chat_completion_source = 'makersuite';
    context.chatCompletionSettings.additional_parameters_by_source.makersuite = { include_body: 'service_tier: flex' };
    await context.eventSource.emit('settings');
    assert.equal(documentRef.getElementById('vertex-paygo-tier').value, 'flex');
    assert.equal(ui.getState().tier, 'flex');
    const tier = documentRef.getElementById('vertex-paygo-tier'); tier.value = 'standard'; await tier.fire('change');
    assert.equal(context.chatCompletionSettings.additional_parameters_by_source.makersuite.include_body, '');
    ui.destroy();
    assert.equal(documentRef.getElementById('vertex-paygo-settings'), null);
});

test('selected Agent target is saved independently of foreground source', async () => {
    const context = nativeContext(); const documentRef = nativeDocument(); const calls = [];
    const target = { id: 'studio', name: 'Writer', source: 'makersuite', model: 'gemini-3.8-flash', state: { tier: 'standard', paygoOnly: false } };
    const ui = createTauriUi({ getContext: () => context, documentRef, yaml,
        connections: { list: () => [target], read: id => id === 'studio' ? target : null,
            async save(id, state) { calls.push({ id, state }); target.state = state; } } });
    const scope = documentRef.getElementById('vertex-paygo-scope'); scope.value = 'studio'; await scope.fire('change');
    const tier = documentRef.getElementById('vertex-paygo-tier'); tier.value = 'flex'; await tier.fire('change');
    assert.equal(calls[0].id, 'studio'); assert.equal(calls[0].state.tier, 'flex');
    assert.deepEqual(context.chatCompletionSettings.additional_parameters_by_source, {});
    ui.destroy();
});
