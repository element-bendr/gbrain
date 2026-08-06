import { describe, expect, test } from 'bun:test';
import {
  validateAgentClientBindings,
  type AgentClientBindings,
} from '../src/core/agent-client-bindings.ts';
import type { SqlQuery } from '../src/core/sql-query.ts';

const sql: SqlQuery = async (strings, ...values) => {
  const query = strings.join('?');
  if (query.includes('FROM sources')) return values[0] === 'default' ? [{ '?column?': 1 }] : [];
  if (query.includes('FROM pages')) return values[1] === 'projects/%' ? [{ '?column?': 1 }] : [];
  return [];
};

async function validate(overrides: AgentClientBindings = {}) {
  return validateAgentClientBindings(sql, {
    controlCapabilities: ['submit_agent', 'whoami', 'submit_agent'],
    boundTools: ['search', 'query', 'search'],
    boundSourceId: 'default',
    boundSlugPrefixes: ['projects/'],
    boundMaxConcurrent: 2,
    budgetUsdPerDay: '1.50',
    allowedProviders: ['openai'],
    allowedModels: ['openai:gpt-4o-mini'],
    ...overrides,
  });
}

describe('governed agent client binding validation', () => {
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
    await expect(validate({ allowedModels: ['openai:not-a-real-model'] })).rejects.toThrow('not listed for OpenAI chat');
    await expect(validate({ allowedModels: ['anthropic:claude-sonnet-4-6'] })).rejects.toThrow('outside the provider allowlist');
  });
});
