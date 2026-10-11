/**
 * Focused regression tests for the official Platform Usage launcher
 * (`scripts/usage-up.mjs`).
 *
 * All process, port, and HTTP behavior is faked: mock children, scripted
 * probes, a fake clock. Nothing here starts a real service, binds a real
 * port, or contacts PostgreSQL/RabbitMQ. Fixture secrets are throwaway
 * canaries; one test asserts they never reach launcher log output.
 */
import { describe, expect, it } from 'vitest';
import { mergeEnv, parseDotEnv } from '../../scripts/dev-up-lib.mjs';
import {
  USAGE_DB_NAMES,
  USAGE_ENTRYPOINT,
  USAGE_HOST,
  USAGE_PORT,
  USAGE_TOKEN_NAMES,
  buildUsageChildEnv,
  isBrokerUrl,
  parsePortValue,
  resolveUsageSettings,
  startUsage,
  superviseUsage,
  validateUsageEnv,
  validateUsageSettings,
  type StartUsageDeps,
  type UsageChildRef,
  type UsageRecord,
  type UsageSettings,
} from '../../scripts/usage-up.mjs';

const CANARY_TOKEN = 'canary-usage-token-xyz';
const CANARY_PASSWORD = 'canary-db-password-xyz';

const VALID_ENV: Record<string, string> = {
  NODE_ENV: 'development',
  INTERNAL_SERVICE_TOKEN: CANARY_TOKEN,
  DATABASE_HOST: '127.0.0.1',
  DATABASE_PORT: '5433',
  DATABASE_USER: 'postgres',
  DATABASE_PASSWORD: CANARY_PASSWORD,
  RABBITMQ_URL: 'amqp://oicunt:pw@127.0.0.1:5672',
};

function envWithout(...names: string[]): Record<string, string> {
  const env: Record<string, string> = { ...VALID_ENV };
  for (const name of names) {
    delete env[name];
  }
  return env;
}

function fakeClock() {
  let nowValue = 0;
  return {
    now: () => nowValue,
    sleep: async (ms: number) => {
      nowValue += ms;
    },
  };
}

function fakeStream() {
  const listeners: Array<(...args: unknown[]) => void> = [];
  return {
    on: (_event: string, listener: (...args: unknown[]) => void) => {
      listeners.push(listener);
    },
    emit: (chunk: string) => {
      for (const listener of listeners) {
        listener(chunk);
      }
    },
  };
}

interface MockChild extends UsageChildRef {
  readonly stdout: ReturnType<typeof fakeStream>;
  readonly stderr: ReturnType<typeof fakeStream>;
  readonly killed: string[];
  die: (code: number | null) => void;
}

function mockChild(pid: number, exitOnKill: boolean): MockChild {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const child: MockChild = {
    pid,
    exitCode: null,
    killed: [],
    stdout: fakeStream(),
    stderr: fakeStream(),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    off: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener),
      );
    },
    kill: (signal: string) => {
      child.killed.push(signal);
      if (exitOnKill) {
        child.die(0);
      }
      return true;
    },
    die: (code: number | null) => {
      child.exitCode = code;
      for (const listener of listeners.get('exit') ?? []) {
        listener(code, null);
      }
    },
  };
  return child;
}

function harness(
  options: {
    exists?: boolean;
    occupied?: boolean;
    spawnImpl?: () => MockChild;
    probeScript?: Array<number | null>;
    spawnThrows?: boolean;
  } = {},
) {
  const clock = fakeClock();
  const logs: string[] = [];
  const spawns: Array<{ entry: string; env: Record<string, string> }> = [];
  let nextPid = 7000;
  const deps: StartUsageDeps = {
    exists: () => options.exists ?? true,
    checkPort: async () => options.occupied ?? false,
    spawn: (entry, env) => {
      if (options.spawnThrows) {
        throw new Error('spawn exploded');
      }
      spawns.push({ entry, env });
      return options.spawnImpl ? options.spawnImpl() : mockChild((nextPid += 1), true);
    },
    probe: (() => {
      const script = options.probeScript ?? [200, 200];
      let calls = 0;
      return async () => {
        const index = Math.min(calls, script.length - 1);
        calls += 1;
        return script[index] ?? null;
      };
    })(),
    sleep: clock.sleep,
    log: (line: string) => {
      logs.push(line);
    },
    now: clock.now,
    intervalMs: 100,
    timeouts: { health: 1000, ready: 1000 },
  };
  return { deps, logs, spawns, clock };
}

