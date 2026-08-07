/** Real-PostgreSQL proof for governed gateway reservation and settlement. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { PostgresEngine } from 'gbrain';
import {
  __setChatTransportForTests,
  chat,
  toolLoop,
  withGatewaySpendContext,
  type ChatOpts,
  type ChatResult,
  type GatewaySpendContext,
} from '../../src/core/ai/gateway.ts';
import {
  BudgetExceededError,
  reserve,
  settle,
} from '../../src/core/minions/budget-meter.ts';

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const MODEL = 'anthropic:claude-haiku-4-5-20251001';

describePostgres('governed gateway budget accounting on PostgreSQL', () => {
  let engine: PostgresEngine;
  let clientId = '';
  let jobId = 0;
  let correlationId = '';

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: databaseUrl!, poolSize: 16 });
    await engine.initSchema();
  });

  afterEach(async () => {
    __setChatTransportForTests(null);
    if (!clientId) return;
    await engine.executeRaw(`DELETE FROM mcp_spend_reservations WHERE client_id = $1`, [clientId]);
    await engine.executeRaw(`DELETE FROM mcp_spend_log WHERE client_id = $1`, [clientId]);
    await engine.executeRaw(`DELETE FROM minion_jobs WHERE owner_client_id = $1`, [clientId]);
    await engine.executeRaw(`DELETE FROM oauth_clients WHERE client_id = $1`, [clientId]);
    clientId = '';
    jobId = 0;
  });

  afterAll(async () => {
    await engine?.disconnect();
  });

  async function seedGovernedJob(dailyBudgetUsd = 1, jobBudgetCents = 100): Promise<GatewaySpendContext> {
    clientId = `gbrain_cl_budget_${randomUUIDv7()}`;
    correlationId = `budget:${randomUUIDv7()}`;
    await engine.executeRaw(
      `INSERT INTO oauth_clients
         (client_id, client_name, client_secret_hash, scope, grant_types, redirect_uris,
          token_endpoint_auth_method, budget_usd_per_day, control_capabilities, created_at)
       VALUES ($1, $1, '', 'agent', ARRAY['client_credentials'], ARRAY[]::text[],
               'client_secret_post', $2, ARRAY['submit_agent'], now())`,
      [clientId, dailyBudgetUsd],
    );
    const jobs = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs
         (name, status, data, owner_client_id, requested_model, effective_model,
          requested_job_budget_cents, correlation_id)
       VALUES ('subagent', 'active', '{}'::jsonb, $1, $2, $2, $3, $4)
       RETURNING id`,
      [clientId, MODEL, jobBudgetCents, correlationId],
    );
    jobId = Number(jobs[0].id);
    return { engine, clientId, jobId, dailyCapCents: dailyBudgetUsd * 100, jobCapCents: jobBudgetCents, correlationId };
  }

  function successResult(blocks: ChatResult['blocks'] = [{ type: 'text', text: 'ok' }]): ChatResult {
    return {
      text: blocks.filter(block => block.type === 'text').map(block => block.text).join(''),
      blocks,
      stopReason: blocks.some(block => block.type === 'tool-call') ? 'tool_calls' : 'end',
      model: MODEL,
      providerId: 'anthropic',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_creation_tokens: 1 },
    };
  }

  test('reserves before transport and settles actual usage idempotently', async () => {
    const context = await seedGovernedJob();
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      return successResult();
    });

    await withGatewaySpendContext(context, () => chat({
      model: MODEL,
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 100,
    }));
    expect(calls).toBe(1);

    const rows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT reservation_id::text, status, attempt, correlation_id, pricing_source, pricing_version,
              actual_input_tokens, actual_output_tokens, actual_cache_read_tokens,
              actual_cache_creation_tokens, actual_cents::text
         FROM mcp_spend_reservations WHERE job_id = $1`,
      [jobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'settled',
      attempt: 1,
      correlation_id: correlationId,
      pricing_source: 'built-in',
      pricing_version: 'gbrain-model-pricing-v1',
      actual_input_tokens: 10,
      actual_output_tokens: 5,
      actual_cache_read_tokens: 2,
      actual_cache_creation_tokens: 1,
    });
    const originalCharge = Number(rows[0].actual_cents);
    await settle(engine, String(rows[0].reservation_id), 99);
    const after = await engine.executeRaw<{ actual_cents: string }>(
      `SELECT actual_cents::text FROM mcp_spend_reservations WHERE reservation_id = $1`,
      [rows[0].reservation_id],
    );
    expect(Number(after[0].actual_cents)).toBe(originalCharge);
  });

  test('tool follow-up calls create separate attempts under one job budget', async () => {
    const context = await seedGovernedJob();
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      return calls === 1
        ? successResult([{ type: 'tool-call', toolCallId: 'call-1', toolName: 'noop', input: {} }])
        : successResult();
    });
    await withGatewaySpendContext(context, () => toolLoop({
      model: MODEL,
      initialMessages: [{ role: 'user', content: 'use tool' }],
      tools: [{ name: 'noop', description: 'No-op', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['noop', { execute: async () => ({ ok: true }) }]]),
      maxTokens: 100,
    }));

    expect(calls).toBe(2);
    const rows = await engine.executeRaw<{ attempt: number; status: string }>(
      `SELECT attempt, status FROM mcp_spend_reservations WHERE job_id = $1 ORDER BY attempt`,
      [jobId],
    );
    expect(rows).toEqual([{ attempt: 1, status: 'settled' }, { attempt: 2, status: 'settled' }]);
  });

  test('budget and unknown-pricing refusals occur before provider execution and are owner-visible', async () => {
    const context = await seedGovernedJob(1, 0);
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      return successResult();
    });
    await expect(withGatewaySpendContext(context, () => chat({
      model: MODEL,
      messages: [{ role: 'user', content: 'denied' }],
      maxTokens: 100,
    }))).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(withGatewaySpendContext({ ...context, jobCapCents: 100 }, () => chat({
      model: 'anthropic:unknown-governed-model',
      messages: [{ role: 'user', content: 'unpriced' }],
      maxTokens: 100,
    }))).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls).toBe(0);
    const events = await engine.executeRaw<{ event_type: string }>(
      `SELECT event_type FROM minion_job_events WHERE job_id = $1 ORDER BY id`,
      [jobId],
    );
    expect(events).toEqual([{ event_type: 'budget_refused' }, { event_type: 'budget_refused' }]);
  });

  test('provider error without usage releases hold; retry gets next attempt', async () => {
    const context = await seedGovernedJob();
    let fail = true;
    __setChatTransportForTests(async () => {
      if (fail) throw new Error('provider failed before usage');
      return successResult();
    });
    const request = () => withGatewaySpendContext(context, () => chat({
      model: MODEL,
      messages: [{ role: 'user', content: 'retry' }],
      maxTokens: 100,
    }));
    await expect(request()).rejects.toThrow('provider failed before usage');
    fail = false;
    await request();
    const rows = await engine.executeRaw<{ attempt: number; status: string; actual_cents: string }>(
      `SELECT attempt, status, actual_cents::text FROM mcp_spend_reservations
        WHERE job_id = $1 ORDER BY attempt`,
      [jobId],
    );
    expect(rows[0]).toEqual({ attempt: 1, status: 'released', actual_cents: '0.0000' });
    expect(rows[1].attempt).toBe(2);
    expect(rows[1].status).toBe('settled');
  });

  test('provider error with reported usage settles consumed tokens', async () => {
    const context = await seedGovernedJob();
    __setChatTransportForTests(async () => {
      const error = new Error('provider failed after usage') as Error & { usage: object };
      error.usage = { input_tokens: 20, output_tokens: 7 };
      throw error;
    });
    await expect(withGatewaySpendContext(context, () => chat({
      model: MODEL,
      messages: [{ role: 'user', content: 'charged failure' }],
      maxTokens: 100,
    }))).rejects.toThrow('provider failed after usage');
    const rows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT status, actual_input_tokens, actual_output_tokens, actual_cents::text
         FROM mcp_spend_reservations WHERE job_id = $1`,
      [jobId],
    );
    expect(rows[0].status).toBe('settled');
    expect(rows[0].actual_input_tokens).toBe(20);
    expect(rows[0].actual_output_tokens).toBe(7);
    expect(Number(rows[0].actual_cents)).toBeGreaterThan(0);
  });

  test('timeout or cancellation without usage releases the reservation', async () => {
    const context = await seedGovernedJob();
    __setChatTransportForTests(async (_opts: ChatOpts) => {
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(withGatewaySpendContext(context, () => chat({
      model: MODEL,
      messages: [{ role: 'user', content: 'cancelled' }],
      maxTokens: 100,
    }))).rejects.toThrow('aborted');
    const rows = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM mcp_spend_reservations WHERE job_id = $1`,
      [jobId],
    );
    expect(rows).toEqual([{ status: 'released' }]);
  });

  test('concurrent per-job reservations cannot overspend and old UTC spend does not block today', async () => {
    const context = await seedGovernedJob(1, 50);
    await engine.executeRaw(
      `INSERT INTO mcp_spend_log(client_id, operation, spend_cents, provider, model, created_at)
       VALUES ($1, 'old', 100, 'anthropic', $2, now() - interval '2 days')`,
      [clientId, MODEL],
    );
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => reserve(engine, {
      clientId,
      jobId,
      estimatedCents: 10,
      capCents: context.dailyCapCents,
      jobCapCents: context.jobCapCents,
      model: MODEL,
      provider: 'anthropic',
      correlationId,
    })));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(5);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(5);
  });
});
