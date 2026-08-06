import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  auditOAuthAuthenticationFailures,
  nonLoopbackBindWarning,
} from '../src/commands/serve-http.ts';

describe('serve-http network boundary', () => {
  test('loopback binds need no warning', () => {
    for (const bind of ['127.0.0.1', '127.42.0.9', '::1', '[::1]', 'localhost']) {
      expect(nonLoopbackBindWarning(bind)).toBeNull();
    }
  });

  test('every non-loopback bind emits a prominent warning', () => {
    for (const bind of ['0.0.0.0', '::', '192.168.1.20', 'gbrain.internal']) {
      const warning = nonLoopbackBindWarning(bind);
      expect(warning).toContain('SECURITY WARNING');
      expect(warning).toContain(`--bind ${bind}`);
      expect(warning).toContain('TLS');
    }
  });
});

describe('serve-http OAuth authentication audit', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('401 without an authenticated principal is audited without request secrets', async () => {
    const req = {
      headers: { authorization: 'Bearer must-not-appear', cookie: 'session=must-not-appear' },
    } as any;
    const res = Object.assign(new EventEmitter(), { statusCode: 401 }) as any;
    let continued = false;
    auditOAuthAuthenticationFailures(engine)(req, res, () => { continued = true; });
    expect(continued).toBe(true);
    res.emit('finish');

    for (let attempt = 0; attempt < 20; attempt++) {
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT token_name, agent_name, operation, status, error_message, params
           FROM mcp_request_log WHERE operation = 'mcp:authenticate'`,
      );
      if (rows.length) {
        expect(rows[0]).toMatchObject({
          token_name: null,
          agent_name: null,
          operation: 'mcp:authenticate',
          status: 'auth_failed',
          error_message: 'missing_or_invalid_oauth_bearer',
          params: null,
        });
        expect(JSON.stringify(rows[0])).not.toContain('must-not-appear');
        return;
      }
      await Bun.sleep(5);
    }
    throw new Error('authentication failure audit row was not persisted');
  });
});
