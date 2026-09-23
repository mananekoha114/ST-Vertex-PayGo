import test from 'node:test';
import assert from 'node:assert/strict';
import * as yaml from 'yaml';
import { AI_STUDIO_SOURCE, TIER, VERTEX_SOURCE } from '../src/constants.js';
import {
    applyTauriParameters,
    hasTauriManagedParameters,
    readTauriState,
    TauriParameterError,
} from '../src/tauri-parameters.js';

function parse(value) {
    return typeof value === 'string' && value.trim() ? yaml.parse(value) : value;
}

test('Vertex Flex and PayGo-only preserve unrelated YAML and canonicalize header case', () => {
    const input = {
        chat_completion_source: VERTEX_SOURCE,
        model: 'gemini-2.5-pro',
        custom_include_body: yaml.stringify({ temperature: 0.2, service_tier: 'standard', Service_Tier: 'user-value' }),
        custom_exclude_body: yaml.stringify(['presence_penalty', 'service_tier']),
        custom_include_headers: yaml.stringify([
            { 'X-Trace': 'one', 'x-trace': 'two' },
            { 'X-Vertex-AI-LLM-Shared-Request-Type': 'standard', 'x-server-timeout': '600' },
        ]),
    };
    const output = applyTauriParameters(input, { tier: TIER.FLEX, paygoOnly: true }, { yaml });
    assert.notEqual(output, input);
    assert.equal(parse(output.custom_include_body).temperature, 0.2);
    assert.equal(parse(output.custom_include_body).service_tier, undefined);
    assert.equal(parse(output.custom_include_body).Service_Tier, 'user-value');
    assert.deepEqual(parse(output.custom_exclude_body), ['presence_penalty']);
    assert.deepEqual(parse(output.custom_include_headers), {
        'x-trace': 'two',
        'X-Vertex-AI-LLM-Request-Type': 'shared',
        'X-Vertex-AI-LLM-Shared-Request-Type': 'flex',
        'X-Server-Timeout': '1800',
    });
    assert.equal(input.custom_include_body.includes('service_tier'), true);
});

test('AI Studio Flex writes service_tier and rejects an exclude conflict', () => {
    const output = applyTauriParameters({
        chat_completion_source: AI_STUDIO_SOURCE,
        custom_include_body: yaml.stringify({ temperature: 0.5, service_tier: 'standard' }),
        custom_exclude_body: yaml.stringify(['frequency_penalty']),
        custom_include_headers: yaml.stringify({ 'X-Vertex-AI-LLM-Shared-Request-Type': 'priority' }),
    }, { tier: TIER.FLEX, paygoOnly: true }, { yaml });
    assert.deepEqual(parse(output.custom_include_body), { temperature: 0.5, service_tier: 'flex' });
    assert.deepEqual(parse(output.custom_exclude_body), ['frequency_penalty']);
    assert.deepEqual(parse(output.custom_include_headers), { 'X-Server-Timeout': '1800' });

    assert.throws(() => applyTauriParameters({
        chat_completion_source: AI_STUDIO_SOURCE,
        custom_include_body: yaml.stringify({ temperature: 0.5 }),
        custom_exclude_body: yaml.stringify(['service_tier']),
        custom_include_headers: '',
    }, { tier: TIER.FLEX, paygoOnly: false }, { yaml }), error => {
        assert.ok(error instanceof TauriParameterError);
        assert.equal(error.code, 'TAURI_EXCLUDE_CONFLICT');
        return true;
    });
});

test('Standard removes only adapter-owned values and keeps a user timeout', () => {
    const input = {
        chat_completion_source: VERTEX_SOURCE,
        custom_include_body: yaml.stringify({ service_tier: 'flex', temperature: 0.1 }),
        custom_exclude_body: yaml.stringify(['service_tier', 'temperature']),
        custom_include_headers: yaml.stringify({
            'X-Vertex-AI-LLM-Request-Type': 'shared',
            'X-Vertex-AI-LLM-Shared-Request-Type': 'flex',
            'X-Server-Timeout': '600',
            'X-User': 'keep',
        }),
    };
    const output = applyTauriParameters(input, { tier: TIER.STANDARD, paygoOnly: false }, { yaml });
    assert.deepEqual(parse(output.custom_include_body), { temperature: 0.1 });
    assert.deepEqual(parse(output.custom_exclude_body), ['temperature']);
    assert.deepEqual(parse(output.custom_include_headers), { 'X-Server-Timeout': '600', 'X-User': 'keep' });
});

