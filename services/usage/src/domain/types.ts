export * from '@oicunt/contracts';

export interface HourlyAggregateRow {
  readonly bucketStart: string;
  readonly tenantId: string;
  readonly productId: string;
  readonly sourceService: string;
  readonly resourceId: string;
  readonly metricName: string;
  readonly metricValue: number;
  readonly eventCount: number;
  readonly updatedAt: string;
}

export interface DailyAggregateRow {
  readonly bucketDate: string;
  readonly tenantId: string;
  readonly productId: string;
  readonly sourceService: string;
  readonly resourceId: string;
  readonly metricName: string;
  readonly metricValue: number;
  readonly eventCount: number;
  readonly updatedAt: string;
}
