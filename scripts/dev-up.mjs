/**
 * Platform development launcher: `pnpm dev`.
 *
 * Starts the Platform API Gateway (3000) with readiness gating, then
 * supervises it in the foreground until Ctrl+C. Node.js standard library
 * only; no process managers, no new dependencies.
 *
 * Safety: never migrates, seeds, or touches Docker. Never starts Platform
 * Usage (its boot-time migration needs separate authorization) and never
 * starts AI Platform services (separate repository). Refuses
 * NODE_ENV=production. Binds loopback only.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEV_SERVICES,
  admissionRequested,
  checkTcpOpen,
  formatMissingEnv,
  mergeEnv,
  missingEnv,
  orchestratorReadyUrl,
  parseDotEnv,
  prefixLines,
  probeOnce,
  resolveOrchestratorUrl,
  resolveTokenEnv,
  shutdownAll,
  startAll,
  watchChildren,
} from './dev-up-lib.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEALTH_TIMEOUT_MS = 60000;
const READY_TIMEOUT_MS = 120000;
const POLL_INTERVAL_MS = 1000;
const SHUTDOWN_GRACE_MS = 10000;
const DEPENDENCY_TIMEOUT_MS = 20000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printUsage() {
  console.log(
    [
      'Usage: pnpm dev',
      '',
      'Starts the Platform API Gateway (3000) with readiness gating.',
      '',
      'Prerequisites: AI Platform stack via its own launcher (or equivalent)',
      'so the Orchestrator answers, a repo .env with INTERNAL_SERVICE_TOKEN,',
      'JWKS_URI, and JWT_ISSUER set (see .env.example), and a built gateway',
      '(`pnpm build`). Stays in the foreground; Ctrl+C stops the Gateway.',
      '',
      'Platform Usage is never started by this launcher: its startup runs',
      'database migrations, which need separate authorization.',
    ].join('\n'),
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  if (args.length > 0) {
    fail(`dev-up: unknown argument '${args[0]}' (see --help)`);
  }
  if (process.env['NODE_ENV'] === 'production') {
    fail('dev-up: refusing to run the development launcher with NODE_ENV=production');
  }

  let fileEnv = {};
  const envPath = join(REPO_ROOT, '.env');
  if (existsSync(envPath)) {
    fileEnv = parseDotEnv(readFileSync(envPath, 'utf8'));
  }
  // Explicit process environment always wins over the .env file.
  const env = mergeEnv(fileEnv, process.env);

  const missing = missingEnv(env);
  if (missing.length > 0) {
    fail(formatMissingEnv(missing));
  }
  const resolved = resolveTokenEnv(env);
  if (!resolved.ok) {
    fail(formatMissingEnv(resolved.missing));
  }
  if (admissionRequested(env)) {
    fail(
      'dev-up: ENABLE_USAGE_ADMISSION=true requires the Usage service, which this ' +
        'launcher never starts (its startup runs migrations). Unset it for the ordinary ' +
        'Gateway development workflow.',
    );
  }

  const orchestrator = resolveOrchestratorUrl(env);
  if (!orchestrator.ok) {
    fail(`dev-up: ${orchestrator.reason}`);
  }

  for (const spec of DEV_SERVICES) {
    const entry = join(REPO_ROOT, spec.packageDir, spec.entry);
    if (!existsSync(entry)) {
      fail(
        `dev-up: missing compiled entrypoint ${spec.packageDir}/${spec.entry} ` +
          '(run pnpm build first)',
      );
    }
  }

  // Dependency preflights: the AI Platform stack (separate repo/launcher)
  // must already answer before the Gateway is worth starting.
  const orchestratorReady = await probeOnce(orchestratorReadyUrl(orchestrator.url), {
    timeoutMs: 5000,
  });
  // probeOnce cannot distinguish "not yet up" from "down" in one shot;
  // poll briefly so a concurrently-starting stack still succeeds.
  let orchestratorSeen = orchestratorReady === 200;
  if (!orchestratorSeen) {
    const deadline = Date.now() + DEPENDENCY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 1000));
      if ((await probeOnce(orchestratorReadyUrl(orchestrator.url), { timeoutMs: 5000 })) === 200) {
        orchestratorSeen = true;
        break;
      }
    }
  }
  if (!orchestratorSeen) {
    fail(
      `dev-up: AI Orchestrator not ready at ${orchestrator.url} ` +
        '(start the AI Platform stack first: pnpm dev in ai-platform)',
    );
  }

  const jwksStatus = await probeOnce(env['JWKS_URI'], { timeoutMs: 5000 });
  if (jwksStatus !== 200) {
    fail(
      `dev-up: JWKS document unreachable at the configured JWKS_URI ` +
        '(start the development issuer first)',
    );
  }

  const carries = new Map();
  const emit = (service, chunk) => {
    const state = carries.get(service) ?? '';
    const { lines, carry } = prefixLines(service, chunk, state);
    carries.set(service, carry);
    for (const line of lines) {
      console.log(line);
    }
  };

  const spawnService = (spec, childEnv) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, spec.packageDir, spec.entry)], {
      cwd: join(REPO_ROOT, spec.packageDir),
      env: { ...process.env, ...childEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => emit(spec.name, chunk));
    child.stderr.on('data', (chunk) => emit(spec.name, chunk));
    child.on('error', (error) => {
      console.log(`[dev-up] ${spec.name} spawn error: ${error.message}`);
    });
    return child;
  };

  const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
  const deps = {
    spawn: spawnService,
    checkPort: (port) => checkTcpOpen('127.0.0.1', port, 1000),
    probe: (url) => probeOnce(url, { timeoutMs: 5000 }),
    sleep,
    log: (line) => console.log(line),
    timeouts: { health: HEALTH_TIMEOUT_MS, ready: READY_TIMEOUT_MS },
    intervalMs: POLL_INTERVAL_MS,
  };
  const ctx = { env, tokens: resolved.mapping, orchestratorUrl: orchestrator.url };

  let children;
  try {
    children = await startAll(deps, ctx);
  } catch (error) {
    fail(`dev-up: startup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let shuttingDown = false;
  const shutdown = async (signal, exitCode) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    detach();
    console.log(`[dev-up] ${signal} received, stopping services`);
    await shutdownAll(children, {
      sleep,
      log: (line) => console.log(line),
      graceMs: SHUTDOWN_GRACE_MS,
    });
    console.log('[dev-up] stopped');
    process.exit(exitCode);
  };
  const detach = watchChildren(children, (spec, code) => {
    if (shuttingDown) {
      return;
    }
    console.log(`[dev-up] ${spec.name} exited unexpectedly (code ${String(code)}), cleaning up`);
    void shutdown('failure', 1);
  });
  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));

  console.log('[dev-up] gateway ready; press Ctrl+C to stop');
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
    fail(`dev-up: ${error instanceof Error ? error.message : String(error)}`);
  }
}
