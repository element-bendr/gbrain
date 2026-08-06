import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { runMigrations } from '../../src/core/migrate.ts';
import { getConn, getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describePG = hasDatabase() ? describe : describe.skip;
const op = (name: string) => operations.find(operation => operation.name === name)!;

describePG('governed owner-scoped job control on PostgreSQL', () => {
  beforeAll(async () => {
    await setupDB();
    await runMigrations(getEngine());
  }, 30_000);

  afterAll(teardownDB);

  beforeEach(async () => {
    const sql = getConn();
    await sql.unsafe('TRUNCATE minion_job_events, minion_inbox, minion_jobs, oauth_tokens, oauth_clients RESTART IDENTITY CASCADE');
    const capabilities = ['get_owned_job', 'list_owned_jobs', 'cancel_owned_job', 'message_owned_job', 'get_owned_job_events'];
    for (const id of ['gbrain_cl_alice', 'gbrain_cl_bob']) {
      await sql`
        INSERT INTO oauth_clients(client_id, client_name, redirect_uris, grant_types, scope,
          client_id_issued_at, control_capabilities)
        VALUES (${id}, ${id}, '{}', '{"client_credentials"}', 'agent', 1, ${sql.array(capabilities)})
      `;
    }
  });

  function ctx(clientId: string): OperationContext {
    return {
      engine: getEngine(), config: {} as any, dryRun: false, remote: true, sourceId: 'default',
      logger: { info() {}, warn() {}, error() {} },
      auth: { token: 'redacted', clientId, scopes: ['agent'] },
    } as OperationContext;
  }

  async function seed(owner: string, status = 'waiting'): Promise<number> {
    const rows = await getConn()`
      INSERT INTO minion_jobs(name, status, data, owner_client_id)
      VALUES ('subagent', ${status}, '{}', ${owner}) RETURNING id
    `;
    return Number(rows[0].id);
  }

  test('two clients cannot read, cancel, message, or retrieve each other events', async () => {
    const id = await seed('gbrain_cl_alice');
    await getConn()`INSERT INTO minion_job_events(job_id, owner_client_id, event_type)
      VALUES (${id}, 'gbrain_cl_alice', 'accepted')`;

    const alice = ctx('gbrain_cl_alice');
    const bob = ctx('gbrain_cl_bob');
    expect((await op('get_owned_job').handler(alice, { id }) as any).id).toBe(id);
    for (const name of ['get_owned_job', 'cancel_owned_job', 'message_owned_job', 'get_owned_job_events']) {
      const params = name === 'message_owned_job'
        ? { id, owner_client_id: 'gbrain_cl_alice', correlation_id: 'forged-authority', payload: { text: 'forged' } }
        : { id, owner_client_id: 'gbrain_cl_alice', correlation_id: 'forged-authority' };
      await expect(op(name).handler(bob, params)).rejects.toThrow(/Owned job unavailable/);
    }
    expect(await op('list_owned_jobs').handler(bob, {})).toEqual([]);
  });

  test('owned messaging, bounded events, idempotent cancellation, and admin read remain compatible', async () => {
    const id = await seed('gbrain_cl_alice');
    const alice = ctx('gbrain_cl_alice');
    expect((await op('message_owned_job').handler(alice, { id, payload: { text: 'hello' } }) as any).sent).toBe(true);
    const first = await op('cancel_owned_job').handler(alice, { id }) as any;
    expect(first.status).toBe('cancelled');
    const second = await op('cancel_owned_job').handler(alice, { id }) as any;
    expect(second.already_cancelled).toBe(true);

    const events = await op('get_owned_job_events').handler(alice, { id, cursor: 0, limit: 500 }) as any;
    expect(events.limit).toBe(100);
    expect(events.events.map((event: any) => event.event_type)).toEqual(['cancelled']);
    await expect(op('message_owned_job').handler(alice, { id, payload: { text: 'late' } })).rejects.toThrow(/terminal/);
    const completedId = await seed('gbrain_cl_alice', 'completed');
    await expect(op('message_owned_job').handler(alice, { id: completedId, payload: { text: 'late' } })).rejects.toThrow(/terminal/);
    await expect(op('get_owned_job_events').handler(alice, { id, cursor: -1 })).rejects.toThrow(/cursor.*non-negative/i);

    const admin = { ...alice, auth: { ...alice.auth!, scopes: ['admin'] } } as OperationContext;
    expect((await op('get_job').handler(admin, { id }) as any).id).toBe(id);
  });
});
