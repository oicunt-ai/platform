import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOOPBACK_HOST,
  checkTcpOpen,
  mergeEnv,
  parseDotEnv,
  prefixLines,
  probeOnce,
  waitFor,
  watchChildren,
} from './dev-up-lib.mjs';

/**
 * Official Platform Usage launcher (`pnpm usage`).
 *
 * Loads the platform-owned `.env`, validates the exact configuration the
 * Usage service contract requires (internal authentication, PostgreSQL,
 * RabbitMQ), enforces the local loopback bind (127.0.0.1:8090), checks the
 * compiled entrypoint and the port, then supervises the single Usage child
 * process with Ctrl+C shutdown.
 *
 * Contracts honored here:
 * - Migrations are NEVER executed by this launcher. It spawns only
 *   `services/usage/dist/start.js`; schema changes run exclusively through
 *   `pnpm --filter @oicunt/service-usage migrate`, and the stale
 *   `USAGE_AUTO_MIGRATE` toggle is refused outright.
 * - The internal token is the HS256 signing secret for signed internal
 *   service JWTs (`aud: platform-usage`, `sub: api-gateway`). The launcher
 *   only forwards configuration; it never sends the secret anywhere and
 *   never treats it as a raw request token.
 * - `USAGE_DB_*` always wins over `DATABASE_*`, matching the service.
 * - Values are never logged: problems name variables, never contents.
 */

const SERVICE = 'usage';
const LAUNCHER = 'usage-up';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Local development bind contract: loopback only, never all interfaces. */
export const USAGE_HOST = LOOPBACK_HOST;
export const USAGE_PORT = 8090;
/** The only process this launcher may ever start. */
export const USAGE_ENTRYPOINT = join(REPO_ROOT, 'services', 'usage', 'dist', 'start.js');

export const USAGE_TOKEN_NAMES = Object.freeze([
  'PLATFORM_USAGE_INTERNAL_TOKEN',
  'INTERNAL_SERVICE_TOKEN',
  'USAGE_INTERNAL_TOKEN',
]);

export const USAGE_DB_NAMES = Object.freeze({
  host: Object.freeze(['USAGE_DB_HOST', 'DATABASE_HOST']),
  port: Object.freeze(['USAGE_DB_PORT', 'DATABASE_PORT']),
  user: Object.freeze(['USAGE_DB_USER', 'DATABASE_USER']),
  password: Object.freeze(['USAGE_DB_PASSWORD', 'DATABASE_PASSWORD']),
});

