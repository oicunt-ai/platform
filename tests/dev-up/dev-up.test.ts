/**
 * Focused tests for the Platform development launcher core
 * (`scripts/dev-up-lib.mjs`).
 *
 * All I/O is faked: mock child processes, scripted probes, a fake clock.
 * The only real I/O is a loopback TCP open/close pair for checkTcpOpen.
 * Fixture secrets are throwaway values; one test asserts they never leak
 * into launcher log output. The Usage service is never started here.
 */
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  DEV_SERVICES,
  ORCHESTRATOR_DEV_URL,
  REQUIRED_ENV,
  admissionRequested,
  buildChildEnv,
  checkTcpOpen,
  formatMissingEnv,
  formatPortConflict,
  healthUrl,
  mergeEnv,
  missingEnv,
  orchestratorReadyUrl,
  parseDotEnv,
  prefixLines,
  probeOnce,
  readyUrl,
  resolveOrchestratorUrl,
  resolveTokenEnv,
  serviceBaseUrl,
  shutdownAll,
  shutdownOrder,
  startAll,
  waitFor,
  watchChildren,
  type ChildRef,
  type ServiceSpec,
  type StartedService,
} from '../../scripts/dev-up-lib.mjs';

const SHARED_TOKEN = 'test-shared-token-value';
const BASE_ENV: Record<string, string> = {
  INTERNAL_SERVICE_TOKEN: SHARED_TOKEN,
  JWKS_URI: 'http://127.0.0.1:4567/.well-known/jwks.json',
  JWT_ISSUER: 'http://127.0.0.1:4567',
};
const TOKENS: Record<string, string> = (() => {
  const resolved = resolveTokenEnv({ ...BASE_ENV });
  if (!resolved.ok) {
    throw new Error('fixture tokens must resolve');
  }
  return resolved.mapping;
})();
const CTX = {
  env: { ...BASE_ENV },
  tokens: TOKENS,
  orchestratorUrl: ORCHESTRATOR_DEV_URL,
};

function fakeClock() {
  let nowValue = 0;
  return {
    now: () => nowValue,
    sleep: async (ms: number) => {
      nowValue += ms;
    },
  };
}

interface MockChild extends ChildRef {
  readonly killed: string[];
  die: (code: number | null) => void;
  emitExit: (code: unknown) => void;
}

