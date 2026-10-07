import type { UsageEvent } from '@oicunt/contracts';

/**
 * Returns the ISO 8601 UTC timestamp truncated to the start of the hour.
 * Example: '2026-10-07T13:28:28.123Z' -> '2026-10-07T13:00:00.000Z'
 */
export function getHourlyBucketStart(occurredAtIso: string): string {
  const d = new Date(occurredAtIso);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

/**
 * Returns the UTC date string in 'YYYY-MM-DD' format.
 * Example: '2026-10-07T13:28:28.123Z' -> '2026-10-07'
 */
export function getDailyBucketDate(occurredAtIso: string): string {
  const d = new Date(occurredAtIso);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export interface MetricDelta {
  readonly metricName: string;
  readonly delta: number;
}

/**
 * Extracts all non-null numerical measurements from a usage event as metric deltas.
 */
export function extractMetricDeltas(event: UsageEvent): readonly MetricDelta[] {
  const deltas: MetricDelta[] = [];
  for (const [key, val] of Object.entries(event.measurements)) {
    if (typeof val === 'number' && Number.isFinite(val)) {
      deltas.push({ metricName: key, delta: val });
    }
  }
  return deltas;
}
