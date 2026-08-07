/**
 * whoami op contract tests — pins the v0.28 transport-detection shape.
 *
 * The test surface is the op's handler called against synthesized
 * OperationContext rather than the full HTTP stack — keeps the test pure
 * and fast. End-to-end coverage (real HTTP MCP) lives in
 * test/e2e/serve-http-oauth.test.ts and test/e2e/sources-remote-mcp.test.ts.
 */

import { test, expect, describe } from 'bun:test';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, AuthInfo } from '../src/core/operations.ts';

const whoami = operations.find(o => o.name === 'whoami')!;

function ctxWith(overrides: Partial<OperationContext>): OperationContext {
  // Shape exposes only what whoami reads. Every required field gets a
  // safe stub; the test-relevant overrides come last to win.
  return {
    engine: {} as any,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true, // default for tests; specific cases override
    ...overrides,
  } as OperationContext;
}

describe('whoami op contract', () => {
  test('local transport (ctx.remote === false) returns empty scopes', async () => {
    const result = (await whoami.handler(
      ctxWith({ remote: false }),
      {},
    )) as any;
    expect(result.transport).toBe('local');
    expect(result.scopes).toEqual([]);
  });

  test('local transport ignores ctx.auth even if a stale value leaked through', async () => {
    // Defense in depth: even if some buggy transport set both remote=false
    // AND a stale auth blob, the local return shape stays explicit.
    const result = (await whoami.handler(
      ctxWith({
        remote: false,
        auth: {
          token: 'x',
          clientId: 'gbrain_cl_123',
          scopes: ['admin'],
          expiresAt: 999999,
        } as AuthInfo,
      }),
      {},
    )) as any;
    expect(result.transport).toBe('local');
    expect(result.scopes).toEqual([]);
  });

  test('oauth transport returns client identity and exact source grants', async () => {
    const auth: AuthInfo = {
      token: 'gbrain_at_xxx',
      clientId: 'gbrain_cl_abc',
      clientName: 'gstack-test',
      scopes: ['read', 'sources_admin'],
      expiresAt: 1234567890,
      sourceId: 'hot-memory',
      allowedSources: ['hot-memory', 'canonical-brain'],
    };
    const result = (await whoami.handler(
      ctxWith({ remote: true, sourceId: 'transport-fallback', auth }),
      {},
    )) as any;
    expect(result).toEqual({
      transport: 'oauth',
      client_id: 'gbrain_cl_abc',
      client_name: 'gstack-test',
      scopes: ['read', 'sources_admin'],
      expires_at: 1234567890,
      source_id: 'hot-memory',
      federated_read: ['hot-memory', 'canonical-brain'],
      control_plane_capabilities: [],
      bound_inherited_agent_tools: [],
      bound_source_id: null,
      bound_slug_prefixes: [],
      max_concurrent_inflight_jobs: 1,
      daily_budget_usd: null,
      provider_allowlist: [],
      model_allowlist: [],
    });
  });

  test('oauth transport reports non-secret governed bindings', async () => {
    const engine = {
      executeRaw: async () => [{
        control_capabilities: ['submit_agent', 'get_owned_job'],
        bound_tools: ['query'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['projects/'],
        bound_max_concurrent: 2,
        budget_usd_per_day: '1.5',
        allowed_providers: ['openai'],
        allowed_models: ['openai:gpt-4o-mini'],
      }],
    } as any;
    const result = await whoami.handler(ctxWith({
      engine,
      auth: { token: 'redacted', clientId: 'gbrain_cl_governed', scopes: ['agent'] },
    }), {}) as any;
    expect(result.control_plane_capabilities).toEqual(['submit_agent', 'get_owned_job']);
    expect(result.bound_inherited_agent_tools).toEqual(['query']);
    expect(result).not.toHaveProperty('token');
  });

  test('oauth transport uses fail-closed empty values when source grants are absent', async () => {
    const auth: AuthInfo = {
      token: 'gbrain_at_pre_migration',
      clientId: 'gbrain_cl_pre_migration',
      scopes: ['read'],
    };
    const result = (await whoami.handler(
      ctxWith({ remote: true, sourceId: 'transport-fallback', auth }),
      {},
    )) as any;
    expect(result.source_id).toBeNull();
    expect(result.federated_read).toEqual([]);
  });

  test('oauth transport preserves an explicit empty federated grant', async () => {
    const auth: AuthInfo = {
      token: 'gbrain_at_empty',
      clientId: 'gbrain_cl_empty',
      scopes: ['read', 'write'],
      sourceId: 'hot-memory',
      allowedSources: [],
    };
    const result = (await whoami.handler(
      ctxWith({ remote: true, auth }),
      {},
    )) as any;
    expect(result.source_id).toBe('hot-memory');
    expect(result.federated_read).toEqual([]);
  });

  test('oauth transport does not widen federated_read with the write source', async () => {
    const auth: AuthInfo = {
      token: 'gbrain_at_narrow',
      clientId: 'gbrain_cl_narrow',
      scopes: ['read', 'write'],
      sourceId: 'hot-memory',
      allowedSources: ['canonical-brain'],
    };
    const result = (await whoami.handler(
      ctxWith({ remote: true, auth }),
      {},
    )) as any;
    expect(result.source_id).toBe('hot-memory');
    expect(result.federated_read).toEqual(['canonical-brain']);
  });

  test('legacy transport (token name as clientId, no gbrain_cl_ prefix)', async () => {
    const auth: AuthInfo = {
      token: 'legacy-token',
      clientId: 'my-personal-token',
      clientName: 'my-personal-token',
      scopes: ['read', 'write', 'admin'],
      // Legacy tokens have a synthetic 1y expiry — whoami exposes null
      // since legacy tokens don't actually expire.
      expiresAt: 999999999,
    };
    const result = (await whoami.handler(
      ctxWith({ remote: true, auth }),
      {},
    )) as any;
    expect(result.transport).toBe('legacy');
    expect(result.token_name).toBe('my-personal-token');
    expect(result.scopes).toEqual(['read', 'write', 'admin']);
    expect(result.expires_at).toBeNull();
  });

  // #1061: stdio MCP is remote/untrusted by design but has no per-token auth
  // (local pipe). The stdio dispatch marks ctx.transport='stdio'; whoami
  // reports it instead of throwing unknown_transport.
  test('stdio transport (remote=true, no auth, transport marker) reports stdio', async () => {
    const result = (await whoami.handler(
      ctxWith({ remote: true, auth: undefined, transport: 'stdio' }),
      {},
    )) as any;
    expect(result.transport).toBe('stdio');
    expect(result.scopes).toEqual([]);
  });

  test('stdio marker does not mask real auth (auth still wins)', async () => {
    const result = (await whoami.handler(
      ctxWith({
        remote: true,
        transport: 'stdio',
        auth: {
          token: 'gbrain_at_xxx',
          clientId: 'gbrain_cl_abc',
          scopes: ['read'],
          expiresAt: 1,
        } as AuthInfo,
      }),
      {},
    )) as any;
    expect(result.transport).toBe('oauth');
  });

  // Q3: ambiguous transport — fail-closed. The footgun this guards against
  // is a future transport that lands without threading auth, where a buggy
  // caller might trust whoami's output to gate sensitive ops.
  test('unknown_transport throws when remote=true AND auth is missing', async () => {
    try {
      await whoami.handler(ctxWith({ remote: true, auth: undefined }), {});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).message).toMatch(/unknown_transport|did not thread/);
    }
  });

  test('unknown_transport throws when remote is undefined (cast bypass guard)', async () => {
    // F7b contract: ctx.remote is REQUIRED. If a caller widens the type to
    // Partial<> and passes through undefined, whoami should treat it as
    // remote (the fail-closed default) and throw because auth is missing.
    try {
      await whoami.handler(ctxWith({ remote: undefined as any, auth: undefined }), {});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
    }
  });
});

