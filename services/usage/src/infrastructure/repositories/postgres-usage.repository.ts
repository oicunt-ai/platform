import type { PoolClient } from 'pg';
import type {
  BatchIngestUsageResult,
  IngestUsageResult,
  UsageEvent,
  UsageEventsQuery,
  UsageEventsResult,
  UsageSummaryQuery,
  UsageSummaryResult,
  UsageTimeseriesPoint,
  UsageTimeseriesQuery,
  UsageTimeseriesResult,
} from '../../domain/types.js';
import {
  extractMetricDeltas,
  getDailyBucketDate,
  getHourlyBucketStart,
} from '../../domain/aggregation.js';
import type { DatabasePool } from '../database/connection.js';
import type { UsageRepositoryPort } from '../../application/ports/usage-repository.port.js';

interface UsageEventRow {
  event_id: string;
  schema_version: string;
  tenant_id: string;
  user_id: string | null;
  actor_id: string | null;
  product_id: string;
  source_service: string;
  operation: string;
  resource_id: string;
  measurements: Record<string, number>;
  dimensions: Record<string, string | number | boolean>;
  lineage: {
    correlationId: string;
    requestId: string;
    sessionId?: string;
    runId?: string;
    stepId?: string;
    parentEventId?: string;
  };
  idempotency_key: string;
  occurred_at: Date;
  ingested_at: Date;
}

export class PostgresUsageRepository implements UsageRepositoryPort {
  constructor(private readonly db: DatabasePool) {}

  public async saveEvent(event: UsageEvent): Promise<{
    readonly persisted: boolean;
    readonly event: UsageEvent;
  }> {
    return await this.db.withTransaction(async (client) => {
      const insertSql = `
        INSERT INTO oicunt_usage.usage_events (
          event_id, schema_version, tenant_id, user_id, actor_id, product_id,
          source_service, operation, resource_id, measurements, dimensions,
          lineage, idempotency_key, occurred_at, ingested_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW()
        )
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING event_id, ingested_at;
      `;

      const insertResult = await client.query<{ event_id: string; ingested_at: Date }>(insertSql, [
        event.eventId,
        event.schemaVersion,
        event.tenantId,
        event.userId ?? null,
        event.actorId ?? null,
        event.productId,
        event.sourceService,
        event.operation,
        event.resourceId,
        JSON.stringify(event.measurements),
        JSON.stringify(event.dimensions),
        JSON.stringify(event.lineage),
        event.idempotencyKey,
        event.occurredAt,
      ]);

      if (insertResult.rows.length === 0) {
        // Duplicate event with (tenant_id, idempotency_key) already exists
        const existingSql = `
          SELECT * FROM oicunt_usage.usage_events
          WHERE tenant_id = $1 AND idempotency_key = $2
          LIMIT 1;
        `;
        const existingResult = await client.query<UsageEventRow>(existingSql, [
          event.tenantId,
          event.idempotencyKey,
        ]);

        if (existingResult.rows.length > 0) {
          const existingRow = existingResult.rows[0]!;
          return {
            persisted: false,
            event: this.mapRowToEvent(existingRow),
          };
        }

        return {
          persisted: false,
          event,
        };
      }

      const ingestedAt = insertResult.rows[0]!.ingested_at.toISOString();
      const persistedEvent: UsageEvent = {
        ...event,
        ingestedAt,
      };

      // Apply aggregates only for newly persisted event
      await this.applyAggregates(client, persistedEvent);

      return {
        persisted: true,
        event: persistedEvent,
      };
    });
  }

  public async saveEventsBatch(events: readonly UsageEvent[]): Promise<BatchIngestUsageResult> {
    let accepted = 0;
    let duplicates = 0;
    const results: IngestUsageResult[] = [];

    for (const event of events) {
      const res = await this.saveEvent(event);
      if (res.persisted) {
        accepted += 1;
        results.push({
          eventId: res.event.eventId,
          status: 'persisted',
          occurredAt: res.event.occurredAt,
        });
      } else {
        duplicates += 1;
        results.push({
          eventId: res.event.eventId,
          status: 'duplicate',
          occurredAt: res.event.occurredAt,
        });
      }
    }

    return { accepted, duplicates, results };
  }

