import type {
  BatchIngestUsageResult,
  UsageEvent,
  UsageEventsQuery,
  UsageEventsResult,
  UsageSummaryQuery,
  UsageSummaryResult,
  UsageTimeseriesQuery,
  UsageTimeseriesResult,
} from '../../domain/types.js';

export interface UsageRepositoryPort {
  /**
   * Persists a single usage event idempotently.
   * If an event with (tenantId, idempotencyKey) already exists, returns persisted: false
   * and the existing event, without double-counting aggregates.
   */
  saveEvent(event: UsageEvent): Promise<{
    readonly persisted: boolean;
    readonly event: UsageEvent;
  }>;

  /**
   * Persists a batch of events idempotently.
   */
  saveEventsBatch(events: readonly UsageEvent[]): Promise<BatchIngestUsageResult>;

  /**
   * Finds a raw event by tenantId and eventId.
   */
  findEventById(tenantId: string, eventId: string): Promise<UsageEvent | null>;

  /**
   * Queries raw immutable usage events.
   */
  queryEvents(query: UsageEventsQuery): Promise<UsageEventsResult>;

  /**
   * Queries aggregated consumption totals for a tenant across a time window.
   */
  querySummary(query: UsageSummaryQuery): Promise<UsageSummaryResult>;

  /**
   * Queries timeseries consumption buckets (hourly or daily).
   */
  queryTimeseries(query: UsageTimeseriesQuery): Promise<UsageTimeseriesResult>;

  /**
   * Recomputes hourly and daily aggregates from raw immutable events for a time window.
   */
  recomputeAggregates(
    tenantId: string,
    startTime: string,
    endTime: string,
  ): Promise<{ readonly recomputedHours: number; readonly recomputedDays: number }>;
}