test('persistent include_* settings and object-valued fields are supported', () => {
    const input = {
        chat_completion_source: VERTEX_SOURCE,
        include_body: { temperature: 0.3 },
        exclude_body: ['candidate_count'],
        include_headers: { 'X-Existing': 'yes' },
    };
    const output = applyTauriParameters(input, { tier: TIER.PRIORITY, paygoOnly: false }, { yaml });
    assert.deepEqual(output.include_body, { temperature: 0.3 });
    assert.deepEqual(output.exclude_body, ['candidate_count']);
    assert.deepEqual(output.include_headers, {
        'X-Existing': 'yes',
        'X-Vertex-AI-LLM-Shared-Request-Type': 'priority',
    });
    assert.deepEqual(readTauriState(output, { yaml }), { version: 1, tier: TIER.PRIORITY, paygoOnly: false });
});

test('state inference is request-local and unknown service tiers fail closed', () => {
    assert.deepEqual(readTauriState({
        chat_completion_source: VERTEX_SOURCE,
        custom_include_headers: { 'x-vertex-ai-llm-request-type': 'shared', 'x-vertex-ai-llm-shared-request-type': 'FLEX' },
    }, { yaml }), { version: 1, tier: TIER.FLEX, paygoOnly: true });
    assert.deepEqual(readTauriState({
        chat_completion_source: AI_STUDIO_SOURCE,
        parameters: { custom_include_body: yaml.stringify({ service_tier: 'flex' }) },
    }, { yaml }), { version: 1, tier: TIER.FLEX, paygoOnly: false });
    assert.equal(hasTauriManagedParameters({
        chat_completion_source: VERTEX_SOURCE,
        custom_include_body: yaml.stringify({ temperature: 0.7 }),
        custom_include_headers: yaml.stringify({ 'X-Server-Timeout': '600' }),
    }, { yaml }), false);
    assert.throws(() => readTauriState({
        chat_completion_source: AI_STUDIO_SOURCE,
        custom_include_body: yaml.stringify({ service_tier: 'priority' }),
    }, { yaml }), { code: 'TAURI_UNKNOWN_SERVICE_TIER' });
    assert.throws(() => readTauriState({
        chat_completion_source: VERTEX_SOURCE,
        custom_include_headers: yaml.stringify({ 'X-Vertex-AI-LLM-Shared-Request-Type': 'turbo' }),
    }, { yaml }), { code: 'TAURI_UNKNOWN_SHARED_REQUEST_TYPE' });
});

test('string parameters require the injected host parser and serializer', () => {
    assert.throws(() => readTauriState({
        chat_completion_source: VERTEX_SOURCE,
        custom_include_headers: 'X-Vertex-AI-LLM-Shared-Request-Type: flex',
    }), { code: 'TAURI_YAML_PARSER_REQUIRED' });
    assert.throws(() => applyTauriParameters({
        chat_completion_source: VERTEX_SOURCE,
        custom_include_headers: '',
    }, { tier: TIER.FLEX }), { code: 'TAURI_YAML_STRINGIFIER_REQUIRED' });
});

test('a user timeout alone does not infer Vertex Flex', () => {
    assert.deepEqual(readTauriState({
        chat_completion_source: VERTEX_SOURCE,
        custom_include_headers: yaml.stringify({ 'X-Server-Timeout': '1800' }),
    }, { yaml }), { version: 1, tier: TIER.STANDARD, paygoOnly: false });
});

test('excluded body keys retain case-sensitive distinct entries', () => {
    const output = applyTauriParameters({
        chat_completion_source: VERTEX_SOURCE,
        custom_exclude_body: yaml.stringify(['Foo', 'foo', 'service_tier']),
    }, { tier: TIER.STANDARD, paygoOnly: false }, { yaml });
    assert.deepEqual(yaml.parse(output.custom_exclude_body), ['Foo', 'foo']);
});
