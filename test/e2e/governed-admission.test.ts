import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { MinionAdmissionError, MinionQueue } from '../../src/core/minions/queue.ts';
import { runMigrations } from '../../src/core/migrate.ts';
import { getConn, getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describePG = hasDatabase() ? describe : describe.skip;

describePG('governed atomic admission on PostgreSQL', () => {
  beforeAll(async () => {
    await setupDB();
    await runMigrations(getEngine());
  }, 30_000);
  afterAll(teardownDB);
  beforeEach(async () => {
    await getConn().unsafe('TRUNCATE minion_job_events, minion_inbox, minion_jobs RESTART IDENTITY CASCADE');
  });

  const admission = (owner: string, key?: string, fingerprint = 'a'.repeat(64)) => ({
    allowProtectedSubmit: true,
    agentAdmission: {
      ownerClientId: owner, maxConcurrent: 1, idempotencyKey: key,
      requestFingerprint: fingerprint, correlationId: `trace-${owner}`,
    },
  });

  test('real concurrent transactions cannot exceed one inflight slot', async () => {
    const url = process.env.DATABASE_URL!;
    const engines = [new PostgresEngine(), new PostgresEngine()];
    await Promise.all(engines.map(engine => engine.connect({ engine: 'postgres', database_url: url, poolSize: 2 })));
    try {
      const results = await Promise.allSettled(engines.map((engine, index) =>
        new MinionQueue(engine).add('subagent', { index }, {}, admission('alice')),
      ));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const refusal = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
      expect(refusal.reason).toBeInstanceOf(MinionAdmissionError);
      expect(refusal.reason.code).toBe('agent_concurrency_limit');
      const count = await getConn()`SELECT count(*)::int AS n FROM minion_jobs WHERE owner_client_id = 'alice'`;
      expect(count[0].n).toBe(1);
    } finally {
      await Promise.all(engines.map(engine => engine.disconnect()));
    }
  });

  test('idempotency is owner-scoped, persistent, and fingerprint-conflict safe', async () => {
    const queue = new MinionQueue(getEngine());
    const first = await queue.add('subagent', {}, {}, admission('alice', 'retry-1'));
    const replay = await queue.add('subagent', {}, {}, admission('alice', 'retry-1'));
    expect(replay.id).toBe(first.id);
    await expect(queue.add('subagent', {}, {}, admission('alice', 'retry-1', 'b'.repeat(64))))
      .rejects.toMatchObject({ code: 'idempotency_conflict' });
    const other = await queue.add('subagent', {}, {}, admission('bob', 'retry-1'));
    expect(other.id).not.toBe(first.id);
  });

  test('paused and delayed jobs count; terminal jobs release capacity', async () => {
    const queue = new MinionQueue(getEngine());
    const first = await queue.add('subagent', {}, {}, admission('alice'));
    await getConn()`UPDATE minion_jobs SET status = 'paused' WHERE id = ${first.id}`;
    await expect(queue.add('subagent', {}, {}, admission('alice')))
      .rejects.toMatchObject({ code: 'agent_concurrency_limit' });
    await getConn()`UPDATE minion_jobs SET status = 'completed' WHERE id = ${first.id}`;
    const second = await queue.add('subagent', {}, { delay: 60_000 }, admission('alice'));
    expect(second.status).toBe('delayed');
  });
});
