import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';

import {
  installWorkerService,
  renderWorkerServiceUnit,
  resolveWorkerServicePaths,
  uninstallWorkerService,
  WORKER_ENV_TEMPLATE,
  WORKER_SERVICE_NAME,
} from '../src/commands/jobs-service.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-worker-service-'));
  roots.push(home);
  const calls: string[][] = [];
  return {
    home,
    env: { HOME: home },
    calls,
    run: (command: string, args: string[]) => calls.push([command, ...args]),
  };
}

describe('jobs user service', () => {
  test('installs idempotently without embedding secrets', () => {
    const h = harness();
    const cliPath = '/opt/gbrain/bin/gbrain';
    const first = installWorkerService({ cliPath, env: h.env, run: h.run });
    expect(first.envCreated).toBe(true);
    expect(statSync(first.paths.env).mode & 0o777).toBe(0o600);
    expect(statSync(first.paths.unit).mode & 0o777).toBe(0o644);

    const secret = 'GBRAIN_DATABASE_URL=postgresql://user:secret@db/gbrain\n';
    writeFileSync(first.paths.env, secret);
    const second = installWorkerService({ cliPath, env: h.env, run: h.run });
    expect(second.envCreated).toBe(false);
    expect(readFileSync(second.paths.env, 'utf8')).toBe(secret);
    expect(statSync(second.paths.env).mode & 0o777).toBe(0o600);

    const unit = readFileSync(second.paths.unit, 'utf8');
    expect(unit).toContain(`ExecStart="${cliPath}" jobs supervisor --concurrency 2 --json`);
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('TimeoutStopSec=45s');
    expect(unit).toContain('EnvironmentFile=-');
    expect(unit).toContain('Environment="PATH=');
    expect(unit).not.toContain('secret');
    expect(h.calls.filter(c => c.includes('enable')).length).toBe(2);
  });

  test('escapes spaces in systemd environment paths', () => {
    const unit = renderWorkerServiceUnit('/usr/bin/gbrain', '/home/test user/.config/gbrain/worker.env');
    expect(unit).toContain('EnvironmentFile=-/home/test\\x20user/.config/gbrain/worker.env');
  });

  test('uninstall is idempotent and preserves the protected environment', () => {
    const h = harness();
    const installed = installWorkerService({ cliPath: '/usr/bin/gbrain', env: h.env, run: h.run });
    const first = uninstallWorkerService({ env: h.env, run: h.run });
    const second = uninstallWorkerService({ env: h.env, run: h.run });

    expect(first.removed).toBe(true);
    expect(second.removed).toBe(false);
    expect(existsSync(installed.paths.unit)).toBe(false);
    expect(readFileSync(installed.paths.env, 'utf8')).toBe(WORKER_ENV_TEMPLATE);
    expect(h.calls.some(c => c.join(' ') === `systemctl --user disable --now ${WORKER_SERVICE_NAME}`)).toBe(true);
    expect(h.calls.some(c => c.join(' ') === `systemctl --user reset-failed ${WORKER_SERVICE_NAME}`)).toBe(true);
  });

  test('rejects relative roots, control characters, and symlinked env files', () => {
    expect(() => resolveWorkerServicePaths({ HOME: 'relative' })).toThrow('HOME');
    expect(() => renderWorkerServiceUnit('/usr/bin/gbrain\nExecStart=/bin/false', '/tmp/env')).toThrow('control');

    const h = harness();
    const paths = resolveWorkerServicePaths(h.env);
    writeFileSync(join(h.home, 'target'), 'do-not-touch');
    mkdirSync(join(h.home, '.config', 'gbrain'), { recursive: true });
    symlinkSync(join(h.home, 'target'), paths.env);
    expect(() => installWorkerService({ cliPath: '/usr/bin/gbrain', env: h.env, run: h.run }))
      .toThrow('non-regular');
  });
});