const CTX = { entry: USAGE_ENTRYPOINT, env: { ...VALID_ENV } };

/** Compare paths platform-independently (Windows join() yields backslashes). */
function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

describe('configuration loading', () => {
  it('loads the platform .env through the established parser and merge order', () => {
    const fileEnv = parseDotEnv(
      '# comment\nINTERNAL_SERVICE_TOKEN=file-token\nDATABASE_HOST=10.0.0.9\nDATABASE_PORT=5433\n',
    );
    expect(fileEnv['INTERNAL_SERVICE_TOKEN']).toBe('file-token');
    const merged = mergeEnv(fileEnv, { INTERNAL_SERVICE_TOKEN: 'process-token' });
    expect(merged['INTERNAL_SERVICE_TOKEN']).toBe('process-token');
    expect(merged['DATABASE_HOST']).toBe('10.0.0.9');
    expect(validateUsageEnv(merged).ok).toBe(false); // still missing db user/password/broker
  });

  it('supports the documented USAGE_DB_* variables with precedence over DATABASE_*', () => {
    const env: Record<string, string> = {
      ...VALID_ENV,
      USAGE_DB_HOST: 'usage.db.internal',
      USAGE_DB_PORT: '5433',
      USAGE_DB_USER: 'usage',
      USAGE_DB_PASSWORD: 'usage-pw',
    };
    const settings = resolveUsageSettings(env);
    expect(settings.db.host?.name).toBe('USAGE_DB_HOST');
    expect(settings.db.host?.value).toBe('usage.db.internal');
    expect(settings.db.port?.name).toBe('USAGE_DB_PORT');
    expect(settings.db.user?.name).toBe('USAGE_DB_USER');
    expect(settings.db.password?.name).toBe('USAGE_DB_PASSWORD');
    expect(validateUsageSettings(settings).ok).toBe(true);
    // DATABASE_* alone is equally acceptable.
    const fallback = resolveUsageSettings(VALID_ENV);
    expect(fallback.db.host?.name).toBe('DATABASE_HOST');
    expect(validateUsageSettings(fallback).ok).toBe(true);
  });

  it('applies the documented internal-token precedence and treats blanks as unset', () => {
    expect(USAGE_TOKEN_NAMES).toEqual([
      'PLATFORM_USAGE_INTERNAL_TOKEN',
      'INTERNAL_SERVICE_TOKEN',
      'USAGE_INTERNAL_TOKEN',
    ]);
    expect(
      resolveUsageSettings({
        ...VALID_ENV,
        PLATFORM_USAGE_INTERNAL_TOKEN: 'platform-token',
        USAGE_INTERNAL_TOKEN: 'usage-token',
      }).token?.value,
    ).toBe('platform-token');
    expect(
      resolveUsageSettings({ ...VALID_ENV, PLATFORM_USAGE_INTERNAL_TOKEN: '   ' }).token?.name,
    ).toBe('INTERNAL_SERVICE_TOKEN');
    expect(resolveUsageSettings(envWithout('INTERNAL_SERVICE_TOKEN')).token).toBeNull();
  });

  it('names the first configured database variable for each field', () => {
    expect(USAGE_DB_NAMES.host).toEqual(['USAGE_DB_HOST', 'DATABASE_HOST']);
    expect(USAGE_DB_NAMES.port).toEqual(['USAGE_DB_PORT', 'DATABASE_PORT']);
    expect(USAGE_DB_NAMES.user).toEqual(['USAGE_DB_USER', 'DATABASE_USER']);
    expect(USAGE_DB_NAMES.password).toEqual(['USAGE_DB_PASSWORD', 'DATABASE_PASSWORD']);
  });

  it('parses ports strictly and validates broker URLs like the service', () => {
    expect(parsePortValue('5433')).toBe(5433);
    expect(parsePortValue(' 5433 ')).toBe(5433);
    expect(parsePortValue('5433abc')).toBeUndefined();
    expect(parsePortValue('')).toBeUndefined();
    expect(parsePortValue(undefined)).toBeUndefined();
    expect(isBrokerUrl('amqp://user:pw@127.0.0.1:5672')).toBe(true);
    expect(isBrokerUrl('amqps://user:pw@example.internal:5671')).toBe(true);
    expect(isBrokerUrl('amqp://')).toBe(false);
    expect(isBrokerUrl('http://127.0.0.1:5672')).toBe(false);
    expect(isBrokerUrl('   ')).toBe(false);
    expect(isBrokerUrl(undefined)).toBe(false);
  });
});

