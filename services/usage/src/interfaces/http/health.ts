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

export async function handleReadiness(
  res: ServerResponse,
  dbPool: DatabasePool | null,
): Promise<void> {
  const checks: Record<string, 'up' | 'down'> = {};
  let isReady = true;

  if (dbPool) {
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
  } else {
    checks['database'] = 'up'; // In-memory fallback
  }

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