  public async findEventById(tenantId: string, eventId: string): Promise<UsageEvent | null> {
    const sql = `
      SELECT * FROM oicunt_usage.usage_events
      WHERE tenant_id = $1 AND event_id = $2
      LIMIT 1;
    `;
    const res = await this.db.query<UsageEventRow>(sql, [tenantId, eventId]);
    if (res.rows.length === 0) {
      return null;
    }
    return this.mapRowToEvent(res.rows[0]!);
  }

  public async queryEvents(query: UsageEventsQuery): Promise<UsageEventsResult> {
    const params: unknown[] = [query.tenantId];
    const whereClauses: string[] = ['tenant_id = $1'];

    if (query.correlationId) {
      params.push(query.correlationId);
      whereClauses.push(`lineage->>'correlationId' = $${params.length}`);
    }

    if (query.resourceId) {
      params.push(query.resourceId);
      whereClauses.push(`resource_id = $${params.length}`);
    }

    if (query.sourceService) {
      params.push(query.sourceService);
      whereClauses.push(`source_service = $${params.length}`);
    }

    if (query.operation) {
      params.push(query.operation);
      whereClauses.push(`operation = $${params.length}`);
    }

    if (query.startTime) {
      params.push(query.startTime);
      whereClauses.push(`occurred_at >= $${params.length}`);
    }

    if (query.endTime) {
      params.push(query.endTime);
      whereClauses.push(`occurred_at <= $${params.length}`);
    }

    const whereSql = whereClauses.join(' AND ');

    // Count
    const countSql = `SELECT COUNT(*) as total FROM oicunt_usage.usage_events WHERE ${whereSql}`;
    const countRes = await this.db.query<{ total: string }>(countSql, params);
    const totalCount = Number.parseInt(countRes.rows[0]?.total ?? '0', 10);

    // Limit and Offset
    const limit = query.limit ?? 50;
    let offset = 0;
    if (query.cursor) {
      try {
        const decoded = Buffer.from(query.cursor, 'base64').toString('utf-8');
        const parsed = Number.parseInt(decoded, 10);
        if (!Number.isNaN(parsed) && parsed >= 0) {
          offset = parsed;
        }
      } catch {
        offset = 0;
      }
    }

    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const selectSql = `
      SELECT * FROM oicunt_usage.usage_events
      WHERE ${whereSql}
      ORDER BY occurred_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    const selectRes = await this.db.query<UsageEventRow>(selectSql, params);
    const events = selectRes.rows.map((row) => this.mapRowToEvent(row));

    const nextOffset = offset + events.length;
    const nextCursor =
      nextOffset < totalCount
        ? Buffer.from(String(nextOffset), 'utf-8').toString('base64')
        : undefined;

    return {
      events,
      totalCount,
      nextCursor,
    };
  }

  public async querySummary(query: UsageSummaryQuery): Promise<UsageSummaryResult> {
    const params: unknown[] = [query.tenantId, query.startTime, query.endTime];
    const whereClauses: string[] = ['tenant_id = $1', 'occurred_at >= $2', 'occurred_at <= $3'];

    if (query.productId) {
      params.push(query.productId);
      whereClauses.push(`product_id = $${params.length}`);
    }

    if (query.resourceId) {
      params.push(query.resourceId);
      whereClauses.push(`resource_id = $${params.length}`);
    }

    if (query.sourceService) {
      params.push(query.sourceService);
      whereClauses.push(`source_service = $${params.length}`);
    }

    if (query.operation) {
      params.push(query.operation);
      whereClauses.push(`operation = $${params.length}`);
    }

    const whereSql = whereClauses.join(' AND ');

    const countSql = `SELECT COUNT(*) as event_count FROM oicunt_usage.usage_events WHERE ${whereSql}`;
    const countRes = await this.db.query<{ event_count: string }>(countSql, params);
    const eventCount = Number.parseInt(countRes.rows[0]?.event_count ?? '0', 10);

    const aggSql = `
      SELECT key as metric_name, SUM(value::numeric) as metric_total
      FROM oicunt_usage.usage_events,
           jsonb_each_text(measurements)
      WHERE ${whereSql}
      GROUP BY key;
    `;

    const aggRes = await this.db.query<{ metric_name: string; metric_total: string }>(
      aggSql,
      params,
    );
    const totals: Record<string, number> = {};
    for (const row of aggRes.rows) {
      totals[row.metric_name] = Number.parseFloat(row.metric_total);
    }

    return {
      tenantId: query.tenantId,
      window: {
        startTime: query.startTime,
        endTime: query.endTime,
      },
      totals,
      eventCount,
    };
  }

  public async queryTimeseries(query: UsageTimeseriesQuery): Promise<UsageTimeseriesResult> {
    const granularity = query.granularity ?? 'daily';
    const params: unknown[] = [query.tenantId, query.startTime, query.endTime];
    const whereClauses: string[] = [
      'tenant_id = $1',
      granularity === 'hourly'
        ? 'bucket_start >= $2 AND bucket_start <= $3'
        : 'bucket_date >= $2::date AND bucket_date <= $3::date',
    ];

    if (query.productId) {
      params.push(query.productId);
      whereClauses.push(`product_id = $${params.length}`);
    }

    if (query.resourceId) {
      params.push(query.resourceId);
      whereClauses.push(`resource_id = $${params.length}`);
    }

    if (query.sourceService) {
      params.push(query.sourceService);
      whereClauses.push(`source_service = $${params.length}`);
    }

    if (query.metric) {
      params.push(query.metric);
      whereClauses.push(`metric_name = $${params.length}`);
    }

    const whereSql = whereClauses.join(' AND ');
    const tableName =
      granularity === 'hourly'
        ? 'oicunt_usage.usage_aggregates_hourly'
        : 'oicunt_usage.usage_aggregates_daily';
    const bucketCol = granularity === 'hourly' ? 'bucket_start::timestamptz' : 'bucket_date::date';

    const sql = `
      SELECT ${bucketCol} as bucket, metric_name, SUM(metric_value) as metric_sum, SUM(event_count) as count_sum
      FROM ${tableName}
      WHERE ${whereSql}
      GROUP BY ${bucketCol}, metric_name
      ORDER BY bucket ASC;
    `;

    const res = await this.db.query<{
      bucket: Date | string;
      metric_name: string;
      metric_sum: string;
      count_sum: string;
    }>(sql, params);

    const bucketMap = new Map<string, { metrics: Record<string, number>; eventCount: number }>();

    for (const row of res.rows) {
      const bucketStr =
        granularity === 'hourly'
          ? (row.bucket instanceof Date ? row.bucket : new Date(row.bucket)).toISOString()
          : row.bucket instanceof Date
            ? row.bucket.toISOString().split('T')[0]!
            : String(row.bucket).split('T')[0]!;

      const existing = bucketMap.get(bucketStr) ?? { metrics: {}, eventCount: 0 };
      existing.metrics[row.metric_name] = Number.parseFloat(row.metric_sum);
      existing.eventCount = Math.max(existing.eventCount, Number.parseInt(row.count_sum, 10));
      bucketMap.set(bucketStr, existing);
    }

    const series: UsageTimeseriesPoint[] = Array.from(bucketMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([bucket, data]) => ({
        bucket,
        metrics: data.metrics,
        eventCount: data.eventCount,
      }));

    return {
      tenantId: query.tenantId,
      granularity,
      series,
    };
  }

  public async recomputeAggregates(
    tenantId: string,
    startTime: string,
    endTime: string,
  ): Promise<{ recomputedHours: number; recomputedDays: number }> {
    return await this.db.withTransaction(async (client) => {
      // 1. Delete existing aggregates in window
      await client.query(
        `DELETE FROM oicunt_usage.usage_aggregates_hourly
         WHERE tenant_id = $1 AND bucket_start >= $2 AND bucket_start <= $3`,
        [tenantId, startTime, endTime],
      );

      await client.query(
        `DELETE FROM oicunt_usage.usage_aggregates_daily
         WHERE tenant_id = $1 AND bucket_date >= $2::date AND bucket_date <= $3::date`,
        [tenantId, startTime, endTime],
      );

      // 2. Re-insert hourly from raw events
      const hourlyInsertSql = `
        INSERT INTO oicunt_usage.usage_aggregates_hourly (
          bucket_start, tenant_id, product_id, source_service, resource_id, metric_name,
          metric_value, event_count, updated_at
        )
        SELECT
          date_trunc('hour', occurred_at) as bucket_start,
          tenant_id, product_id, source_service, resource_id,
          key as metric_name,
          SUM(value::numeric) as metric_value,
          COUNT(DISTINCT event_id) as event_count,
          NOW() as updated_at
        FROM oicunt_usage.usage_events,
             jsonb_each_text(measurements)
        WHERE tenant_id = $1 AND occurred_at >= $2 AND occurred_at <= $3
        GROUP BY date_trunc('hour', occurred_at), tenant_id, product_id, source_service, resource_id, key
        ON CONFLICT (bucket_start, tenant_id, product_id, source_service, resource_id, metric_name)
        DO UPDATE SET
          metric_value = EXCLUDED.metric_value,
          event_count = EXCLUDED.event_count,
          updated_at = NOW();
      `;
      const hourlyRes = await client.query(hourlyInsertSql, [tenantId, startTime, endTime]);

      // 3. Re-insert daily from raw events
      const dailyInsertSql = `
        INSERT INTO oicunt_usage.usage_aggregates_daily (
          bucket_date, tenant_id, product_id, source_service, resource_id, metric_name,
          metric_value, event_count, updated_at
        )
        SELECT
          occurred_at::date as bucket_date,
          tenant_id, product_id, source_service, resource_id,
          key as metric_name,
          SUM(value::numeric) as metric_value,
          COUNT(DISTINCT event_id) as event_count,
          NOW() as updated_at
        FROM oicunt_usage.usage_events,
             jsonb_each_text(measurements)
        WHERE tenant_id = $1 AND occurred_at >= $2 AND occurred_at <= $3
        GROUP BY occurred_at::date, tenant_id, product_id, source_service, resource_id, key
        ON CONFLICT (bucket_date, tenant_id, product_id, source_service, resource_id, metric_name)
        DO UPDATE SET
          metric_value = EXCLUDED.metric_value,
          event_count = EXCLUDED.event_count,
          updated_at = NOW();
      `;
      const dailyRes = await client.query(dailyInsertSql, [tenantId, startTime, endTime]);

      return {
        recomputedHours: hourlyRes.rowCount ?? 0,
        recomputedDays: dailyRes.rowCount ?? 0,
      };
    });
  }

  private async applyAggregates(client: PoolClient, event: UsageEvent): Promise<void> {
    const hourlyBucket = getHourlyBucketStart(event.occurredAt);
    const dailyBucket = getDailyBucketDate(event.occurredAt);
    const deltas = extractMetricDeltas(event);

    for (const delta of deltas) {
      // Hourly upsert
      const hourlySql = `
        INSERT INTO oicunt_usage.usage_aggregates_hourly (
          bucket_start, tenant_id, product_id, source_service, resource_id, metric_name,
          metric_value, event_count, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, 1, NOW()
        )
        ON CONFLICT (bucket_start, tenant_id, product_id, source_service, resource_id, metric_name)
        DO UPDATE SET
          metric_value = oicunt_usage.usage_aggregates_hourly.metric_value + EXCLUDED.metric_value,
          event_count = oicunt_usage.usage_aggregates_hourly.event_count + 1,
          updated_at = NOW();
      `;
      await client.query(hourlySql, [
        hourlyBucket,
        event.tenantId,
        event.productId,
        event.sourceService,
        event.resourceId,
        delta.metricName,
        delta.delta,
      ]);

      // Daily upsert
      const dailySql = `
        INSERT INTO oicunt_usage.usage_aggregates_daily (
          bucket_date, tenant_id, product_id, source_service, resource_id, metric_name,
          metric_value, event_count, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, 1, NOW()
        )
        ON CONFLICT (bucket_date, tenant_id, product_id, source_service, resource_id, metric_name)
        DO UPDATE SET
          metric_value = oicunt_usage.usage_aggregates_daily.metric_value + EXCLUDED.metric_value,
          event_count = oicunt_usage.usage_aggregates_daily.event_count + 1,
          updated_at = NOW();
      `;
      await client.query(dailySql, [
        dailyBucket,
        event.tenantId,
        event.productId,
        event.sourceService,
        event.resourceId,
        delta.metricName,
        delta.delta,
      ]);
    }
  }

  private mapRowToEvent(row: UsageEventRow): UsageEvent {
    return {
      eventId: row.event_id,
      schemaVersion: row.schema_version,
      tenantId: row.tenant_id,
      userId: row.user_id ?? undefined,
      actorId: row.actor_id ?? undefined,
      productId: row.product_id,
      sourceService: row.source_service,
      operation: row.operation,
      resourceId: row.resource_id,
      measurements: row.measurements,
      dimensions: row.dimensions,
      lineage: row.lineage,
      idempotencyKey: row.idempotency_key,
      occurredAt:
        row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
      ingestedAt:
        row.ingested_at instanceof Date ? row.ingested_at.toISOString() : String(row.ingested_at),
    };
  }
}
