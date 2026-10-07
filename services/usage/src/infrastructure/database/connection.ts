import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { UsageConnectionError } from '../../domain/errors.js';

export interface DatabasePoolConfig {
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly database?: string | undefined;
  readonly user?: string | undefined;
  readonly password?: string | undefined;
  readonly ssl?: boolean | { rejectUnauthorized?: boolean } | undefined;
  readonly maxConnections?: number | undefined;
  readonly idleTimeoutMillis?: number | undefined;
  readonly connectionTimeoutMillis?: number | undefined;
}

export class DatabasePool {
  private readonly pool: Pool;

  constructor(config: DatabasePoolConfig = {}) {
    this.pool = new Pool({
      host: config.host ?? process.env['DATABASE_HOST'] ?? 'localhost',
      port: config.port ?? Number.parseInt(process.env['DATABASE_PORT'] ?? '5432', 10),
      database: config.database ?? process.env['DATABASE_NAME'] ?? 'oicunt_usage',
      user: config.user ?? process.env['DATABASE_USER'] ?? 'postgres',
      password: config.password ?? process.env['DATABASE_PASSWORD'] ?? '',
      ssl:
        config.ssl ??
        (process.env['DATABASE_SSL'] === 'true' ? { rejectUnauthorized: false } : undefined),
      max: config.maxConnections ?? Number.parseInt(process.env['DATABASE_POOL_MAX'] ?? '20', 10),
      idleTimeoutMillis:
        config.idleTimeoutMillis ??
        Number.parseInt(process.env['DATABASE_IDLE_TIMEOUT_MS'] ?? '10000', 10),
      connectionTimeoutMillis:
        config.connectionTimeoutMillis ??
        Number.parseInt(process.env['DATABASE_CONN_TIMEOUT_MS'] ?? '3000', 10),
    });
  }

  public async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<QueryResult<R>> {
    if (options?.signal?.aborted) {
      throw new UsageConnectionError('Database query cancelled prior to execution');
    }

    const client = await this.pool.connect();
    let aborted = false;

    const abortHandler = () => {
      aborted = true;
      void client.query('DISCARD ALL').catch(() => {});
    };

    if (options?.signal) {
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
      const result = await client.query<R>(text, params);
      if (aborted) {
        throw new UsageConnectionError('Database query aborted mid-flight');
      }
      return result;
    } finally {
      if (options?.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      client.release();
    }
  }

  public async withTransaction<T>(
    callback: (client: PoolClient) => Promise<T>,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<T> {
    if (options?.signal?.aborted) {
      throw new UsageConnectionError('Transaction cancelled prior to start');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async ping(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.query('SELECT 1', undefined, { signal });
      return true;
    } catch {
      return false;
    }
  }
}