function mockChild(pid: number, autoExit: boolean): MockChild {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const child: MockChild = {
    pid,
    exitCode: null,
    killed: [],
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
      if (autoExit) {
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
    emitExit: (code: unknown) => {
      for (const listener of listeners.get('exit') ?? []) {
        listener(code, null);
      }
    },
  };
  return child;
}

describe('service table', () => {
  it('starts the Gateway only, never Usage or AI services', () => {
    expect(DEV_SERVICES.map((s) => `${s.name}:${s.port}`)).toEqual(['api-gateway:3000']);
    const names = DEV_SERVICES.map((s) => s.name);
    expect(names).not.toContain('usage');
    expect(names).not.toContain('orchestrator');
    expect(names).not.toContain('registry');
  });

  it('builds loopback health URLs', () => {
    expect(serviceBaseUrl(3000)).toBe('http://127.0.0.1:3000');
    expect(healthUrl(3000)).toBe('http://127.0.0.1:3000/healthz');
    expect(readyUrl(3000)).toBe('http://127.0.0.1:3000/readyz');
  });
});

describe('environment handling', () => {
  it('parses KEY=VALUE files and skips noise', () => {
    expect(parseDotEnv('# c\n\nJWKS_URI=http://x\nEMPTY=\nNOPE\nK=v=w\n')).toEqual({
      JWKS_URI: 'http://x',
      EMPTY: '',
      K: 'v=w',
    });
  });

  it('requires the Gateway identity variables by name', () => {
    expect(missingEnv({})).toEqual([...REQUIRED_ENV]);
    expect(REQUIRED_ENV).toEqual(['INTERNAL_SERVICE_TOKEN', 'JWKS_URI', 'JWT_ISSUER']);
    expect(missingEnv({ ...BASE_ENV })).toEqual([]);
    expect(formatMissingEnv(['JWKS_URI'])).toContain('JWKS_URI');
  });

  it('maps the shared token onto Gateway token names', () => {
    const resolved = resolveTokenEnv({ ...BASE_ENV });
    if (!resolved.ok) {
      throw new Error('expected ok');
    }
    expect(resolved.mapping['INTERNAL_SERVICE_TOKEN']).toBe(SHARED_TOKEN);
    expect(resolved.mapping['INTERNAL_SERVICE_SECRET']).toBe(SHARED_TOKEN);
    expect(resolved.mapping['AI_ORCHESTRATOR_INTERNAL_TOKEN']).toBe(SHARED_TOKEN);
    expect(resolveTokenEnv({})).toEqual({
      ok: false,
      missing: ['INTERNAL_SERVICE_TOKEN'],
    });
  });

  it('resolves the Orchestrator URL with the stale-default trap closed', () => {
    expect(resolveOrchestratorUrl({})).toEqual({ ok: true, url: ORCHESTRATOR_DEV_URL });
    expect(ORCHESTRATOR_DEV_URL).toBe('http://127.0.0.1:3003');
    expect(resolveOrchestratorUrl({ ORCHESTRATOR_BASE_URL: 'http://127.0.0.1:3100' })).toEqual({
      ok: true,
      url: 'http://127.0.0.1:3100/',
    });
    const badPort = resolveOrchestratorUrl({ ORCHESTRATOR_BASE_URL: 'http://127.0.0.1:3001' });
    expect(badPort.ok).toBe(false);
    const garbage = resolveOrchestratorUrl({ ORCHESTRATOR_BASE_URL: 'not a url' });
    expect(garbage.ok).toBe(false);
    const scheme = resolveOrchestratorUrl({ ORCHESTRATOR_BASE_URL: 'ftp://x/' });
    expect(scheme.ok).toBe(false);
  });

  it('detects requested usage admission so the CLI can refuse it', () => {
    expect(admissionRequested({})).toBe(false);
    expect(admissionRequested({ ENABLE_USAGE_ADMISSION: 'true' })).toBe(true);
    expect(admissionRequested({ ENABLE_USAGE_ADMISSION: 'false' })).toBe(false);
  });

  it('builds readiness URLs with exactly one slash for every base form', () => {
    const expected = 'http://127.0.0.1:3003/readyz';
    // Explicit URL without trailing slash.
    expect(orchestratorReadyUrl('http://127.0.0.1:3003')).toBe(expected);
    // Explicit URL with trailing slash (previously produced //readyz → 404).
    expect(orchestratorReadyUrl('http://127.0.0.1:3003/')).toBe(expected);
    // Default/fallback URL constant.
    expect(orchestratorReadyUrl(ORCHESTRATOR_DEV_URL)).toBe(expected);
    // Invalid bases throw instead of producing a malformed URL.
    expect(() => orchestratorReadyUrl('not a url')).toThrow();
    expect(() => orchestratorReadyUrl('')).toThrow();
  });

  it('forwards JWKS_URI and JWT_ISSUER to the Gateway child', () => {
    const spec = DEV_SERVICES[0];
    if (!spec) {
      throw new Error('table incomplete');
    }
    const childEnv = buildChildEnv(spec, {
      env: { ...BASE_ENV },
      tokens: TOKENS,
      orchestratorUrl: ORCHESTRATOR_DEV_URL,
    });
    expect(childEnv['JWKS_URI']).toBe('http://127.0.0.1:4567/.well-known/jwks.json');
    expect(childEnv['JWT_ISSUER']).toBe('http://127.0.0.1:4567');
  });

  it('forwards file-only values without requiring shell exports', () => {
    // Regression: the launcher once validated these names yet dropped them
    // from the child environment, failing every JWT with a 401 that looked
    // like a bad token. Values present only in the merged (file-sourced)
    // env must reach the child.
    const fileEnv = {
      JWKS_URI: 'http://127.0.0.1:4567/.well-known/jwks.json',
      JWT_ISSUER: 'http://127.0.0.1:4567',
      INTERNAL_SERVICE_TOKEN: 'file-token',
    };
    const merged = mergeEnv(fileEnv, {});
    expect(missingEnv(merged)).toEqual([]);
    const spec = DEV_SERVICES[0];
    if (!spec) {
      throw new Error('table incomplete');
    }
    const resolved = resolveTokenEnv(merged);
    if (!resolved.ok) {
      throw new Error('expected ok');
    }
    const childEnv = buildChildEnv(spec, {
      env: merged,
      tokens: resolved.mapping,
      orchestratorUrl: ORCHESTRATOR_DEV_URL,
    });
    expect(childEnv['JWKS_URI']).toBe('http://127.0.0.1:4567/.well-known/jwks.json');
    expect(childEnv['JWT_ISSUER']).toBe('http://127.0.0.1:4567');
    expect(childEnv['INTERNAL_SERVICE_TOKEN']).toBe('file-token');
  });

  it('keeps documented process-over-file precedence', () => {
    expect(mergeEnv({ A: 'file', B: 'file' }, { B: 'process', C: 'process' })).toEqual({
      A: 'file',
      B: 'process',
      C: 'process',
    });
  });

  it('builds the Gateway child environment from its contract', () => {
    const spec = DEV_SERVICES[0];
    if (!spec) {
      throw new Error('table incomplete');
    }
    const childEnv = buildChildEnv(spec, {
      env: { ...BASE_ENV, NODE_ENV: '', LOG_LEVEL: 'debug' },
      tokens: TOKENS,
      orchestratorUrl: ORCHESTRATOR_DEV_URL,
    });
    expect(childEnv['PORT']).toBe('3000');
    expect(childEnv['HOST']).toBe('127.0.0.1');
    expect(childEnv['NODE_ENV']).toBe('development');
    expect(childEnv['ORCHESTRATOR_BASE_URL']).toBe('http://127.0.0.1:3003');
    expect(childEnv['INTERNAL_SERVICE_TOKEN']).toBe(SHARED_TOKEN);
    expect(childEnv['AI_ORCHESTRATOR_INTERNAL_TOKEN']).toBe(SHARED_TOKEN);
    expect(childEnv['LOG_LEVEL']).toBe('debug');
    expect(childEnv['DATABASE_HOST']).toBeUndefined();
    expect(childEnv['ENABLE_USAGE_ADMISSION']).toBeUndefined();

    const custom = buildChildEnv(spec, {
      env: { ...BASE_ENV, NODE_ENV: 'staging', JWT_AUDIENCE: 'custom-aud' },
      tokens: { ...TOKENS, AI_ORCHESTRATOR_INTERNAL_TOKEN: 'operator-value' },
      orchestratorUrl: 'http://127.0.0.1:3100/',
    });
    expect(custom['NODE_ENV']).toBe('staging');
    expect(custom['JWT_AUDIENCE']).toBe('custom-aud');
    expect(custom['AI_ORCHESTRATOR_INTERNAL_TOKEN']).toBe('operator-value');
    expect(custom['ORCHESTRATOR_BASE_URL']).toBe('http://127.0.0.1:3100/');
  });
});

describe('probes and waits', () => {
  it('probeOnce maps status codes and transport failures', async () => {
    const okFetch = (async () => ({ status: 200 })) as unknown as typeof fetch;
    expect(await probeOnce('http://x', { fetchFn: okFetch })).toBe(200);
    const badFetch = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(await probeOnce('http://x', { fetchFn: badFetch })).toBeNull();
  });

  it('waitFor resolves on first value and stays bounded on timeout', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await waitFor({
      check: async () => {
        calls += 1;
        return calls >= 2 ? 'ready' : null;
      },
      sleep: clock.sleep,
      timeoutMs: 5000,
      intervalMs: 100,
      now: clock.now,
    });
    expect(result).toEqual({ ok: true, value: 'ready' });

    const clock2 = fakeClock();
    let sleptTotal = 0;
    const timed = await waitFor({
      check: async () => null,
      sleep: async (ms: number) => {
        sleptTotal += ms;
        await clock2.sleep(ms);
      },
      timeoutMs: 5000,
      intervalMs: 1000,
      now: clock2.now,
    });
    expect(timed).toEqual({ ok: false, reason: 'timeout' });
    expect(sleptTotal).toBeLessThanOrEqual(6000);
  });

  it('waitFor reports early process exit', async () => {
    const clock = fakeClock();
    expect(
      await waitFor({
        check: async () => null,
        sleep: clock.sleep,
        timeoutMs: 5000,
        now: clock.now,
        isAlive: () => false,
      }),
    ).toEqual({ ok: false, reason: 'exited' });
  });

  it('checkTcpOpen distinguishes open from closed loopback ports', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('no address');
    }
    expect(await checkTcpOpen('127.0.0.1', address.port, 1000)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await checkTcpOpen('127.0.0.1', address.port, 500)).toBe(false);
  });

  it('prefixLines splits, prefixes, and carries partials', () => {
    const first = prefixLines('api-gateway', 'a\nb\r\npartial');
    expect(first.lines).toEqual(['[api-gateway] a', '[api-gateway] b']);
    expect(prefixLines('api-gateway', '-done\n', first.carry).lines).toEqual([
      '[api-gateway] partial-done',
    ]);
  });
});