describe('missing and conflicting variables', () => {
  it('passes a fully configured environment', () => {
    const result = validateUsageEnv(VALID_ENV);
    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('names every missing requirement when the environment is empty', () => {
    const result = validateUsageEnv({});
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('USAGE_DB_HOST (or DATABASE_HOST)');
    expect(result.problems).toContain('USAGE_DB_PORT (or DATABASE_PORT, integer 1-65535)');
    expect(result.problems).toContain('USAGE_DB_USER (or DATABASE_USER)');
    expect(result.problems).toContain('USAGE_DB_PASSWORD (or DATABASE_PASSWORD)');
    expect(result.problems).toContain('RABBITMQ_URL');
    expect(result.problems.join(' ')).toContain('internal authentication');
  });

  it.each([
    ['USAGE_DB_HOST (or DATABASE_HOST)', ['DATABASE_HOST']],
    ['USAGE_DB_USER (or DATABASE_USER)', ['DATABASE_USER']],
    ['USAGE_DB_PASSWORD (or DATABASE_PASSWORD)', ['DATABASE_PASSWORD']],
  ])('reports a missing %s', (expected, missing) => {
    const result = validateUsageEnv(envWithout(...missing));
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(expected);
  });

  it('reports a missing broker URL and rejects malformed ones', () => {
    expect(validateUsageEnv(envWithout('RABBITMQ_URL')).problems).toContain('RABBITMQ_URL');
    for (const url of ['not-a-url', 'http://127.0.0.1:5672', 'amqp://']) {
      const result = validateUsageEnv({ ...VALID_ENV, RABBITMQ_URL: url });
      expect(result.ok).toBe(false);
      expect(result.problems).toContain('RABBITMQ_URL (valid amqp:// or amqps:// URL)');
    }
    expect(validateUsageEnv({ ...VALID_ENV, RABBITMQ_URL: '   ' }).ok).toBe(false);
  });

  it('rejects missing internal authentication', () => {
    const result = validateUsageEnv(envWithout('INTERNAL_SERVICE_TOKEN'));
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('PLATFORM_USAGE_INTERNAL_TOKEN');
  });

  it.each([0, -1, 65536, 70000])('rejects out-of-range database port %s', (port) => {
    const result = validateUsageEnv({ ...VALID_ENV, DATABASE_PORT: String(port) });
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      'USAGE_DB_PORT (or DATABASE_PORT, integer 1-65535) is configured out of range',
    );
  });

  it.each(['abc', '54.5', '5433x'])('rejects non-integer database port %j', (value) => {
    const result = validateUsageEnv({ ...VALID_ENV, DATABASE_PORT: value });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.startsWith('USAGE_DB_PORT'))).toBe(true);
  });

  it('refuses disabled real dependencies', () => {
    const noDb = validateUsageEnv({ ...VALID_ENV, USE_DATABASE: 'false' });
    expect(noDb.ok).toBe(false);
    expect(noDb.problems.join(' ')).toContain('USE_DATABASE=false is refused');
    const noBroker = validateUsageEnv({ ...VALID_ENV, USE_RABBITMQ: 'false' });
    expect(noBroker.ok).toBe(false);
    expect(noBroker.problems.join(' ')).toContain('USE_RABBITMQ=false is refused');
  });

  it('refuses the removed USAGE_AUTO_MIGRATE toggle and points at the migrate command', () => {
    const result = validateUsageEnv({ ...VALID_ENV, USAGE_AUTO_MIGRATE: 'true' });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('USAGE_AUTO_MIGRATE is no longer supported');
    expect(result.problems.join(' ')).toContain('pnpm --filter @oicunt/service-usage migrate');
    expect(validateUsageEnv({ ...VALID_ENV, USAGE_AUTO_MIGRATE: '' }).ok).toBe(true);
  });

  it('refuses production mode', () => {
    const result = validateUsageEnv({ ...VALID_ENV, NODE_ENV: 'production' });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('NODE_ENV=production is refused');
  });

  it('enforces the loopback bind and refuses conflicting settings', () => {
    expect(validateUsageEnv({ ...VALID_ENV, USAGE_SERVICE_HOST: '0.0.0.0' }).ok).toBe(false);
    const conflict = validateUsageEnv({ ...VALID_ENV, USAGE_SERVICE_HOST: '10.0.0.3' });
    expect(conflict.ok).toBe(false);
    expect(conflict.problems.join(' ')).toContain(`USAGE_SERVICE_HOST must be ${USAGE_HOST}`);
    expect(validateUsageEnv({ ...VALID_ENV, USAGE_SERVICE_HOST: '127.0.0.1' }).ok).toBe(true);

    const portConflict = validateUsageEnv({ ...VALID_ENV, USAGE_SERVICE_PORT: '3000' });
    expect(portConflict.ok).toBe(false);
    expect(portConflict.problems.join(' ')).toContain(`USAGE_SERVICE_PORT must be ${USAGE_PORT}`);
    expect(validateUsageEnv({ ...VALID_ENV, USAGE_SERVICE_PORT: '8090' }).ok).toBe(true);
  });

  it('never includes secret values in validation problems', () => {
    const problems = [
      ...validateUsageEnv(envWithout('DATABASE_HOST', 'DATABASE_USER')).problems,
      ...validateUsageEnv({ ...VALID_ENV, RABBITMQ_URL: 'nope' }).problems,
    ].join('\n');
    expect(problems).not.toContain(CANARY_TOKEN);
    expect(problems).not.toContain(CANARY_PASSWORD);
    expect(problems).not.toContain('oicunt:pw');
  });
});

