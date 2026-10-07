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
import type { UsageRepositoryPort } from '../../application/ports/usage-repository.port.js';

interface HourlyAggregateEntry {
  readonly bucketStart: string;
  readonly tenantId: string;
  readonly productId: string;
  readonly sourceService: string;
  readonly resourceId: string;
  readonly metricName: string;
  metricValue: number;
  eventCount: number;
  updatedAt: string;
}

interface DailyAggregateEntry {
  readonly bucketDate: string;
  readonly tenantId: string;
  readonly productId: string;
  readonly sourceService: string;
  readonly resourceId: string;
  readonly metricName: string;
  metricValue: number;
  eventCount: number;
  updatedAt: string;
}

export class InMemoryUsageRepository implements UsageRepositoryPort {
  // Natural key: `${tenantId}:${idempotencyKey}` -> eventId
  private readonly idempotencyIndex = new Map<string, string>();
  // Primary key: `${tenantId}:${eventId}` -> UsageEvent
  private readonly eventsById = new Map<string, UsageEvent>();
  // List of all events
  private readonly events: UsageEvent[] = [];

  // Key: `${bucketStart}:${tenantId}:${productId}:${sourceService}:${resourceId}:${metricName}`
  private readonly hourlyAggregates = new Map<string, HourlyAggregateEntry>();
  // Key: `${bucketDate}:${tenantId}:${productId}:${sourceService}:${resourceId}:${metricName}`
  private readonly dailyAggregates = new Map<string, DailyAggregateEntry>();

  public async saveEvent(event: UsageEvent): Promise<{
    readonly persisted: boolean;
    readonly event: UsageEvent;
  }> {
    const naturalKey = `${event.tenantId}:${event.idempotencyKey}`;
    const existingEventId = this.idempotencyIndex.get(naturalKey);

    if (existingEventId) {
      const existing = this.eventsById.get(`${event.tenantId}:${existingEventId}`);
      if (existing) {
        return { persisted: false, event: existing };
      }
    }

    const eventWithIngest: UsageEvent = {
      ...event,
      ingestedAt: event.ingestedAt ?? new Date().toISOString(),
    };

    this.idempotencyIndex.set(naturalKey, event.eventId);
    this.eventsById.set(`${event.tenantId}:${event.eventId}`, eventWithIngest);
    this.events.push(eventWithIngest);

    // Apply aggregates only for newly persisted events
    this.applyAggregates(eventWithIngest);

    return { persisted: true, event: eventWithIngest };
  }

  public async saveEventsBatch(events: readonly UsageEvent[]): Promise<BatchIngestUsageResult> {
    let accepted = 0;
    let duplicates = 0;
    const results: IngestUsageResult[] = [];

    for (const evt of events) {
      const res = await this.saveEvent(evt);
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
    const found = this.eventsById.get(`${tenantId}:${eventId}`);
    return found ?? null;
  }

  public async queryEvents(query: UsageEventsQuery): Promise<UsageEventsResult> {
    const startTimeMs = query.startTime ? new Date(query.startTime).getTime() : -Infinity;
    const endTimeMs = query.endTime ? new Date(query.endTime).getTime() : Infinity;

    const filtered = this.events.filter((e) => {
      if (e.tenantId !== query.tenantId) {
        return false;
      }
      if (query.correlationId && e.lineage.correlationId !== query.correlationId) {
        return false;
      }
      if (query.resourceId && e.resourceId !== query.resourceId) {
        return false;
      }
      if (query.sourceService && e.sourceService !== query.sourceService) {
        return false;
      }
      if (query.operation && e.operation !== query.operation) {
        return false;
      }
      const timeMs = new Date(e.occurredAt).getTime();
      if (timeMs < startTimeMs || timeMs > endTimeMs) {
        return false;
      }
      return true;
    });

    // Sort by occurredAt DESC
    filtered.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());

    const totalCount = filtered.length;
    const limit = query.limit ?? 50;

    let startIndex = 0;
    if (query.cursor) {
      try {
        const decoded = Buffer.from(query.cursor, 'base64').toString('utf-8');
        const parsed = Number.parseInt(decoded, 10);
        if (!Number.isNaN(parsed) && parsed >= 0) {
          startIndex = parsed;
        }
      } catch {
        startIndex = 0;
      }
    }

    const pageEvents = filtered.slice(startIndex, startIndex + limit);
    const nextOffset = startIndex + pageEvents.length;
    const nextCursor =
      nextOffset < totalCount
        ? Buffer.from(String(nextOffset), 'utf-8').toString('base64')
        : undefined;

    return {
      events: pageEvents,
      totalCount,
      nextCursor,
    };
  }

