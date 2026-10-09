/**
 * Quantitative measurements representing physical consumption.
 * Domain-neutral dictionary mapping arbitrary metric keys to numerical quantities.
 * Company-wide contract supporting AI metrics, compute metrics, storage metrics, and platform units.
 * Missing measurements must remain absent rather than default to zero.
 *
 * Recommended metric naming conventions:
 * - AI metrics: tokens.input, tokens.output, tokens.total, tokens.cached_input, tokens.reasoning, tool.calls, agent.steps, vectors.dimensions
 * - Platform metrics: duration.ms, cpu.ms, memory.bytes, storage.bytes, bytes.ingested, bytes.egressed, requests.count, invocations.count
 */
export type UsageMeasurements = Record<string, number>;

/**
 * Measurement key identifier for usage metrics.
 */
export type UsageMeasurementKey = string;

/**
 * Distributed tracing and request lineage metadata.
 */
export interface UsageEventLineage {
  /** Global distributed tracing correlation ID */
  readonly correlationId: string;
  /** Discrete HTTP or RPC request ID */
  readonly requestId: string;
  /** Conversational session ID (e.g. Orchestrator / Memory session) */
  readonly sessionId?: string | undefined;
  /** Autonomous agent run ID (if emitted during agent execution) */
  readonly runId?: string | undefined;
  /** Specific step number or step ID within an agent run */
  readonly stepId?: string | undefined;
  /** Parent event ID for hierarchical sub-tasks or reversals */
  readonly parentEventId?: string | undefined;
}

/**
 * Foundational durable record representing a single discrete unit of consumption across the OICUNT platform.
 */
export interface UsageEvent {
  /**
   * Globally unique identifier for this usage event.
   * Monotonically ordered UUIDv7 or ULID or UUID.
   */
  readonly eventId: string;

  /**
   * Semantic schema version of the usage event contract.
   */
  readonly schemaVersion: '1.0.0' | string;

  /**
   * Authoritative customer tenant identifier (mandatory multi-tenant boundary).
   */
  readonly tenantId: string;

  /**
   * Individual end-user identity who initiated or owns the action.
   * Optional for service-to-service, system-level, or automated platform workloads.
   * Synthetic user identities must NEVER be fabricated.
   */
  readonly userId?: string | undefined;

  /**
   * Principal actor or service identity that executed the action.
   * Optional when usage is service-level, system-level, or otherwise not
   * attributable to a discrete human actor.
   * Synthetic actor identities must NEVER be fabricated.
   */
  readonly actorId?: string | undefined;

  /**
   * Commercial or application product boundary generating the consumption.
   * Example: 'billy', 'platform-api', 'enterprise-agent', 'developer-console'
   */
  readonly productId: string;

  /**
   * Specific OICUNT internal service emitting the usage.
   * Example: 'model-gateway', 'inference', 'embeddings', 'tools', 'agents', 'mcp', 'api-gateway'
   */
  readonly sourceService: string;

  /**
   * Specific operation or capability invoked.
   * Example: 'model.completion', 'model.embedding', 'tool.execution', 'agent.step', 'usage.reversal'
   */
  readonly operation: string;

  /**
   * Canonical platform resource identifier associated with the consumption.
   * Canonical model ID (e.g. 'oicunt.model.catalog-alpha'),
   * Canonical tool ID (e.g. 'oicunt.tool.code-sandbox'),
   * or Agent ID (e.g. 'agent_researcher_v2').
   */
  readonly resourceId: string;

  /**
   * Quantitative measurements for this event.
   */
  readonly measurements: UsageMeasurements;

  /**
   * Contextual categorical dimensions for reporting and filtering.
   * Must contain only low-to-medium cardinality scalar values.
   */
  readonly dimensions: Record<string, string | number | boolean>;

  /**
   * Distributed tracing and request lineage metadata.
   */
  readonly lineage: UsageEventLineage;

  /**
   * Deterministic idempotency key for deduplication.
   * Unique per discrete execution invocation across retries.
   */
  readonly idempotencyKey: string;

  /**
   * Exact ISO 8601 timestamp when the measured action occurred at the source.
   */
  readonly occurredAt: string;

  /**
   * ISO 8601 timestamp when the event was ingested by the Usage Service.
   */
  readonly ingestedAt?: string | undefined;
}

/**
 * Result of ingesting a single usage event.
 */
export interface IngestUsageResult {
  readonly eventId: string;
  readonly status: 'persisted' | 'duplicate';
  readonly occurredAt: string;
}

/**
 * Result of batch ingesting usage events.
 */
export interface BatchIngestUsageResult {
  readonly accepted: number;
  readonly duplicates: number;
  readonly results: readonly IngestUsageResult[];
}

/**
 * Query parameters for usage summary.
 */
export interface UsageSummaryQuery {
  readonly tenantId: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly productId?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly sourceService?: string | undefined;
  readonly operation?: string | undefined;
}

/**
 * Aggregated totals for usage summary.
 */
export interface UsageSummaryResult {
  readonly tenantId: string;
  readonly window: {
    readonly startTime: string;
    readonly endTime: string;
  };
  readonly totals: Record<string, number>;
  readonly eventCount: number;
}

/**
 * Granularity for timeseries queries.
 */
export type UsageGranularity = 'hourly' | 'daily';

/**
 * Query parameters for usage timeseries.
 */
export interface UsageTimeseriesQuery {
  readonly tenantId: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly granularity?: UsageGranularity | undefined;
  readonly productId?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly sourceService?: string | undefined;
  readonly metric?: string | undefined;
}

/**
 * Discrete timeseries data point.
 */
export interface UsageTimeseriesPoint {
  readonly bucket: string;
  readonly metrics: Record<string, number>;
  readonly eventCount: number;
}

/**
 * Result of a timeseries query.
 */
export interface UsageTimeseriesResult {
  readonly tenantId: string;
  readonly granularity: UsageGranularity;
  readonly series: readonly UsageTimeseriesPoint[];
}

/**
 * Query parameters for querying raw usage events.
 */
export interface UsageEventsQuery {
  readonly tenantId: string;
  readonly correlationId?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly sourceService?: string | undefined;
  readonly operation?: string | undefined;
  readonly startTime?: string | undefined;
  readonly endTime?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

/**
 * Result of raw usage events query.
 */
export interface UsageEventsResult {
  readonly events: readonly UsageEvent[];
  readonly totalCount: number;
  readonly nextCursor?: string | undefined;
}

/**
 * Request parameters for creating an append-only reversal/correction.
 */
export interface CreateReversalParams {
  readonly tenantId: string;
  readonly originalEventId: string;
  readonly reason: string;
  /**
   * Optional partial measurements to reverse.
   * If not provided, reverses 100% of the original event's measurements as negative deltas.
   */
  readonly negativeMeasurements?: Partial<UsageMeasurements> | undefined;
  readonly dimensions?: Record<string, string | number | boolean> | undefined;
  readonly correlationId?: string | undefined;
  readonly requestId?: string | undefined;
}
