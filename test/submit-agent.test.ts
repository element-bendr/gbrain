import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { operationsByName } from '../src/core/operations.ts';

/**
 * v0.38 Slice 3 — `submit_agent` MCP op tests.
 *
 * Covers the load-bearing trust-boundary surface:
 *   - Per-dispatch binding enforcement against oauth_clients.bound_*
 *   - allowed_tools ⊆ bound_tools subset check
 *   - allowed_slug_prefixes prefix-match against bound_slug_prefixes
 *   - bound_max_concurrent concurrency cap
 *   - Local CLI bypass (ctx.remote === false → invalid_request)
 *   - Refusal when client has scope but missing bindings
 *   - Refusal for unknown client_id
 *   - dry_run path
 *   - Happy-path submission writes audit row + queue row
 *
 * Audit-trail writes go to a tmpdir via GBRAIN_AUDIT_DIR (withEnv-wrapped).
 */

const submit_agent = operationsByName['submit_agent'];
if (!submit_agent) {
  throw new Error('submit_agent op missing from operations registry — test fixture invalid');
}

const TEST_MODEL = 'anthropic:claude-sonnet-4-6';

let engine: PGLiteEngine;
let tmpAuditDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // resetPgliteState truncates `config` table; restore the version row so
  // MinionQueue.ensureSchema() sees the migrated state. The schema itself
  // is preserved (initSchema applied in beforeAll); only the config-table
  // marker row needs re-seeding.
  await engine.setConfig('version', '85');
  tmpAuditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'submit-agent-audit-'));
});

interface SeedOpts {
  bound_tools?: string[] | null;
  bound_source_id?: string | null;
  bound_brain_id?: string | null;
  bound_slug_prefixes?: string[] | null;
  bound_max_concurrent?: number;
  budget_usd_per_day?: number | null;
  control_capabilities?: string[];
  allowed_providers?: string[];
  allowed_models?: string[];
  scope?: string;
}

const oauthClientId = (clientId: string): string =>
  clientId.startsWith('gbrain_cl_') ? clientId : `gbrain_cl_${clientId}`;

async function seedClient(clientId: string, opts: SeedOpts = {}): Promise<void> {
  const authenticatedClientId = oauthClientId(clientId);
  await engine.executeRaw(
    `INSERT INTO oauth_clients
       (client_id, client_name, client_secret_hash, scope, grant_types,
        redirect_uris, token_endpoint_auth_method,
        bound_tools, bound_source_id, bound_brain_id, bound_slug_prefixes,
        bound_max_concurrent, budget_usd_per_day, control_capabilities,
        allowed_providers, allowed_models, created_at, deleted_at)
     VALUES ($1, $1, '', $2, ARRAY['client_credentials'],
             ARRAY[]::text[], 'client_secret_post',
             $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), NULL)
     ON CONFLICT (client_id) DO UPDATE SET
       bound_tools = EXCLUDED.bound_tools,
       bound_source_id = EXCLUDED.bound_source_id,
       bound_slug_prefixes = EXCLUDED.bound_slug_prefixes,
       bound_max_concurrent = EXCLUDED.bound_max_concurrent,
       budget_usd_per_day = EXCLUDED.budget_usd_per_day,
       control_capabilities = EXCLUDED.control_capabilities,
       allowed_providers = EXCLUDED.allowed_providers,
       allowed_models = EXCLUDED.allowed_models,
       scope = EXCLUDED.scope`,
    [
      authenticatedClientId,
      opts.scope ?? 'read agent',
      opts.bound_tools ?? null,
      opts.bound_source_id ?? null,
      opts.bound_brain_id ?? null,
      opts.bound_slug_prefixes ?? null,
      opts.bound_max_concurrent ?? 1,
      opts.budget_usd_per_day === undefined ? 5.00 : opts.budget_usd_per_day,
      opts.control_capabilities ?? ['submit_agent'],
      opts.allowed_providers ?? ['anthropic'],
      opts.allowed_models ?? [TEST_MODEL],
    ],
  );
}

function makeCtx(opts: { clientId?: string; remote?: boolean; dryRun?: boolean; config?: Record<string, unknown> } = {}): any {
  return {
    engine,
    config: opts.config ?? { anthropic_api_key: 'test-key' },
    logger: console,
    dryRun: opts.dryRun ?? false,
    remote: opts.remote ?? true,
    auth: opts.clientId ? { clientId: oauthClientId(opts.clientId) } : undefined,
  };
}