  public async querySummary(query: UsageSummaryQuery): Promise<UsageSummaryResult> {
    const startMs = new Date(query.startTime).getTime();
    const endMs = new Date(query.endTime).getTime();

    const totals: Record<string, number> = {};
    let eventCount = 0;

    for (const evt of this.events) {
      if (evt.tenantId !== query.tenantId) {
        continue;
      }
      if (query.productId && evt.productId !== query.productId) {
        continue;
      }
      if (query.resourceId && evt.resourceId !== query.resourceId) {
        continue;
      }
      if (query.sourceService && evt.sourceService !== query.sourceService) {
        continue;
      }
      if (query.operation && evt.operation !== query.operation) {
        continue;
      }

      const occMs = new Date(evt.occurredAt).getTime();
      if (occMs < startMs || occMs > endMs) {
        continue;
      }

      eventCount += 1;
      for (const [key, val] of Object.entries(evt.measurements)) {
        if (typeof val === 'number' && Number.isFinite(val)) {
          totals[key] = (totals[key] ?? 0) + val;
        }
      }
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
    const startMs = new Date(query.startTime).getTime();
    const endMs = new Date(query.endTime).getTime();

    const bucketMap = new Map<string, { metrics: Record<string, number>; eventCount: number }>();

    for (const evt of this.events) {
      if (evt.tenantId !== query.tenantId) {
        continue;
      }
      if (query.productId && evt.productId !== query.productId) {
        continue;
      }
      if (query.resourceId && evt.resourceId !== query.resourceId) {
        continue;
      }
      if (query.sourceService && evt.sourceService !== query.sourceService) {
        continue;
      }

      const occMs = new Date(evt.occurredAt).getTime();
      if (occMs < startMs || occMs > endMs) {
        continue;
      }

      const bucket =
        granularity === 'hourly'
          ? getHourlyBucketStart(evt.occurredAt)
          : getDailyBucketDate(evt.occurredAt);

      const existing = bucketMap.get(bucket) ?? { metrics: {}, eventCount: 0 };
      existing.eventCount += 1;

      for (const [k, v] of Object.entries(evt.measurements)) {
        if (query.metric && k !== query.metric) {
          continue;
        }
        if (typeof v === 'number' && Number.isFinite(v)) {
          existing.metrics[k] = (existing.metrics[k] ?? 0) + v;
        }
      }
      bucketMap.set(bucket, existing);
    }

    const sortedBuckets = Array.from(bucketMap.keys()).sort();
    const series: UsageTimeseriesPoint[] = sortedBuckets.map((b) => ({
      bucket: b,
      metrics: bucketMap.get(b)!.metrics,
      eventCount: bucketMap.get(b)!.eventCount,
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
    const startMs = new Date(startTime).getTime();
    const endMs = new Date(endTime).getTime();

    // Clear existing aggregates for tenant in time window
    for (const [k, v] of Array.from(this.hourlyAggregates.entries())) {
      if (v.tenantId === tenantId) {
        const t = new Date(v.bucketStart).getTime();
        if (t >= startMs && t <= endMs) {
          this.hourlyAggregates.delete(k);
        }
      }
    }

    for (const [k, v] of Array.from(this.dailyAggregates.entries())) {
      if (v.tenantId === tenantId) {
        const t = new Date(`${v.bucketDate}T00:00:00.000Z`).getTime();
        if (t >= startMs && t <= endMs) {
          this.dailyAggregates.delete(k);
        }
      }
    }

    // Recompute from matching raw events
    const hoursSet = new Set<string>();
    const daysSet = new Set<string>();

    for (const evt of this.events) {
      if (evt.tenantId !== tenantId) {
        continue;
      }
      const occMs = new Date(evt.occurredAt).getTime();
      if (occMs < startMs || occMs > endMs) {
        continue;
      }
      this.applyAggregates(evt);
      hoursSet.add(getHourlyBucketStart(evt.occurredAt));
      daysSet.add(getDailyBucketDate(evt.occurredAt));
    }

    return {
      recomputedHours: hoursSet.size,
      recomputedDays: daysSet.size,
    };
  }

  private applyAggregates(event: UsageEvent): void {
    const hourlyBucket = getHourlyBucketStart(event.occurredAt);
    const dailyBucket = getDailyBucketDate(event.occurredAt);
    const deltas = extractMetricDeltas(event);

    for (const delta of deltas) {
      // Hourly
      const hourlyKey = `${hourlyBucket}:${event.tenantId}:${event.productId}:${event.sourceService}:${event.resourceId}:${delta.metricName}`;
      const existingHourly = this.hourlyAggregates.get(hourlyKey);
      if (existingHourly) {
        existingHourly.metricValue += delta.delta;
        existingHourly.eventCount += 1;
        existingHourly.updatedAt = new Date().toISOString();
      } else {
        this.hourlyAggregates.set(hourlyKey, {
          bucketStart: hourlyBucket,
          tenantId: event.tenantId,
          productId: event.productId,
          sourceService: event.sourceService,
          resourceId: event.resourceId,
          metricName: delta.metricName,
          metricValue: delta.delta,
          eventCount: 1,
          updatedAt: new Date().toISOString(),
        });
      }

      // Daily
      const dailyKey = `${dailyBucket}:${event.tenantId}:${event.productId}:${event.sourceService}:${event.resourceId}:${delta.metricName}`;
      const existingDaily = this.dailyAggregates.get(dailyKey);
      if (existingDaily) {
        existingDaily.metricValue += delta.delta;
        existingDaily.eventCount += 1;
        existingDaily.updatedAt = new Date().toISOString();
      } else {
        this.dailyAggregates.set(dailyKey, {
          bucketDate: dailyBucket,
          tenantId: event.tenantId,
          productId: event.productId,
          sourceService: event.sourceService,
          resourceId: event.resourceId,
          metricName: delta.metricName,
          metricValue: delta.delta,
          eventCount: 1,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  public clear(): void {
    this.idempotencyIndex.clear();
    this.eventsById.clear();
    this.events.length = 0;
    this.hourlyAggregates.clear();
    this.dailyAggregates.clear();
  }
}
