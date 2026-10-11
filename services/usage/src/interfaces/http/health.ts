import type { ServerResponse } from 'node:http';
import type { DatabasePool } from '../../infrastructure/database/connection.js';

export async function handleLiveness(res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      status: 'ok',
      service: 'usage',
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * Readiness reflects the REAL dependencies only.
 *
 * - No PostgreSQL pool means the database dependency is DOWN: a missing
 *   pool is never reported as healthy.
 * - `queueReady` must come from the actual queue consumer's own readiness
 *   signal; a missing or inactive consumer is DOWN.
 *
 * There is no in-memory fallback branch here: in a standalone process the
 * startup gate guarantees both dependencies exist, and when they do not,
 * readiness must truthfully report 503.
 */
export async function handleReadiness(
  res: ServerResponse,
  dbPool: DatabasePool | null,
  queueReady: boolean,
): Promise<void> {
  const checks: Record<string, 'up' | 'down'> = {};
  let isReady = true;

  if (!dbPool) {
    checks['database'] = 'down';
    isReady = false;
  } else {
    try {
      const dbPing = await dbPool.ping();
      checks['database'] = dbPing ? 'up' : 'down';
      if (!dbPing) {
        isReady = false;
      }
    } catch {
      checks['database'] = 'down';
      isReady = false;
    }
  }

  checks['usageQueue'] = queueReady ? 'up' : 'down';
  if (!queueReady) isReady = false;

  const statusCode = isReady ? 200 : 503;
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      status: isReady ? 'ok' : 'degraded',
      service: 'usage',
      checks,
      timestamp: new Date().toISOString(),
    }),
  );
}