async function callSubmitAgent(ctx: any, params: Record<string, unknown>): Promise<any> {
  return await withEnv({ GBRAIN_AUDIT_DIR: tmpAuditDir }, async () => {
    return await submit_agent.handler(ctx, { model: TEST_MODEL, ...params });
  });
}

describe('submit_agent op (v0.38 Slice 3 — remote-callable agent dispatch with binding enforcement)', () => {
  describe('op surface', () => {
    it('declares scope=agent + mutating=true', () => {
      expect(submit_agent.scope).toBe('agent' as any);
      expect(submit_agent.mutating).toBe(true);
    });
    it('declares required prompt param', () => {
      expect(submit_agent.params.prompt).toBeDefined();
      expect((submit_agent.params.prompt as any).required).toBe(true);
    });
    it('declares required explicit model param', () => {
      expect((submit_agent.params.model as any).required).toBe(true);
    });
  });

  describe('provider and model policy', () => {
    it('requires a qualified explicit model', async () => {
      await seedClient('policy', { bound_tools: ['search'], bound_slug_prefixes: ['wiki/'] });
      await expect(submit_agent.handler(makeCtx({ clientId: 'policy' }), { prompt: 'go' })).rejects.toMatchObject({
        code: 'invalid_model',
      });
      await expect(callSubmitAgent(makeCtx({ clientId: 'policy' }), { prompt: 'go', model: 'claude-sonnet-4-6' })).rejects.toMatchObject({
        code: 'invalid_model',
      });
      await expect(callSubmitAgent(makeCtx({ clientId: 'policy' }), { prompt: 'go', model: 'not-a-provider:model' })).rejects.toMatchObject({
        code: 'unknown_provider',
      });
    });

    it('enforces client provider and model allowlists', async () => {
      await seedClient('policy', { bound_tools: ['search'], bound_slug_prefixes: ['wiki/'] });
      await expect(callSubmitAgent(makeCtx({ clientId: 'policy', config: { openai_api_key: 'test-key' } }), {
        prompt: 'go', model: 'openai:gpt-4o-mini',
      })).rejects.toMatchObject({ code: 'provider_not_allowed' });
      await seedClient('policy', {
        bound_tools: ['search'], bound_slug_prefixes: ['wiki/'],
        allowed_providers: ['anthropic'], allowed_models: ['anthropic:claude-haiku-4-5-20251001'],
      });
      await expect(callSubmitAgent(makeCtx({ clientId: 'policy' }), { prompt: 'go' })).rejects.toMatchObject({
        code: 'model_not_allowed',
      });
    });

    it('rejects disabled providers and missing credentials before queue insertion', async () => {
      await seedClient('policy', { bound_tools: ['search'], bound_slug_prefixes: ['wiki/'] });
      await engine.setConfig('agent.enabled_providers', 'openai');
      await expect(callSubmitAgent(makeCtx({ clientId: 'policy' }), { prompt: 'go' })).rejects.toMatchObject({
        code: 'provider_disabled',
      });
      await engine.executeRaw(`DELETE FROM config WHERE key = 'agent.enabled_providers'`);
      await expect(callSubmitAgent(makeCtx({ clientId: 'policy', config: {} }), { prompt: 'go' })).rejects.toMatchObject({
        code: 'provider_credentials_missing',
      });
      const jobs = await engine.executeRaw<{ count: number }>(`SELECT COUNT(*)::int AS count FROM minion_jobs`);
      expect(Number(jobs[0].count)).toBe(0);
    });

    it('rejects statically unknown and unpriced models before queue insertion', async () => {
      await seedClient('policy', {
        bound_tools: ['search'], bound_slug_prefixes: ['wiki/'],
        allowed_models: ['anthropic:claude-not-real'],
      });
      await expect(callSubmitAgent(makeCtx({ clientId: 'policy' }), {
        prompt: 'go', model: 'anthropic:claude-not-real',
      })).rejects.toMatchObject({ code: 'unknown_model' });

      await seedClient('policy', {
        bound_tools: ['search'], bound_slug_prefixes: ['wiki/'],
        allowed_providers: ['groq'], allowed_models: ['groq:llama-3.3-70b-versatile'],
      });
      await withEnv({ GROQ_API_KEY: 'test-key' }, async () => {
        await expect(callSubmitAgent(makeCtx({ clientId: 'policy', config: {} }), {
          prompt: 'go', model: 'groq:llama-3.3-70b-versatile',
        })).rejects.toMatchObject({ code: 'pricing_unavailable' });
      });
      const jobs = await engine.executeRaw<{ count: number }>(`SELECT COUNT(*)::int AS count FROM minion_jobs`);
      expect(Number(jobs[0].count)).toBe(0);
    });

    it('preserves requested id and records the canonical effective alias without fallback', async () => {
      await seedClient('policy', {
        bound_tools: ['search'], bound_slug_prefixes: ['wiki/'],
        allowed_models: ['anthropic:claude-haiku-4-5-20251001'],
      });
      const result = await callSubmitAgent(makeCtx({ clientId: 'policy' }), {
        prompt: 'go', model: 'anthropic:claude-haiku-4-5',
      });
      expect(result.requested_model).toBe('anthropic:claude-haiku-4-5');
      expect(result.effective_model).toBe('anthropic:claude-haiku-4-5-20251001');
      const jobs = await engine.executeRaw<Record<string, unknown>>(
        `SELECT requested_model, effective_model, data FROM minion_jobs WHERE id = $1`,
        [result.id],
      );
      expect(jobs[0].requested_model).toBe('anthropic:claude-haiku-4-5');
      expect(jobs[0].effective_model).toBe('anthropic:claude-haiku-4-5-20251001');
      const data = typeof jobs[0].data === 'string' ? JSON.parse(jobs[0].data as string) : jobs[0].data;
      expect((data as Record<string, unknown>).model).toBe('anthropic:claude-haiku-4-5-20251001');
    });
  });

  describe('local CLI bypass (ctx.remote === false)', () => {
    it('throws invalid_request — local CLI must use gbrain agent run', async () => {
      const ctx = makeCtx({ remote: false });
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow(
        /local CLI.*gbrain agent run/i,
      );
    });
  });

  describe('OAuth client requirement', () => {
    it('refuses when no clientId in ctx.auth', async () => {
      const ctx = makeCtx(); // no clientId
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow(
        /requires an OAuth client with the `agent` scope/i,
      );
    });

    it('refuses when client_id is unknown', async () => {
      const ctx = makeCtx({ clientId: 'nobody-here' });
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow(
        /OAuth client is not bound to submit_agent/,
      );
    });
  });

  describe('owner-scoped idempotency input', () => {
    it('rejects an empty idempotency key', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(callSubmitAgent(ctx, { prompt: 'go', idempotency_key: '' })).rejects.toThrow(
        /idempotency_key must be 1-128 characters/,
      );
    });
  });

  describe('trace metadata is bounded and never authority', () => {
    it('rejects oversized trace ids before queue insertion', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(callSubmitAgent(ctx, { prompt: 'go', correlation_id: 'x'.repeat(65) })).rejects.toThrow(
        /Trace IDs must be 1-64 characters/,
      );
      expect((await engine.executeRaw(`SELECT id FROM minion_jobs`)).length).toBe(0);
    });

    it('derives owner from OAuth even when caller supplies forged owner metadata', async () => {
      await seedClient('alice', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const result = await callSubmitAgent(makeCtx({ clientId: 'alice' }), {
        prompt: 'go',
        owner_client_id: 'gbrain_cl_bob',
        __owner_client_id: 'gbrain_cl_bob',
        correlation_id: 'forged-authority',
      });
      const [job] = await engine.executeRaw<Record<string, unknown>>(
        `SELECT owner_client_id, correlation_id, data FROM minion_jobs WHERE id = $1`,
        [result.id],
      );
      const data = typeof job.data === 'string' ? JSON.parse(job.data) : job.data as Record<string, unknown>;
      expect(job.owner_client_id).toBe('gbrain_cl_alice');
      expect(data.__owner_client_id).toBe('gbrain_cl_alice');
      expect(job.correlation_id).toBe('forged-authority');
    });
  });

  describe('durable budget policy', () => {
    it('refuses governed submission when the registered daily budget is unset', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        budget_usd_per_day: null,
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(callSubmitAgent(ctx, { prompt: 'go' })).rejects.toThrow(
        /requires a registered daily budget/i,
      );
    });
  });

  describe('binding requirement (D13 — opt-in only)', () => {
    it('refuses when client has agent scope but bound_tools is NULL', async () => {
      // Legacy admin client gets agent scope appended via re-registration but
      // forgot to set --bound-tools. Refuse with the paste-ready hint.
      await seedClient('legacy-admin', { bound_tools: null });
      const ctx = makeCtx({ clientId: 'legacy-admin' });
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow(
        /has the agent scope but no bindings.*re-register/i,
      );
    });
  });

  describe('allowed_tools subset enforcement', () => {
    it('passes when allowed_tools ⊆ bound_tools', async () => {
      await seedClient('cursor', {
        bound_tools: ['search', 'get_page', 'put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 3,
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      const result = await callSubmitAgent(ctx, {
        prompt: 'go',
        allowed_tools: ['search', 'get_page'],
      });
      expect(result.dry_run).toBe(true);
      expect(result.action).toBe('submit_agent');
    });

    it('refuses when allowed_tools requests a tool outside bound_tools', async () => {
      await seedClient('cursor', {
        bound_tools: ['search', 'get_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(
        callSubmitAgent(ctx, { prompt: 'go', allowed_tools: ['put_page'] }),
      ).rejects.toThrow(/tool "put_page" is not in client gbrain_cl_cursor's bound_tools/);
    });

    it('defaults to bound_tools when allowed_tools omitted', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      const result = await callSubmitAgent(ctx, { prompt: 'go' });
      expect(result.dry_run).toBe(true);
    });

    // An EXPLICIT [] used to pass both subset loops vacuously and reach the
    // worker, which reads empty allowed_tools as "the whole registry" — so a
    // client bound to ['search'] got put_page. `??` doesn't substitute for an
    // empty array, only for null/undefined.
    it('collapses an explicit empty allowed_tools to the binding, not the full registry', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      const result = await callSubmitAgent(ctx, { prompt: 'go', allowed_tools: [] });
      expect(result.dry_run).toBe(true);
      expect(result.resolved_tools).toEqual(['search']);
    });

    // Empty prefixes reached the subagent as "use the legacy
    // wiki/agents/<job-id>/ namespace" — outside every bound prefix.
    it('collapses an explicit empty allowed_slug_prefixes to the binding', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['emp-alice/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      const result = await callSubmitAgent(ctx, { prompt: 'go', allowed_slug_prefixes: [] });
      // Normalized into the glob the delegated matcher understands, so the
      // subagent can write descendants rather than one exact slug.
      expect(result.resolved_slug_prefixes).toEqual(['emp-alice/*']);
    });
  });

  describe('allowed_slug_prefixes enforcement', () => {
    it('passes when each requested prefix is under a bound prefix', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/', 'people/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      // 'wiki/' starts with 'wiki/' (exact prefix match)
      const r1 = await callSubmitAgent(ctx, {
        prompt: 'go',
        allowed_slug_prefixes: ['wiki/'],
      });
      expect(r1.dry_run).toBe(true);
    });

    it('refuses when a requested prefix has no bound parent', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(
        callSubmitAgent(ctx, {
          prompt: 'go',
          allowed_slug_prefixes: ['private/'],
        }),
      ).rejects.toThrow(/slug_prefix "private\/" is not under any.*bound_slug_prefixes/);
    });
  });

  describe('concurrency cap enforcement', () => {
    it('refuses when inflight count >= bound_max_concurrent', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 2,
      });
      // Seed 2 already-running subagent jobs for this client.
      for (let i = 0; i < 2; i++) {
        await engine.executeRaw(
          `INSERT INTO minion_jobs (name, status, data, owner_client_id, queue, priority, created_at)
           VALUES ('subagent', 'active', $1::jsonb, $2, 'default', 0, now())`,
          [JSON.stringify({ prompt: `existing-${i}`, __owner_client_id: oauthClientId('cursor') }), oauthClientId('cursor')],
        );
      }
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(callSubmitAgent(ctx, { prompt: 'one too many' })).rejects.toThrow(
        /Agent concurrency limit reached \(2\/2\)/,
      );
    });

    it('allows submit when inflight count < cap', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 3,
      });
      await engine.executeRaw(
        `INSERT INTO minion_jobs (name, status, data, owner_client_id, queue, priority, created_at)
         VALUES ('subagent', 'active', $1::jsonb, $2, 'default', 0, now())`,
        [JSON.stringify({ prompt: 'one', __owner_client_id: oauthClientId('cursor') }), oauthClientId('cursor')],
      );
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      const result = await callSubmitAgent(ctx, { prompt: 'two' });
      expect(result.dry_run).toBe(true);
      expect(result.bound_max_concurrent).toBe(3);
    });

    it('does NOT count terminal-state jobs toward the cap', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 1,
      });
      // 5 completed jobs — none counted (status filter is waiting/active/waiting-children).
      for (let i = 0; i < 5; i++) {
        await engine.executeRaw(
          `INSERT INTO minion_jobs (name, status, data, owner_client_id, queue, priority, created_at)
           VALUES ('subagent', 'completed', $1::jsonb, $2, 'default', 0, now())`,
          [JSON.stringify({ prompt: `done-${i}`, __owner_client_id: oauthClientId('cursor') }), oauthClientId('cursor')],
        );
      }
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      const result = await callSubmitAgent(ctx, { prompt: 'fresh' });
      expect(result.dry_run).toBe(true);
    });

    it('isolates inflight count by client_id (no cross-client leakage)', async () => {
      await seedClient('alice', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 1,
      });
      await seedClient('bob', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 1,
      });
      // Alice has 1 active — at her cap.
      await engine.executeRaw(
        `INSERT INTO minion_jobs (name, status, data, owner_client_id, queue, priority, created_at)
         VALUES ('subagent', 'active', $1::jsonb, $2, 'default', 0, now())`,
        [JSON.stringify({ prompt: 'alice-busy', __owner_client_id: oauthClientId('alice') }), oauthClientId('alice')],
      );
      // Bob's submit should succeed — his cap (1) is independent.
      const ctxBob = makeCtx({ clientId: 'bob', dryRun: true });
      const result = await callSubmitAgent(ctxBob, { prompt: 'bob-fresh' });
      expect(result.dry_run).toBe(true);
    });
  });

  describe('happy-path submission', () => {
    it('inserts a subagent job + writes audit row', async () => {
      await seedClient('cursor', {
        bound_tools: ['search', 'get_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 3,
        budget_usd_per_day: 5.00,
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      const result = await callSubmitAgent(ctx, {
        prompt: 'research the YC W26 batch',
        allowed_tools: ['search'],
      });
      expect(result.id).toBeGreaterThan(0);
      expect(result.name).toBe('subagent');
      expect(result.client_id).toBe(oauthClientId('cursor'));

      // Job persisted with correct shape.
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT name, status, data FROM minion_jobs WHERE id = $1`,
        [result.id],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe('subagent');
      const data = typeof rows[0].data === 'string'
        ? JSON.parse(rows[0].data as string)
        : (rows[0].data as Record<string, unknown>);
      expect(data.prompt).toBe('research the YC W26 batch');
      expect(data.allowed_tools).toEqual(['search']);
      expect(data.__owner_client_id).toBe(oauthClientId('cursor'));
      expect(data.source_id).toBe('default'); // auto-set from bound_source_id
      expect(data.model).toBe(TEST_MODEL);
      expect(result.requested_model).toBe(TEST_MODEL);
      expect(result.effective_model).toBe(TEST_MODEL);

      // Audit file written.
      const auditFiles = fs.readdirSync(tmpAuditDir).filter(f => f.startsWith('agent-jobs-'));
      expect(auditFiles.length).toBe(1);
      const auditContent = fs.readFileSync(path.join(tmpAuditDir, auditFiles[0]), 'utf8');
      const auditLine = JSON.parse(auditContent.trim().split('\n')[0]);
      expect(auditLine.client_id).toBe(oauthClientId('cursor'));
      expect(auditLine.job_id).toBe(result.id);
      expect(auditLine.bound_tools).toEqual(['search']);
      expect(auditLine.bound_source).toBe('default');
      expect(auditLine.budget_remaining_cents).toBe(500); // 5.00 USD → 500 cents
      expect(auditLine.outcome).toBe('submitted');
      expect(auditLine.requested_model).toBe(TEST_MODEL);
      expect(auditLine.effective_model).toBe(TEST_MODEL);
      // CRITICAL: prompt text MUST NOT be in audit (only byte count).
      expect(auditContent).not.toContain('YC W26 batch');
    });

    it('caps max_turns at 100', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      const result = await callSubmitAgent(ctx, {
        prompt: 'long',
        max_turns: 9999, // way over cap
      });
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT data FROM minion_jobs WHERE id = $1`,
        [result.id],
      );
      const data = typeof rows[0].data === 'string'
        ? JSON.parse(rows[0].data as string)
        : (rows[0].data as Record<string, unknown>);
      expect(data.max_turns).toBe(100);
    });
  });
});
