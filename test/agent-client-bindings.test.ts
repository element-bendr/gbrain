import { describe, expect, test } from 'bun:test';
import {
  validateAgentClientBindings,
  type AgentClientBindings,
} from '../src/core/agent-client-bindings.ts';
import type { SqlQuery } from '../src/core/sql-query.ts';
import { parseGovernedModelList } from '../src/core/ai/model-resolver.ts';

function sqlWithConfig(config: Record<string, string> = {}): SqlQuery {
  return async (strings, ...values) => {
    const query = strings.join('?');
    if (query.includes('FROM sources')) return values[0] === 'default' ? [{ '?column?': 1 }] : [];
    if (query.includes('FROM pages')) return values[1] === 'projects/%' ? [{ '?column?': 1 }] : [];
    if (query.includes('FROM config')) {
      const value = config[String(values[0])];
      return value === undefined ? [] : [{ value }];
    }
    return [];
  };
}

async function validate(
  overrides: AgentClientBindings = {},
  config: Record<string, string> = {},
  operatorConfig?: { chat_model?: string; chat_fallback_chain?: string[] },
) {
  return validateAgentClientBindings(sqlWithConfig(config), {
    controlCapabilities: ['submit_agent', 'whoami', 'submit_agent'],
    boundTools: ['search', 'query', 'search'],
    boundSourceId: 'default',
    boundSlugPrefixes: ['projects/'],
    boundMaxConcurrent: 2,
    budgetUsdPerDay: '1.50',
    allowedProviders: ['openai'],
    allowedModels: ['openai:gpt-4o-mini'],
    ...overrides,
  }, 'default', operatorConfig);
}

describe('governed agent client binding validation', () => {
  test('normalizes durable operator approvals deterministically', () => {
    expect(parseGovernedModelList(' openai:gpt-5,openai:gpt-5 ')).toEqual(['openai:gpt-5']);
    expect(() => parseGovernedModelList('openai:gpt-5,,openai:gpt-4o')).toThrow('1-100');
    expect(() => parseGovernedModelList('OpenAI:gpt-5')).toThrow('bounded provider:model');
  });

  test('normalizes duplicates deterministically', async () => {
    const result = await validate();
    expect(result.controlCapabilities).toEqual(['submit_agent', 'whoami']);
    expect(result.boundTools).toEqual(['query', 'search']);
    expect(result.budgetUsdPerDay).toBe('1.5');
  });

  test('rejects control-plane operations as inherited tools', async () => {
    await expect(validate({ boundTools: ['submit_agent'] })).rejects.toThrow('non-inheritable');
  });

  test('rejects invalid limits and unknown namespace bindings', async () => {
    await expect(validate({ boundMaxConcurrent: 0 })).rejects.toThrow('between 1 and 1000');
    await expect(validate({ budgetUsdPerDay: -1 })).rejects.toThrow('non-negative');
    await expect(validate({ boundSlugPrefixes: ['missing/'] })).rejects.toThrow('unknown slug prefix');
  });

  test('rejects malformed and cross-provider model allowlists', async () => {
    await expect(validate({ allowedModels: ['gpt-4o-mini'] })).rejects.toThrow('provider:model');
    await expect(validate({ allowedModels: [`${'x'.repeat(65)}:model`] })).rejects.toThrow('bounded provider:model');
    await expect(validate({ allowedModels: ['madeup-provider:model-x'] })).rejects.toThrow('Unknown provider');
    await expect(validate({ allowedModels: ['anthropic:claude-sonnet-4-6'] })).rejects.toThrow('outside the provider allowlist');
  });

  test('accepts an operator-approved dynamic model but never caller approval alone', async () => {
    const model = 'openai:gbrain-test-future-model';
    await expect(validate({ allowedModels: [model] })).rejects.toThrow('static chat catalog or operator approval');

    const result = await validate(
      { allowedModels: [model] },
      { 'agent.approved_models': model },
    );
    expect(result.allowedModels).toEqual([model]);

    await expect(validate(
      { allowedModels: [model] },
      {},
      { chat_fallback_chain: [model] },
    )).resolves.toBeDefined();
  });

  test('operator approval cannot widen the OAuth provider allowlist', async () => {
    const model = 'openai:gbrain-test-future-model';
    await expect(validate(
      { allowedProviders: ['anthropic'], allowedModels: [model] },
      { 'agent.approved_models': model },
    )).rejects.toThrow('outside the provider allowlist');
  });

  test('operator approval cannot bypass provider tool capability', async () => {
    const model = 'minimax:gbrain-test-future-model';
    await expect(validate(
      { allowedProviders: ['minimax'], allowedModels: [model] },
      { 'agent.approved_models': model },
    )).rejects.toThrow('tool loop');
  });

  test('revoking operator approval blocks new registrations', async () => {
    const model = 'openai:gbrain-test-future-model';
    const config: Record<string, string> = { 'agent.approved_models': model };
    await expect(validate({ allowedModels: [model] }, config)).resolves.toBeDefined();
    delete config['agent.approved_models'];
    await expect(validate({ allowedModels: [model] }, config)).rejects.toThrow('static chat catalog or operator approval');
  });

  test('accepts only statically approved Ollama Gemma chat models', async () => {
    const result = await validate({
      allowedProviders: ['ollama'],
      allowedModels: ['ollama:gemma4:e2b'],
    });
    expect(result.allowedModels).toEqual(['ollama:gemma4:e2b']);
    await expect(validate({
      allowedProviders: ['ollama'],
      allowedModels: ['ollama:unknown-local-model'],
    })).rejects.toThrow('static chat catalog or operator approval');
  });
});
