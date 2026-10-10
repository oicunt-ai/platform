/**
 * Pure, testable core of the Platform development launcher.
 *
 * This module performs no I/O of its own: spawning, probing, sleeping, and
 * logging are injected by the caller (`scripts/dev-up.mjs` in production,
 * fakes in tests). It never prints or returns secret values; environment
 * mappings carry values opaquely and only variable *names* appear in
 * messages.
 *
 * Intentionally independent from the AI Platform launcher: the two
 * repositories version and deploy separately, and a shared dependency
 * would couple them for dev-only tooling.
 */
import net from 'node:net';

export const LOOPBACK_HOST = '127.0.0.1';
export const HEALTH_PATH = '/healthz';
export const READY_PATH = '/readyz';

/** The development default the launcher enforces (never the stale :3001). */
export const ORCHESTRATOR_DEV_URL = 'http://127.0.0.1:3003';

/**
 * The only service `pnpm dev` starts. Platform Usage (auto-migrates) and
 * every AI Platform service (separate repository) are deliberately absent.
 */
export const DEV_SERVICES = Object.freeze([
  {
    name: 'api-gateway',
    packageDir: 'services/api-gateway',
    entry: 'dist/start.js',
    port: 3000,
  },
]);

export function serviceBaseUrl(port) {
  return `http://${LOOPBACK_HOST}:${port}`;
}

/**
 * Readiness URL for an Orchestrator base URL. URL resolution (not string
 * concatenation) guarantees exactly one slash regardless of whether the
 * base carries a trailing slash.
 */
export function orchestratorReadyUrl(base) {
  return new URL('/readyz', base).toString();
}

export function healthUrl(port) {
  return `${serviceBaseUrl(port)}${HEALTH_PATH}`;
}

export function readyUrl(port) {
  return `${serviceBaseUrl(port)}${READY_PATH}`;
}

/** Minimal KEY=VALUE parsing. Process environment always wins at merge time. */
export function parseDotEnv(text) {
  const env = {};
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim().replace(/\r$/, '');
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    env[key] = line.slice(eq + 1).trim();
  }
  return env;
}

export const REQUIRED_ENV = Object.freeze(['INTERNAL_SERVICE_TOKEN', 'JWKS_URI', 'JWT_ISSUER']);

export function missingEnv(env, names = REQUIRED_ENV) {
  return names.filter((name) => env[name] === undefined || String(env[name]).trim() === '');
}

/** Merge file and process environments. Explicit process values always win. */
export function mergeEnv(fileEnv, processEnv) {
  return { ...fileEnv, ...processEnv };
}

/**
 * Internal-token names read by the Gateway. The orchestrator-bound secret
 * falls back to the shared value outside production, matching the service
 * contract; the pair-specific name wins when the operator sets it.
 */
export const TOKEN_NAMES = Object.freeze([
  'INTERNAL_SERVICE_TOKEN',
  'INTERNAL_SERVICE_SECRET',
  'AI_ORCHESTRATOR_INTERNAL_TOKEN',
]);

export function resolveTokenEnv(env) {
  const shared = env['INTERNAL_SERVICE_TOKEN'];
  if (shared === undefined || String(shared).trim() === '') {
    return { ok: false, missing: ['INTERNAL_SERVICE_TOKEN'] };
  }
  const mapping = {};
  for (const name of TOKEN_NAMES) {
    mapping[name] = env[name] ?? shared;
  }
  return { ok: true, mapping };
}

/**
 * Resolve the Orchestrator URL the Gateway will call. Unset means the
 * enforced development default — never the stale :3001 the service config
 * falls back to. An operator-set value must parse as http(s); port 3001
 * is rejected outright because it addresses the Model Registry, not the
 * Orchestrator.
 */