describe('startup orchestration', () => {
  function harness(
    options: {
      services?: ServiceSpec[];
      probeScript?: Array<number | null>;
      checkPort?: boolean;
      spawnImpl?: (spec: ServiceSpec) => MockChild;
    } = {},
  ) {
    const clock = fakeClock();
    const spawns: Array<{ spec: ServiceSpec; env: Record<string, string> }> = [];
    const logs: string[] = [];
    const children = new Map<string, MockChild>();
    let nextPid = 5000;
    const deps = {
      spawn: (spec: ServiceSpec, env: Record<string, string>) => {
        spawns.push({ spec, env });
        const child = options.spawnImpl ? options.spawnImpl(spec) : mockChild((nextPid += 1), true);
        children.set(spec.name, child);
        return child;
      },
      checkPort: async (_port: number) => options.checkPort ?? false,
      probe: scriptedProbe(options.probeScript ?? [200]).probe,
      sleep: clock.sleep,
      log: (line: string) => {
        logs.push(line);
      },
      now: clock.now,
      services: options.services,
      timeouts: { health: 5000, ready: 10000 },
      intervalMs: 100,
    };
    return { deps, spawns, logs, children, ctx: CTX };
  }

  function scriptedProbe(script: Array<number | null>) {
    let calls = 0;
    const probe = async (_url: string): Promise<number | null> => {
      const index = Math.min(calls, script.length - 1);
      calls += 1;
      return script[index] ?? null;
    };
    return { probe, calls: () => calls };
  }

  it('starts exactly the Gateway with gated probes', async () => {
    const h = harness({ probeScript: [503, 200, 503, 200] });
    const started: StartedService[] = await startAll(h.deps, h.ctx);
    expect(h.spawns.map((s) => s.spec.name)).toEqual(['api-gateway']);
    expect(started).toHaveLength(1);
    expect(h.spawns[0]?.env['ORCHESTRATOR_BASE_URL']).toBe('http://127.0.0.1:3003');
  });

  it('refuses duplicate ports without spawning', async () => {
    const h = harness({ checkPort: true, probeScript: [200] });
    await expect(startAll(h.deps, h.ctx)).rejects.toThrow(/port 3000.*already occupied/);
    expect(h.spawns).toHaveLength(0);
  });

  it('treats early child exit as startup failure', async () => {
    const h = harness({
      spawnImpl: () => {
        const child = mockChild(6000, true);
        child.die(1);
        return child;
      },
    });
    await expect(startAll(h.deps, h.ctx)).rejects.toThrow(/exited during startup/);
  });

  it('never logs secret values', async () => {
    const canaryEnv = {
      ...BASE_ENV,
      INTERNAL_SERVICE_TOKEN: 'canary-secret-token-xyz',
      JWKS_URI: 'http://127.0.0.1:4567/.well-known/jwks.json',
    };
    const clock = fakeClock();
    const logs: string[] = [];
    const deps = {
      spawn: (_spec: ServiceSpec, _env: Record<string, string>) => mockChild(7000, true),
      checkPort: async (_port: number) => false,
      probe: async (_url: string) => 200,
      sleep: clock.sleep,
      log: (line: string) => {
        logs.push(line);
      },
      now: clock.now,
      timeouts: { health: 5000, ready: 10000 },
      intervalMs: 100,
    };
    const resolved = resolveTokenEnv(canaryEnv);
    if (!resolved.ok) {
      throw new Error('expected ok');
    }
    await startAll(deps, {
      env: canaryEnv,
      tokens: resolved.mapping,
      orchestratorUrl: ORCHESTRATOR_DEV_URL,
    });
    for (const line of logs) {
      expect(line).not.toContain('canary-secret-token-xyz');
    }
  });
});