export function cleanValue(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

/** First configured (non-blank) entry among `names`; blank means unset. */
export function firstNameValue(env, names) {
  for (const name of names) {
    const value = cleanValue(env[name]);
    if (value !== undefined) {
      return { name, value };
    }
  }
  return null;
}

export function parsePortValue(value) {
  const text = cleanValue(value);
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Mirrors the service contract: explicit amqp(s):// URL with a host. */
export function isBrokerUrl(value) {
  const text = cleanValue(value);
  if (text === undefined) {
    return false;
  }
  try {
    const parsed = new URL(text);
    return (
      (parsed.protocol === 'amqp:' || parsed.protocol === 'amqps:') && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Read-only view of the launcher's required configuration. Only names and
 * validation outcomes are ever turned into messages.
 */
export function resolveUsageSettings(env) {
  return {
    nodeEnv: cleanValue(env['NODE_ENV']) ?? 'development',
    token: firstNameValue(env, USAGE_TOKEN_NAMES),
    db: {
      host: firstNameValue(env, USAGE_DB_NAMES.host),
      port: firstNameValue(env, USAGE_DB_NAMES.port),
      user: firstNameValue(env, USAGE_DB_NAMES.user),
      password: firstNameValue(env, USAGE_DB_NAMES.password),
    },
    rabbitUrl: firstNameValue(env, ['RABBITMQ_URL']),
    bindHost: cleanValue(env['USAGE_SERVICE_HOST']),
    bindPort: parsePortValue(env['USAGE_SERVICE_PORT']),
    useDatabase: cleanValue(env['USE_DATABASE']),
    useRabbitMq: cleanValue(env['USE_RABBITMQ']),
    autoMigrate: cleanValue(env['USAGE_AUTO_MIGRATE']),
  };
}

/** Fail-closed preflight. Problems name variables; they never print values. */
export function validateUsageSettings(settings) {
  const problems = [];

  if (settings.nodeEnv === 'production') {
    problems.push('NODE_ENV=production is refused: this is a local development launcher');
  }
  if (settings.useDatabase === 'false') {
    problems.push(
      'USE_DATABASE=false is refused: this launcher always runs Usage against PostgreSQL',
    );
  }
  if (settings.useRabbitMq === 'false') {
    problems.push(
      'USE_RABBITMQ=false is refused: this launcher always runs Usage against RabbitMQ',
    );
  }
  if (settings.autoMigrate !== undefined) {
    problems.push(
      'USAGE_AUTO_MIGRATE is no longer supported; apply migrations only with ' +
        '`pnpm --filter @oicunt/service-usage migrate`',
    );
  }

  if (settings.token === null) {
    problems.push(
      'internal authentication: set PLATFORM_USAGE_INTERNAL_TOKEN (or INTERNAL_SERVICE_TOKEN, ' +
        'or USAGE_INTERNAL_TOKEN) — the shared value is the HMAC signing secret for signed ' +
        'internal JWTs, never a raw request token',
    );
  }

  for (const key of ['host', 'user', 'password']) {
    if (settings.db[key] === null) {
      const [preferred, fallback] = USAGE_DB_NAMES[key];
      problems.push(`${preferred} (or ${fallback})`);
    }
  }
  if (settings.db.port === null) {
    problems.push('USAGE_DB_PORT (or DATABASE_PORT, integer 1-65535)');
  } else if (!isValidPort(Number(settings.db.port.value))) {
    problems.push('USAGE_DB_PORT (or DATABASE_PORT, integer 1-65535) is configured out of range');
  }

  if (settings.rabbitUrl === null) {
    problems.push('RABBITMQ_URL');
  } else if (!isBrokerUrl(settings.rabbitUrl.value)) {
    problems.push('RABBITMQ_URL (valid amqp:// or amqps:// URL)');
  }

  // Loopback-only development contract: refuse conflicting bind settings
  // rather than silently overriding the operator.
  if (settings.bindHost !== undefined && settings.bindHost !== USAGE_HOST) {
    problems.push(
      `USAGE_SERVICE_HOST must be ${USAGE_HOST} for this local launcher (configured: ${settings.bindHost})`,
    );
  }
  if (settings.bindPort !== undefined && settings.bindPort !== USAGE_PORT) {
    problems.push(
      `USAGE_SERVICE_PORT must be ${USAGE_PORT} for this local launcher (configured: ${settings.bindPort})`,
    );
  }

  return { ok: problems.length === 0, problems };
}

export function validateUsageEnv(env) {
  return validateUsageSettings(resolveUsageSettings(env));
}

/**
 * Child environment: the merged environment passes through untouched
 * (including USAGE_DB_* precedence handled by the service), with the
 * loopback bind pinned. Undefined entries are dropped so nothing is ever
 * coerced into the string 'undefined'.
 */
export function buildUsageChildEnv(env) {
  const child = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    child[key] = String(value);
  }
  child['NODE_ENV'] = cleanValue(env['NODE_ENV']) ?? 'development';
  child['USAGE_SERVICE_HOST'] = USAGE_HOST;
  child['USAGE_SERVICE_PORT'] = String(USAGE_PORT);
  return child;
}

/**
 * Start the single Usage child with readiness gating. Dependencies are
 * injected so tests drive the whole sequence with fakes:
 * exists(path), checkPort(port), spawn(entry, env), probe(url), sleep(ms),
 * log(line), now(), intervalMs, timeouts {health, ready}.
 */
export async function startUsage(deps, ctx) {
  if (!deps.exists(ctx.entry)) {
    throw new Error(
      `${LAUNCHER}: missing compiled entrypoint ${ctx.entry} (run \`pnpm build\` first)`,
    );
  }

  let occupied;
  try {
    occupied = await deps.checkPort(USAGE_PORT);
  } catch {
    occupied = false;
  }
  if (occupied) {
    throw new Error(
      `${LAUNCHER}: port ${USAGE_PORT} is already occupied. Stop the existing process or free ` +
        'the port; refusing to start duplicates.',
    );
  }

  const spec = { name: SERVICE, port: USAGE_PORT, entry: ctx.entry };
  let child;
  try {
    child = await deps.spawn(ctx.entry, buildUsageChildEnv(ctx.env));
  } catch (error) {
    throw new Error(
      `${LAUNCHER}: failed to spawn Usage: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const record = { spec, child };

  const attach = (stream) => {
    if (!stream || typeof stream.on !== 'function') {
      return;
    }
    let carry = '';
    stream.on('data', (chunk) => {
      const result = prefixLines(SERVICE, chunk, carry);
      carry = result.carry;
      for (const line of result.lines) {
        deps.log(line);
      }
    });
  };
  attach(child.stdout);
  attach(child.stderr);

  const alive = () => child.exitCode === null || child.exitCode === undefined;
  const base = `http://${USAGE_HOST}:${USAGE_PORT}`;

  const healthy = await waitFor({
    check: async () => ((await deps.probe(`${base}/healthz`)) === 200 ? true : null),
    sleep: deps.sleep,
    timeoutMs: deps.timeouts.health,
    intervalMs: deps.intervalMs ?? 500,
    isAlive: alive,
    now: deps.now ?? Date.now,
  });
  if (!healthy.ok) {
    throw new Error(
      healthy.reason === 'exited'
        ? `${LAUNCHER}: usage exited during startup`
        : `${LAUNCHER}: usage never became healthy on ${base}/healthz`,
    );
  }

  const ready = await waitFor({
    check: async () => ((await deps.probe(`${base}/readyz`)) === 200 ? true : null),
    sleep: deps.sleep,
    timeoutMs: deps.timeouts.ready,
    intervalMs: deps.intervalMs ?? 500,
    isAlive: alive,
    now: deps.now ?? Date.now,
  });
  if (!ready.ok) {
    throw new Error(
      ready.reason === 'exited'
        ? `${LAUNCHER}: usage exited during startup`
        : `${LAUNCHER}: usage never became ready on ${base}/readyz`,
    );
  }

  deps.log(`[${LAUNCHER}] usage ready on ${base} (pid ${child.pid ?? '?'})`);
  return record;
}

/**
 * Graceful shutdown for the single Usage child. The first request waits out
 * the grace period (SIGTERM, then SIGKILL for stragglers); a repeated
 * request while stopping force-kills immediately. Idempotent.
 */
export function superviseUsage(record, deps) {
  let stopping = false;
  const stop = async (force = false) => {
    if (stopping) {
      // A repeated Ctrl+C while stopping force-kills immediately.
      if (force) {
        try {
          record.child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        deps.log(`[${LAUNCHER}] forced usage shutdown`);
      }
      return;
    }
    stopping = true;
    const child = record.child;
    deps.log(`[${LAUNCHER}] stopping usage (press Ctrl+C again to force)`);
    if (child.exitCode === null || child.exitCode === undefined) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone; fall through to the report.
      }
      const stopped = await waitFor({
        check: async () => (child.exitCode === null || child.exitCode === undefined ? null : true),
        sleep: deps.sleep,
        timeoutMs: force ? 0 : (deps.graceMs ?? 10000),
        intervalMs: 250,
        now: deps.now ?? Date.now,
      });
      if (!stopped.ok) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone; fall through to the report.
        }
        deps.log(`[${LAUNCHER}] usage (pid ${child.pid ?? '?'}) did not stop, sent SIGKILL`);
      } else {
        deps.log(`[${LAUNCHER}] usage stopped`);
      }
    }
    if (deps.onExit) {
      deps.onExit(0);
    }
  };
  return { stop, isStopping: () => stopping };
}

function printUsage() {
  console.log(
    [
      'Usage: pnpm usage',
      '',
      'Starts the Platform Usage service (127.0.0.1:8090) from the platform',
      'owned .env, with the loopback bind enforced.',
      '',
      'Required in .env (USAGE_DB_* wins over DATABASE_*):',
      '  PLATFORM_USAGE_INTERNAL_TOKEN or INTERNAL_SERVICE_TOKEN',
      '  USAGE_DB_HOST/PORT/USER/PASSWORD (or DATABASE_HOST/PORT/USER/PASSWORD)',
      '  RABBITMQ_URL (amqp:// or amqps://, no implicit broker)',
      'Optional: USAGE_DB_NAME (defaults to oicunt_usage), LOG_LEVEL.',
      '',
      'The token is the HMAC signing secret for signed internal service JWTs',
      '(aud platform-usage, sub api-gateway); requests never carry it raw.',
      '',
      'The launcher refuses NODE_ENV=production, USE_DATABASE=false,',
      'USE_RABBITMQ=false, USAGE_AUTO_MIGRATE, non-loopback bind settings,',
      'a missing build, and an occupied port. It never applies migrations:',
      'schema changes run only via',
      '`pnpm --filter @oicunt/service-usage migrate`. Ctrl+C stops Usage.',
    ].join('\n'),
  );
}

function fail(message) {
  console.error(`[${LAUNCHER}] ${message}`);
  process.exit(1);
}

function spawnUsageChild(entry, env) {
  return spawn(process.execPath, [entry], {
    cwd: dirname(entry),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  if (args.length > 0) {
    fail(`unknown argument '${args[0]}' (see --help)`);
  }

  const envPath = join(REPO_ROOT, '.env');
  if (!existsSync(envPath)) {
    fail(
      `missing ${envPath}. Copy .env.example to .env and set the Usage variables (never commit secrets).`,
    );
  }
  // Explicit process environment always wins over the .env file.
  const env = mergeEnv(parseDotEnv(readFileSync(envPath, 'utf8')), process.env);

  const validation = validateUsageEnv(env);
  if (!validation.ok) {
    fail(`configuration is incomplete or conflicting:\n  - ${validation.problems.join('\n  - ')}`);
  }

  const record = await startUsage(
    {
      exists: existsSync,
      checkPort: (port) => checkTcpOpen(USAGE_HOST, port),
      spawn: spawnUsageChild,
      probe: (url) => probeOnce(url),
      sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
      log: (line) => console.log(line),
      intervalMs: 500,
      timeouts: { health: 30000, ready: 30000 },
    },
    { entry: USAGE_ENTRYPOINT, env },
  );

  const supervisor = superviseUsage(record, {
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    log: (line) => console.log(line),
    graceMs: 10000,
    onExit: (code) => process.exit(code),
  });

  watchChildren([record], (_spec, code) => {
    console.error(`[${LAUNCHER}] usage exited unexpectedly (code ${code ?? '?'}); shutting down`);
    process.exit(typeof code === 'number' ? code : 1);
  });

  let signals = 0;
  const onSignal = () => {
    signals += 1;
    void supervisor.stop(signals > 1);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  console.log(`[${LAUNCHER}] press Ctrl+C to stop`);
  // Hold the foreground parent alive; the child shares this console.
  await new Promise(() => {
    // Intentionally never resolved; SIGINT/SIGTERM end the process.
  });
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