export function resolveOrchestratorUrl(env) {
  const raw = env['ORCHESTRATOR_BASE_URL'];
  if (raw === undefined || String(raw).trim() === '') {
    return { ok: true, url: ORCHESTRATOR_DEV_URL };
  }
  let parsed;
  try {
    parsed = new URL(String(raw).trim());
  } catch {
    return { ok: false, reason: 'ORCHESTRATOR_BASE_URL is not a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'ORCHESTRATOR_BASE_URL must use http(s)' };
  }
  if (parsed.port === '3001') {
    return {
      ok: false,
      reason: 'ORCHESTRATOR_BASE_URL points at port 3001 (Model Registry); use :3003',
    };
  }
  return { ok: true, url: parsed.toString() };
}

/** Usage admission needs the Usage service, which this launcher never starts. */
export function admissionRequested(env) {
  return env['ENABLE_USAGE_ADMISSION'] === 'true';
}

/**
 * Build the exact child environment overlay for the Gateway from the real
 * service contract. Only contract-known variables are set; everything else
 * stays as the operator exported it.
 */
export function buildChildEnv(spec, ctx) {
  const env = ctx.env;
  const overlay = {
    PORT: String(spec.port),
    HOST: LOOPBACK_HOST,
    NODE_ENV: env['NODE_ENV'] && env['NODE_ENV'] !== '' ? env['NODE_ENV'] : 'development',
  };
  Object.assign(overlay, ctx.tokens);
  overlay['ORCHESTRATOR_BASE_URL'] = ctx.orchestratorUrl;
  // Required by the Gateway's JWKS verifier. Forgetting either variable
  // fails every JWT with 401 while looking exactly like a bad token.
  if (env['JWKS_URI'] !== undefined) {
    overlay['JWKS_URI'] = env['JWKS_URI'];
  }
  if (env['JWT_ISSUER'] !== undefined) {
    overlay['JWT_ISSUER'] = env['JWT_ISSUER'];
  }
  if (env['JWT_AUDIENCE'] !== undefined) {
    overlay['JWT_AUDIENCE'] = env['JWT_AUDIENCE'];
  }
  if (env['LOG_LEVEL'] !== undefined) {
    overlay['LOG_LEVEL'] = env['LOG_LEVEL'];
  }
  return overlay;
}

/** Raw TCP open check. No data is sent. */
export function checkTcpOpen(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      finish(false);
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.end();
      finish(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/** Single HTTP probe returning the status code, or null when unreachable. */
export async function probeOnce(url, options = {}) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.status;
  } catch {
    return null;
  }
}

/**
 * Poll `check` until it returns non-null, the optional `isAlive` fails, or
 * the budget expires. Time comes from the injectable `now` so tests run
 * without real waiting.
 */
export async function waitFor(options) {
  const { check, sleep, timeoutMs, intervalMs = 1000, isAlive = null, now = Date.now } = options;
  const start = now();
  for (;;) {
    if (isAlive !== null && !isAlive()) {
      return { ok: false, reason: 'exited' };
    }
    const value = await check();
    if (value !== null && value !== undefined) {
      return { ok: true, value };
    }
    if (now() - start >= timeoutMs) {
      return { ok: false, reason: 'timeout' };
    }
    await sleep(intervalMs);
  }
}

/** Split a child output chunk into prefixed complete lines, carrying partials. */
export function prefixLines(service, chunk, carry = '') {
  const text = `${carry}${String(chunk)}`;
  const parts = text.split('\n');
  const nextCarry = parts.pop() ?? '';
  return {
    lines: parts.map((line) => `[${service}] ${line.replace(/\r$/, '')}`),
    carry: nextCarry,
  };
}

export function shutdownOrder(records) {
  return [...records].reverse();
}

export function formatMissingEnv(names) {
  return (
    `dev-up: missing required environment: ${names.join(', ')}. ` +
    `Copy .env.example to .env and set each value (never commit secrets).`
  );
}

export function formatPortConflict(spec, health) {
  const detail = health === null ? 'not responding' : `healthz ${health}`;
  return (
    `dev-up: port ${spec.port} for ${spec.name} is already occupied (${detail}). ` +
    `Stop the existing process or free the port; refusing to start duplicates.`
  );
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start every service in order with readiness gating. Throws after
 * cleaning up already-started children. Dependencies are injected so
 * tests can drive the full sequence with fakes:
 * spawn(spec, env), checkPort(port), probe(url), sleep(ms), log(line),
 * now(), timeouts {health, ready}, intervalMs.
 */
export async function startAll(deps, ctx) {
  const services = deps.services ?? DEV_SERVICES;
  const started = [];
  const fail = async (message) => {
    const error = new Error(message);
    await shutdownAll(started, deps);
    throw error;
  };
  for (const spec of services) {
    let occupied;
    try {
      occupied = await deps.checkPort(spec.port);
    } catch {
      occupied = false;
    }
    if (occupied) {
      const health = await deps.probe(healthUrl(spec.port));
      await fail(formatPortConflict(spec, health));
    }
    let child;
    try {
      child = await deps.spawn(spec, buildChildEnv(spec, ctx));
    } catch (error) {
      await fail(`dev-up: failed to spawn ${spec.name}: ${describeError(error)}`);
    }
    started.push({ spec, child });
    const alive = () => child.exitCode === null || child.exitCode === undefined;
    const healthy = await waitFor({
      check: async () => {
        const status = await deps.probe(healthUrl(spec.port));
        return status === 200 ? true : null;
      },
      sleep: deps.sleep,
      timeoutMs: deps.timeouts.health,
      intervalMs: deps.intervalMs,
      isAlive: alive,
      now: deps.now,
    });
    if (!healthy.ok) {
      await fail(
        healthy.reason === 'exited'
          ? `dev-up: ${spec.name} exited during startup`
          : `dev-up: ${spec.name} never became healthy on port ${spec.port}`,
      );
    }
    const ready = await waitFor({
      check: async () => {
        const status = await deps.probe(readyUrl(spec.port));
        return status === 200 ? true : null;
      },
      sleep: deps.sleep,
      timeoutMs: deps.timeouts.ready,
      intervalMs: deps.intervalMs,
      isAlive: alive,
      now: deps.now,
    });
    if (!ready.ok) {
      await fail(
        ready.reason === 'exited'
          ? `dev-up: ${spec.name} exited during startup`
          : `dev-up: ${spec.name} never became ready on port ${spec.port}`,
      );
    }
    deps.log(`[dev-up] ${spec.name} ready on port ${spec.port} (pid ${child.pid ?? '?'})`);
  }
  return started;
}

/**
 * Stop started services in reverse dependency order with a bounded
 * graceful wait; force-kill stragglers and report them. Never touches
 * processes it did not start.
 */
export async function shutdownAll(records, deps) {
  const graceMs = deps.graceMs ?? 10000;
  for (const { spec, child } of shutdownOrder(records)) {
    if (child.exitCode !== null && child.exitCode !== undefined) {
      continue;
    }
    try {
      child.kill('SIGTERM');
    } catch {
      continue;
    }
    const stopped = await waitFor({
      check: async () => (child.exitCode === null || child.exitCode === undefined ? null : true),
      sleep: deps.sleep,
      timeoutMs: graceMs,
      intervalMs: 250,
      now: deps.now,
    });
    if (!stopped.ok) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone; fall through to the report.
      }
      deps.log(`[dev-up] ${spec.name} (pid ${child.pid ?? '?'}) did not stop, sent SIGKILL`);
    } else {
      deps.log(`[dev-up] ${spec.name} stopped`);
    }
  }
}

/**
 * Attach unexpected-death supervision to running children. Returns a
 * detach function. The callback decides the response (the CLI performs
 * controlled cleanup); nothing is restarted, ever.
 */
export function watchChildren(records, onDeath) {
  const attached = [];
  for (const { spec, child } of records) {
    if (typeof child.on !== 'function') {
      continue;
    }
    const handler = (code, signal) => onDeath(spec, code, signal);
    child.on('exit', handler);
    attached.push([child, handler]);
  }
  return () => {
    for (const [child, handler] of attached) {
      if (typeof child.off === 'function') {
        child.off('exit', handler);
      }
    }
  };
}
