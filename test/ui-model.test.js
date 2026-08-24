import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveVertexModel } from '../src/ui.js';

test('list-external Gemini model is read from an active Vertex profile', () => {
    assert.equal(resolveVertexModel({
        profile: {
            mode: 'cc',
            api: 'vertexai',
            model: ' gemini-9.0-future ',
        },
        inputValue: '',
        settingsValue: '',
        selectValue: 'claude-sonnet-4',
    }), 'gemini-9.0-future');
});

test('free-form Vertex input wins when the active profile does not own the model', () => {
    assert.equal(resolveVertexModel({
        profile: {
            mode: 'cc',
            api: 'vertexai',
            model: 'claude-sonnet-4',
            exclude: ['model'],
        },
        inputValue: 'gemini-9.1-future',
        settingsValue: 'gemini-3.1-pro-preview',
        selectValue: '',
    }), 'gemini-9.1-future');
});

test('live Vertex settings override a stale model in the active profile', () => {
    assert.equal(resolveVertexModel({
        profile: {
            mode: 'cc',
            api: 'vertexai',
            model: 'gemma-3-27b-it',
        },
        inputValue: '',
        settingsValue: 'gemini-3.7-flash',
        selectValue: 'gemma-3-27b-it',
    }), 'gemini-3.7-flash');
});

test('classic SillyTavern model selection falls back to settings and select values', () => {
    assert.equal(resolveVertexModel({
        settingsValue: 'gemini-3.1-pro-preview',
        selectValue: 'gemini-2.5-pro',
    }), 'gemini-3.1-pro-preview');
    assert.equal(resolveVertexModel({ selectValue: 'gemini-2.5-pro' }), 'gemini-2.5-pro');
});