describe('whoami op metadata', () => {
  test('description documents OAuth source grant fields', () => {
    expect(whoami.description).toContain('source_id');
    expect(whoami.description).toContain('federated_read');
  });

  test('scope is read (any authenticated caller can introspect itself)', () => {
    expect(whoami.scope).toBe('read');
  });

  test('not localOnly (must work over HTTP MCP for gstack /setup-gbrain)', () => {
    expect(whoami.localOnly).toBeFalsy();
  });

  test('mutating is false', () => {
    expect(whoami.mutating).toBeFalsy();
  });
});

describe('stdio control-plane boundary', () => {
  test('auth-less stdio cannot call governed agent job operations', async () => {
    const ctx = ctxWith({ remote: true, transport: 'stdio', auth: undefined });
    const calls: Array<[string, Record<string, unknown>]> = [
      ['submit_agent', { prompt: 'nope', model: 'anthropic:claude-sonnet-4-6' }],
      ['get_owned_job', { id: 1 }],
      ['list_owned_jobs', {}],
      ['cancel_owned_job', { id: 1 }],
      ['message_owned_job', { id: 1, payload: { text: 'nope' } }],
      ['get_owned_job_events', { id: 1 }],
    ];
    for (const [name, params] of calls) {
      const operation = operations.find(candidate => candidate.name === name)!;
      await expect(operation.handler(ctx, params)).rejects.toMatchObject({ code: 'permission_denied' });
    }
  });
});