describe('child environment', () => {
  it('pins the loopback bind and passes configuration through untouched', () => {
    const child = buildUsageChildEnv({ ...VALID_ENV, LOG_LEVEL: 'info' });
    expect(child['USAGE_SERVICE_HOST']).toBe('127.0.0.1');
    expect(child['USAGE_SERVICE_PORT']).toBe('8090');
    expect(child['NODE_ENV']).toBe('development');
    expect(child['LOG_LEVEL']).toBe('info');
    expect(child['DATABASE_PASSWORD']).toBe(CANARY_PASSWORD);
    expect(child['RABBITMQ_URL']).toBe(VALID_ENV['RABBITMQ_URL']);
  });

  it('defaults NODE_ENV to development and drops undefined entries', () => {
    const child = buildUsageChildEnv({
      ...VALID_ENV,
      NODE_ENV: undefined,
      LOG_LEVEL: undefined,
    });
    expect(child['NODE_ENV']).toBe('development');
    expect('LOG_LEVEL' in child).toBe(false);
    expect(Object.values(child)).not.toContain('undefined');
  });
});

describe('process startup', () => {
  it('refuses a missing compiled entrypoint without spawning', async () => {
    const h = harness({ exists: false });
    await expect(startUsage(h.deps, CTX)).rejects.toThrow(/missing compiled entrypoint/);
    expect(h.spawns).toHaveLength(0);
  });

  it('refuses an occupied port without spawning', async () => {
    const h = harness({ occupied: true });
    await expect(startUsage(h.deps, CTX)).rejects.toThrow(/port 8090 is already occupied/);
    expect(h.spawns).toHaveLength(0);
  });

  it('starts exactly the Usage entrypoint, gated on health then readiness', async () => {
    const h = harness({ probeScript: [503, 200, 503, 200] });
    const record: UsageRecord = await startUsage(h.deps, CTX);
    expect(h.spawns).toHaveLength(1);
    expect(toPosix(h.spawns[0]?.entry ?? '').endsWith('services/usage/dist/start.js')).toBe(true);
    expect(toPosix(h.spawns[0]?.entry ?? '')).not.toContain('migrate.js');
    expect(record.spec).toEqual({ name: 'usage', port: 8090, entry: USAGE_ENTRYPOINT });
    expect(h.spawns[0]?.env['USAGE_SERVICE_HOST']).toBe('127.0.0.1');
    expect(h.logs.join('\n')).toContain('usage ready on http://127.0.0.1:8090');
  });

  it('forwards child output with the usage prefix', async () => {
    const child = mockChild(7100, true);
    const h = harness({ spawnImpl: () => child, probeScript: [200, 200] });
    await startUsage(h.deps, CTX);
    child.stdout.emit('Usage & Metering Service listening on http://127.0.0.1:8090\npartial');
    child.stderr.emit('diagnostic line\n');
    expect(h.logs).toContain('[usage] Usage & Metering Service listening on http://127.0.0.1:8090');
    expect(h.logs).toContain('[usage] diagnostic line');
  });

  it('treats an early child exit as a startup failure', async () => {
    const h = harness({
      spawnImpl: () => {
        const child = mockChild(7200, true);
        child.die(1);
        return child;
      },
    });
    await expect(startUsage(h.deps, CTX)).rejects.toThrow(/usage exited during startup/);
  });

  it('reports a health timeout and a readiness timeout distinctly', async () => {
    const unhealthy = harness({ probeScript: [503] });
    await expect(startUsage(unhealthy.deps, CTX)).rejects.toThrow(/never became healthy/);
    const unready = harness({ probeScript: [200, 503] });
    await expect(startUsage(unready.deps, CTX)).rejects.toThrow(/never became ready/);
  });

  it('surfaces spawn failures', async () => {
    const h = harness({ spawnThrows: true });
    await expect(startUsage(h.deps, CTX)).rejects.toThrow(/failed to spawn Usage: spawn exploded/);
  });

  it('never logs secret values', async () => {
    const child = mockChild(7300, true);
    const h = harness({ spawnImpl: () => child, probeScript: [200, 200] });
    await startUsage(h.deps, CTX);
    child.stdout.emit('diagnostic: connection established\n');
    child.stderr.emit('diagnostic: transient retry\n');
    for (const line of h.logs) {
      expect(line).not.toContain(CANARY_TOKEN);
      expect(line).not.toContain(CANARY_PASSWORD);
      expect(line).not.toContain('oicunt:pw');
    }
  });
});