describe('shutdown', () => {
  it('stops the single child gracefully without force', async () => {
    const clock = fakeClock();
    const logs: string[] = [];
    const child = mockChild(8000, true);
    await shutdownAll(
      [{ spec: { name: 'api-gateway', packageDir: 's', entry: 'e', port: 3000 }, child }],
      {
        sleep: clock.sleep,
        log: (line: string) => {
          logs.push(line);
        },
        now: clock.now,
        graceMs: 5000,
      },
    );
    expect(child.killed).toEqual(['SIGTERM']);
    expect(logs.join('\n')).toContain('api-gateway stopped');
    expect(logs.join('\n')).not.toContain('SIGKILL');
  });

  it('force-kills and reports stragglers after the grace period', async () => {
    const clock = fakeClock();
    const logs: string[] = [];
    const stuck = mockChild(9000, false);
    await shutdownAll(
      [{ spec: { name: 'stuck', packageDir: 's', entry: 'e', port: 1 }, child: stuck }],
      {
        sleep: clock.sleep,
        log: (line: string) => logs.push(line),
        now: clock.now,
        graceMs: 1000,
      },
    );
    expect(stuck.killed).toEqual(['SIGTERM', 'SIGKILL']);
    expect(logs.join('\n')).toContain('did not stop, sent SIGKILL');
  });

  it('shutdownOrder reverses without mutating', () => {
    const input = [{ name: 'a' }, { name: 'b' }];
    expect(shutdownOrder(input)).toEqual([{ name: 'b' }, { name: 'a' }]);
    expect(input).toEqual([{ name: 'a' }, { name: 'b' }]);
  });

  it('watchChildren reports unexpected death and detaches cleanly', () => {
    const child = mockChild(9100, true);
    const seen: Array<{ name: string; code: unknown }> = [];
    const detach = watchChildren(
      [{ spec: { name: 'gw', packageDir: 's', entry: 'e', port: 1 }, child }],
      (spec, code) => {
        seen.push({ name: spec.name, code });
      },
    );
    child.emitExit(3);
    expect(seen).toEqual([{ name: 'gw', code: 3 }]);
    detach();
    child.emitExit(4);
    expect(seen).toEqual([{ name: 'gw', code: 3 }]);
  });

  it('formatPortConflict names the port, service, and health', () => {
    const text = formatPortConflict(
      { name: 'api-gateway', packageDir: 's', entry: 'e', port: 3000 },
      200,
    );
    expect(text).toContain('3000');
    expect(text).toContain('api-gateway');
    expect(text).toContain('200');
    expect(formatPortConflict({ name: 'x', packageDir: 's', entry: 'e', port: 1 }, null)).toContain(
      'not responding',
    );
  });
});
