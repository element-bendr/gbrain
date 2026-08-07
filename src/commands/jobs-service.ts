import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, isAbsolute, join } from 'path';

import { loadConfig } from '../core/config.ts';
import { resolveGbrainCliPath } from './autopilot.ts';

export const WORKER_SERVICE_NAME = 'gbrain-worker.service';

export interface WorkerServicePaths {
  unit: string;
  env: string;
}

type CommandRunner = (command: string, args: string[]) => void;

function defaultRunner(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: 'inherit', timeout: 20_000, env: process.env });
}

export function resolveWorkerServicePaths(
  env: NodeJS.ProcessEnv = process.env,
): WorkerServicePaths {
  const home = env.HOME;
  if (!home || !isAbsolute(home)) throw new Error('HOME must be an absolute path');
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  if (!isAbsolute(configHome)) throw new Error('XDG_CONFIG_HOME must be an absolute path');
  return {
    unit: join(configHome, 'systemd', 'user', WORKER_SERVICE_NAME),
    env: join(configHome, 'gbrain', 'worker.env'),
  };
}

function systemdQuote(value: string): string {
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    throw new Error('systemd paths must not contain control characters');
  }
  return `"${value.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function systemdPathToken(value: string): string {
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    throw new Error('systemd paths must not contain control characters');
  }
  return value
    .replace(/%/g, '%%')
    .replace(/\\/g, '\\\\')
    .replace(/ /g, '\\x20')
    .replace(/\t/g, '\\t');
}

export function renderWorkerServiceUnit(
  cliPath: string,
  envPath: string,
  runtimePath: string = process.execPath,
): string {
  if (!isAbsolute(cliPath)) throw new Error('gbrain CLI path must be absolute');
  if (!isAbsolute(runtimePath)) throw new Error('runtime path must be absolute');
  const servicePath = `${dirname(runtimePath)}:/usr/local/bin:/usr/bin:/bin`;
  return `[Unit]
Description=GBrain governed jobs worker
Documentation=https://github.com/garrytan/gbrain/blob/master/docs/guides/minions-deployment.md
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
Environment=${systemdQuote(`PATH=${servicePath}`)}
EnvironmentFile=-${systemdPathToken(envPath)}
ExecStart=${systemdQuote(cliPath)} jobs supervisor --concurrency 2 --json
Restart=on-failure
RestartSec=10s
KillSignal=SIGTERM
TimeoutStopSec=45s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=gbrain-worker
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/.gbrain

[Install]
WantedBy=default.target
`;
}

export const WORKER_ENV_TEMPLATE = `# GBrain worker environment (mode 0600).
# Production workers require PostgreSQL. Keep credentials out of the unit file.
# Uncomment only values not already present in ~/.gbrain/config.json.
# GBRAIN_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/gbrain
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# OPENROUTER_API_KEY=
`;

function writeAtomic(path: string, content: string, mode: number): void {
  const tmp = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tmp, content, { flag: 'wx', mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function installWorkerService(opts: {
  cliPath: string;
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
}): { paths: WorkerServicePaths; envCreated: boolean } {
  const env = opts.env ?? process.env;
  const run = opts.run ?? defaultRunner;
  const paths = resolveWorkerServicePaths(env);
  const home = env.HOME!;

  mkdirSync(dirname(paths.unit), { recursive: true });
  mkdirSync(dirname(paths.env), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, '.gbrain'), { recursive: true, mode: 0o700 });

  const envCreated = !existsSync(paths.env);
  if (envCreated) {
    writeAtomic(paths.env, WORKER_ENV_TEMPLATE, 0o600);
  } else {
    const stat = lstatSync(paths.env);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing non-regular worker environment file: ${paths.env}`);
    }
    chmodSync(paths.env, 0o600);
  }

  writeAtomic(paths.unit, renderWorkerServiceUnit(opts.cliPath, paths.env), 0o644);
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', WORKER_SERVICE_NAME]);
  return { paths, envCreated };
}

export function uninstallWorkerService(opts: {
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
} = {}): { paths: WorkerServicePaths; removed: boolean } {
  const paths = resolveWorkerServicePaths(opts.env ?? process.env);
  if (!existsSync(paths.unit)) return { paths, removed: false };
  const run = opts.run ?? defaultRunner;
  run('systemctl', ['--user', 'disable', '--now', WORKER_SERVICE_NAME]);
  rmSync(paths.unit);
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'reset-failed', WORKER_SERVICE_NAME]);
  return { paths, removed: true };
}

export function runJobsService(args: string[]): void {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`gbrain jobs service — user-level systemd worker

USAGE
  gbrain jobs service install [--cli-path PATH]
  gbrain jobs service uninstall

The service runs the existing PostgreSQL-only 'gbrain jobs supervisor'.
Its protected environment file is preserved during uninstall.`);
    return;
  }
  if (process.platform !== 'linux') throw new Error('jobs service requires Linux systemd');

  if (sub === 'install') {
    const config = loadConfig();
    if (config?.engine !== 'postgres') {
      throw new Error('Persistent workers require a configured PostgreSQL engine; refusing non-Postgres configuration');
    }
    const flag = args.indexOf('--cli-path');
    const cliPath = flag >= 0 ? args[flag + 1] : resolveGbrainCliPath();
    if (!cliPath) throw new Error('--cli-path requires a value');
    const result = installWorkerService({ cliPath });
    console.log(`Installed and started ${WORKER_SERVICE_NAME}`);
    console.log(`  Unit: ${result.paths.unit}`);
    console.log(`  Environment: ${result.paths.env}${result.envCreated ? ' (created, edit then restart if credentials are needed)' : ' (preserved)'}`);
    return;
  }

  if (sub === 'uninstall') {
    const result = uninstallWorkerService();
    console.log(result.removed
      ? `Stopped, disabled, and removed ${WORKER_SERVICE_NAME}`
      : `${WORKER_SERVICE_NAME} is not installed`);
    console.log(`  Preserved environment: ${result.paths.env}`);
    return;
  }

  throw new Error(`Unknown jobs service subcommand: ${sub}`);
}