describe('shutdown', () => {
  const spec = { name: 'usage', port: USAGE_PORT, entry: USAGE_ENTRYPOINT };

  it('stops gracefully with SIGTERM and reports completion', async () => {
    const clock = fakeClock();
    const logs: string[] = [];
    const exits: number[] = [];
    const child = mockChild(8000, true);
    const supervisor = superviseUsage(
      { spec, child },
      {
        sleep: clock.sleep,
        log: (line) => logs.push(line),
        now: clock.now,
        graceMs: 5000,
        onExit: (code) => exits.push(code),
      },
    );
    expect(supervisor.isStopping()).toBe(false);
    await supervisor.stop();
    expect(child.killed).toEqual(['SIGTERM']);
    expect(exits).toEqual([0]);
    expect(logs.join('\n')).toContain('stopping usage');
    expect(logs.join('\n')).toContain('usage stopped');
    expect(logs.join('\n')).not.toContain('SIGKILL');
    expect(supervisor.isStopping()).toBe(true);
  });

  it('force-kills stragglers after the grace period', async () => {
    const clock = fakeClock();
    const logs: string[] = [];
    const child = mockChild(8100, false);
    const supervisor = superviseUsage(
      { spec, child },
      { sleep: clock.sleep, log: (line) => logs.push(line), now: clock.now, graceMs: 1000 },
    );
    await supervisor.stop();
    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL']);
    expect(logs.join('\n')).toContain('did not stop, sent SIGKILL');
  });

  it('honors a repeated Ctrl+C while stopping by force-killing', async () => {
    const clock = fakeClock();
    const logs: string[] = [];
    const child = mockChild(8200, true);
    const supervisor = superviseUsage(
      { spec, child },
      { sleep: clock.sleep, log: (line) => logs.push(line), now: clock.now, graceMs: 5000 },
    );
    const first = supervisor.stop();
    await supervisor.stop(true);
    await first;
    // The first Ctrl+C already sent SIGTERM; the second force-kills.
    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL']);
    expect(logs.join('\n')).toContain('forced usage shutdown');
  });

  it('is idempotent: extra stop requests never double-signal', async () => {
    const clock = fakeClock();
    const child = mockChild(8300, true);
    const supervisor = superviseUsage(
      { spec, child },
      { sleep: clock.sleep, log: () => undefined, now: clock.now, graceMs: 1000 },
    );
    await supervisor.stop();
    await supervisor.stop();
    expect(child.killed).toEqual(['SIGTERM']);
  });
});

describe('launcher contract', () => {
  it('targets only the compiled Usage entrypoint, never the migrator', () => {
    expect(toPosix(USAGE_ENTRYPOINT).endsWith('services/usage/dist/start.js')).toBe(true);
    expect(toPosix(USAGE_ENTRYPOINT)).not.toContain('migrate');
    expect(toPosix(USAGE_ENTRYPOINT)).toContain('dist');
  });

  it('pins the local development bind', () => {
    expect(USAGE_HOST).toBe('127.0.0.1');
    expect(USAGE_PORT).toBe(8090);
  });

  it('treats the shared internal token as configuration, not a request credential', () => {
    // The launcher only resolves which variable supplies the HMAC signing
    // secret; it never compares it to request material.
    const settings: UsageSettings = resolveUsageSettings(VALID_ENV);
    expect(settings.token?.name).toBe('INTERNAL_SERVICE_TOKEN');
    expect(validateUsageSettings(settings).ok).toBe(true);
  });
});
