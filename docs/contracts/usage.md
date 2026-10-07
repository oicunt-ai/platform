# OICUNT Platform: Usage & Metering Architecture Contract

**Document Version**: 1.0.0  
**Status**: Approved Specification  
**Classification**: Engineering Architecture Standard  
**Service Owner**: OICUNT Platform Engineering (`@oicunt/service-usage`)

---

## 1. Executive Summary & System Context

This document establishes the binding architectural and wire contract for the **OICUNT Platform Usage & Metering Subsystem**.

Usage metering is a foundational platform-tier capability responsible for authoritatively capturing, storing, aggregating, and querying resource consumption across all OICUNT products and services.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                               EVENT PRODUCERS                                    │
│                                                                                  │
│  ┌───────────────────────┐   ┌───────────────────────┐   ┌────────────────────┐  │
│  │      AI Platform      │   │   Storage Platform    │   │  Compute Services  │  │
│  │ (tokens, tools, steps)│   │  (bytes, operations)  │   │   (cpu_ms, memory) │  │
│  └───────────┬───────────┘   └───────────┬───────────┘   └─────────┬──────────┘  │
└──────────────┼───────────────────────────┼─────────────────────────┼─────────────┘
               │                           │                         │
               │     HTTP / AMQP (Canonical UsageEvent)              │
               ▼                           ▼                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                     PLATFORM USAGE SERVICE (@oicunt/service-usage)               │
│                                                                                  │
│   ┌───────────────────────────┐         ┌────────────────────────────────────┐   │
│   │   Ingestion & Validation  │         │   Durable Storage & Idempotency    │   │
│   │   - Tenant Verification   │ ──────► │   - Append-Only Raw Events         │   │
│   │   - Schema Validation     │         │   - Natural / Provided Key De-dup  │   │
│   └───────────────────────────┘         └─────────────────┬──────────────────┘   │
│                                                           │                      │
│                                         ┌─────────────────▼──────────────────┐   │
│                                         │    Aggregation Engine (Rollups)    │   │
│                                         │    - Hourly Aggregates             │   │
│                                         │    - Daily Aggregates              │   │
│                                         └─────────────────┬──────────────────┘   │
└───────────────────────────────────────────────────────────┼──────────────────────┘
                                                            │
                                  Query APIs (Summary, Timeseries, Events)
                                                            │
┌───────────────────────────────────────────────────────────▼──────────────────────┐
│                               DOWNSTREAM CONSUMERS                               │
│                                                                                  │
│  ┌───────────────────────┐   ┌───────────────────────┐   ┌────────────────────┐  │
│  │   Billing & Invoicing │   │  Entitlements & Quotas│   │ Analytics / Ops UI │  │
│  │    (Stripe / Ledger)  │   │   (Rate Limiting/Auth)│   │   (Tenant Portal)  │  │
│  └───────────────────────┘   └───────────────────────┘   └────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Ownership Boundaries & Architectural Invariants

### 2.1 Ownership Division

| Domain Responsibility                 | Platform Usage Subsystem | AI Platform (`ai-platform`) | Future Billing / Entitlements |
| :------------------------------------ | :----------------------: | :-------------------------: | :---------------------------: |
| **Authoritative Meter of Record**     |         **Owns**         |         Prohibited          |             Reads             |
| **Durable Usage Event Storage**       |         **Owns**         |         Prohibited          |             Reads             |
| **Idempotency & Deduplication**       |         **Owns**         |    Client generates keys    |             Reads             |
| **Tenant Isolation & Security**       |       **Enforces**       |   Injects tenant context    |           Enforces            |
| **Hourly / Daily Aggregations**       |  **Computes & Stores**   |         Prohibited          |             Reads             |
| **Usage Reversals / Adjustments**     |  **Validates & Stores**  |          Requests           |           Requests            |
| **Usage Query API**                   |       **Exposes**        |         Prohibited          |           Consumes            |
| **AI Metric Production**              |        Prohibited        |          **Owns**           |          Prohibited           |
| **Model / Token / Step Calculations** |        Prohibited        |          **Owns**           |          Prohibited           |
| **Invoicing, Prices & Payments**      |        Prohibited        |         Prohibited          |           **Owns**            |

### 2.2 Core Invariants

1. **Single Source of Truth**: The Platform Usage service is the sole authoritative system of record for billing, quota, and capacity metering across the enterprise. AI Platform must never act as a company-wide meter.
2. **Append-Only Immutability**: Usage events are immutable. Once written to the database, events are never updated or deleted. Database-level trigger constraints enforce this rule.
3. **Idempotent Ingestion**: Ingestion is strictly idempotent. Repeated deliveries of the same `idempotencyKey` for a given `tenantId` return success without duplicating counts or ledger mutations.
4. **Strict Multi-Tenant Isolation**: Queries and aggregations are strictly partitioned by `tenantId`. Cross-tenant querying is forbidden. Ingestion endpoints mandate header-to-payload tenant alignment (`X-Tenant-ID` == `body.tenantId`).
5. **Separation of Metering from Rating**: Platform Usage measures _units of consumption_ (tokens, requests, execution seconds, bytes). It does not compute currency, apply discount curves, or generate customer invoices. Those are the downstream responsibilities of the Billing service.
6. **Reversals via Negative Deltas**: Corrections, refunds, or SLA credit adjustments are recorded as new, distinct usage events carrying negative measurements and linked to the target event via `lineage.reversalOf`.

---

## 3. Generalized Usage Event Model

The canonical usage contract is defined in `@oicunt/contracts` (`UsageEvent`). It is completely agnostic to specific products or AI models.

### 3.1 Event Schema

```typescript
export interface UsageEvent {
  /** Authoritative unique event ID (UUIDv4) */
  readonly eventId: string;

  /** Contract schema version, currently '1.0.0' */
  readonly schemaVersion: '1.0.0';

  /** Authoritative tenant/organization identifier */
  readonly tenantId: string;

  /** Optional user identifier who initiated the action */
  readonly userId?: string;

  /** Optional machine or service identity (e.g. 'worker-service', 'ai-orchestrator') */
  readonly actorId?: string;

  /** Product identifier (e.g. 'billy', 'platform-api', 'ai-platform', 'vector-db') */
  readonly productId: string;

  /** Source microservice that emitted the event */
  readonly sourceService: string;

  /** Specific action or operation performed */
  readonly operation: string;

  /** Target resource identifier (e.g. conversationId, datasetId, bucketName) */
  readonly resourceId?: string;

  /** Quantitative measurements (consumption units) */
  readonly measurements: UsageMeasurements;

  /** Qualitative categorical dimensions (metadata used for slicing and filtering) */
  readonly dimensions: Record<string, string>;

  /** Traceability and provenance lineage */
  readonly lineage: UsageEventLineage;

  /** Deduplication key scoped to tenantId */
  readonly idempotencyKey: string;

  /** ISO 8601 timestamp when consumption actually occurred */
  readonly occurredAt: string;

  /** ISO 8601 timestamp when Platform Usage received the event */
  readonly ingestedAt?: string;
}
```

### 3.2 Quantitative Measurements (`measurements`)

The measurements block captures numerical consumption quantities. The Platform Usage contract is strictly domain-neutral and supports arbitrary numeric measurement names via a dictionary:

```typescript
export type UsageMeasurements = Record<string, number>;
```

Metric names follow a hierarchical dot-delimited taxonomy.

#### AI Metric Naming Conventions

- `tokens.input`: Input / prompt tokens processed
- `tokens.output`: Output / completion tokens generated
- `tokens.total`: Total tokens (input + output)
- `tokens.cached_input`: Tokens read from prompt cache
- `tokens.reasoning`: Normalized internal reasoning / extended thinking tokens
- `tool.calls`: Discrete tool invocations count
- `agent.steps`: Autonomous agent execution steps
- `vectors.dimensions`: Vector embedding dimensions

#### Generic Platform Metric Naming Conventions

- `duration.ms`: Wall-clock execution duration in milliseconds
- `cpu.ms`: Compute execution duration in milliseconds
- `memory.bytes`: Memory consumption in bytes
- `storage.bytes`: Storage volume in bytes
- `bytes.ingested`: Ingress payload bytes
- `bytes.egressed`: Egress network bytes
- `requests.count`: Discrete request count
- `invocations.count`: Function or service invocation count

### 3.3 Qualitative Dimensions (`dimensions`)

Dimensions are string key-value pairs used for categorization, querying, aggregation, and future billing rating.

Common dimension keys:

- `model`: Canonical model identifier (e.g. `oicunt.model.general`, `oicunt.model.reasoning`).
- `provider`: Resolved execution provider (e.g. `anthropic`, `openai`, `vertex-ai`).
- `pricingTier`: Contract tier (e.g. `enterprise`, `standard`, `free`).
- `feature`: Specific application capability (e.g. `code-review`, `chat`, `semantic-search`).
- `environment`: Deployment tier (`production`, `staging`).

### 3.4 Traceability & Lineage (`lineage`)

```typescript
export interface UsageEventLineage {
  readonly correlationId: string;
  readonly requestId?: string;
  readonly conversationId?: string;
  readonly completionId?: string;
  readonly parentEventId?: string;
  readonly reversalOf?: string;
}
```

---

## 4. Ingestion Interfaces

The Platform Usage service supports both synchronous HTTP ingestion and asynchronous message queue ingestion.

### 4.1 Synchronous HTTP Ingestion

#### Single Event Ingestion

- **Endpoint**: `POST /api/v1/usage/events`
- **Headers**:
  - `Content-Type: application/json`
  - `X-Tenant-ID: <tenantId>` _(Mandatory: must match payload `tenantId`)_
  - `X-User-ID: <userId>` _(Optional)_
  - `X-Correlation-ID: <correlationId>` _(Mandatory)_

**Request Payload**:

```json
{
  "eventId": "123e4567-e89b-12d3-a456-426614174000",
  "schemaVersion": "1.0.0",
  "tenantId": "org-acme-corp",
  "userId": "user-4819",
  "actorId": "ai-orchestrator",
  "productId": "billy",
  "sourceService": "ai-orchestrator",
  "operation": "chat.completion",
  "resourceId": "conv-99120",
  "measurements": {
    "tokens.input": 1024,
    "tokens.output": 256,
    "tokens.total": 1280,
    "duration.ms": 1420
  },
  "dimensions": {
    "model": "oicunt.model.general",
    "provider": "anthropic",
    "feature": "billy-chat"
  },
  "lineage": {
    "correlationId": "corr-881293",
    "requestId": "req-99120",
    "conversationId": "conv-99120",
    "completionId": "cmpl-00129"
  },
  "idempotencyKey": "cmpl-00129-usage",
  "occurredAt": "2026-10-07T12:00:00.000Z"
}
```

**Success Response (`200 OK`)**:

```json
{
  "success": true,
  "data": {
    "eventId": "123e4567-e89b-12d3-a456-426614174000",
    "idempotencyKey": "cmpl-00129-usage",
    "status": "ACCEPTED",
    "duplicate": false,
    "receivedAt": "2026-10-07T12:00:00.050Z"
  }
}
```

**Idempotent Duplicate Response (`200 OK`)**:

```json
{
  "success": true,
  "data": {
    "eventId": "123e4567-e89b-12d3-a456-426614174000",
    "idempotencyKey": "cmpl-00129-usage",
    "status": "DUPLICATE",
    "duplicate": true,
    "receivedAt": "2026-10-07T12:00:00.050Z"
  }
}
```

#### Batch Event Ingestion

- **Endpoint**: `POST /api/v1/usage/events/batch`
- **Headers**:
  - `Content-Type: application/json`
  - `X-Tenant-ID: <tenantId>`
  - `X-Correlation-ID: <correlationId>`

**Request Payload**:

```json
{
  "events": [{/* UsageEvent 1 */}, {/* UsageEvent 2 */}]
}
```

**Response (`200 OK`)**:

```json
{
  "success": true,
  "data": {
    "acceptedCount": 2,
    "duplicateCount": 0,
    "results": [
      {
        "eventId": "evt-1",
        "idempotencyKey": "key-1",
        "status": "ACCEPTED",
        "duplicate": false,
        "receivedAt": "..."
      },
      {
        "eventId": "evt-2",
        "idempotencyKey": "key-2",
        "status": "ACCEPTED",
        "duplicate": false,
        "receivedAt": "..."
      }
    ]
  }
}
```

---

### 4.2 Asynchronous AMQP Message Bus Ingestion

For high-throughput, non-blocking asynchronous usage reporting:

- **Exchange**: `oicunt.usage.exchange` (Topic Exchange)
- **Routing Key**: `usage.event.<productId>.<operation>` (e.g. `usage.event.billy.chat-completion`)
- **Queue**: `oicunt.usage.events`
  - Durable: `true`
  - Arguments:
    - `x-dead-letter-exchange`: `oicunt.usage.dlx`
    - `x-dead-letter-routing-key`: `oicunt.usage.events.dlq`
- **Dead Letter Queue (DLQ)**: `oicunt.usage.events.dlq`

**AMQP Ingestion Semantics**:

1. Messages are parsed into `UsageEvent`.
2. Valid events are saved and acknowledged (`channel.ack()`).
3. Duplicates are recognized idempotently and acknowledged (`channel.ack()`).
4. Schema validation errors or unrecoverable malformed events are routed directly to DLQ or rejected without requeue (`channel.nack(false)`).
5. Transient database errors trigger unacknowledged requeue or retry delay (`channel.nack(true)`).

---

## 5. Query & Aggregation Interfaces

### 5.1 Aggregate Rollups

Platform Usage pre-aggregates raw usage into hourly and daily rollups per dimension combination:

- Table: `oicunt_usage.usage_aggregates_hourly`
- Table: `oicunt_usage.usage_aggregates_daily`

Rollups track:

- `event_count`: Number of events in bucket
- `metric_value`: Sum of the specific measurement

### 5.2 Usage Summary

- **Endpoint**: `GET /api/v1/usage/summary?tenantId={tenantId}&startDate={iso}&endDate={iso}&productId={id}&operation={op}`
- **Headers**:
  - `X-Tenant-ID: {tenantId}`

**Response (`200 OK`)**:

```json
{
  "success": true,
  "data": {
    "tenantId": "org-acme-corp",
    "startDate": "2026-10-01T00:00:00.000Z",
    "endDate": "2026-10-07T23:59:59.999Z",
    "totalEvents": 1420,
    "metrics": {
      "tokens.input": 1420000,
      "tokens.output": 380000,
      "tokens.total": 1800000,
      "duration.ms": 1940000
    },
    "byDimension": {
      "model": {
        "oicunt.model.general": { "tokens.total": 1200000 },
        "oicunt.model.reasoning": { "tokens.total": 600000 }
      }
    }
  }
}
```

### 5.3 Timeseries Query

- **Endpoint**: `GET /api/v1/usage/timeseries?tenantId={tenantId}&granularity={hourly|daily}&startDate={iso}&endDate={iso}&metrics=tokens.total,duration.ms`
- **Headers**:
  - `X-Tenant-ID: {tenantId}`

**Response (`200 OK`)**:

```json
{
  "success": true,
  "data": {
    "tenantId": "org-acme-corp",
    "granularity": "hourly",
    "points": [
      {
        "timestamp": "2026-10-07T12:00:00.000Z",
        "metrics": { "tokens.total": 245000, "duration.ms": 184000 },
        "eventCount": 180
      }
    ]
  }
}
```

### 5.4 Raw Events Query

- **Endpoint**: `GET /api/v1/usage/events?tenantId={tenantId}&limit=50&offset=0`
- **Headers**:
  - `X-Tenant-ID: {tenantId}`

---

## 6. Reversals & Adjustments

Usage events cannot be altered or deleted. Corrections are applied through explicit reversals.

- **Endpoint**: `POST /api/v1/usage/reversals`
- **Headers**:
  - `X-Tenant-ID: {tenantId}`

**Request Payload**:

```json
{
  "originalEventId": "123e4567-e89b-12d3-a456-426614174000",
  "tenantId": "org-acme-corp",
  "reason": "Model invocation failed mid-stream after initial token output",
  "reversalActorId": "billing-support",
  "customIdempotencyKey": "rev-cmpl-00129"
}
```

**Reversal Rules**:

1. Original event must exist and belong to the calling `tenantId`.
2. Reversal creates a brand-new `UsageEvent` with:
   - All numerical `measurements` inverted (multiplied by `-1`).
   - `operation`: `reversal.<original_operation>`
   - `lineage.reversalOf`: Original event ID.
   - `idempotencyKey`: Unique reversal key.
3. Once applied, aggregate queries automatically include the negative delta, reconciling net totals to zero or the corrected quantity.

---

## 7. PostgreSQL Persistence & Immutability Rules

The schema is encapsulated in schema `oicunt_usage`:

```sql
CREATE SCHEMA IF NOT EXISTS oicunt_usage;

-- Raw Events Table
CREATE TABLE IF NOT EXISTS oicunt_usage.usage_events (
    event_id UUID PRIMARY KEY,
    schema_version VARCHAR(16) NOT NULL,
    tenant_id VARCHAR(128) NOT NULL,
    user_id VARCHAR(128),
    actor_id VARCHAR(128),
    product_id VARCHAR(128) NOT NULL,
    source_service VARCHAR(128) NOT NULL,
    operation VARCHAR(128) NOT NULL,
    resource_id VARCHAR(256),
    measurements JSONB NOT NULL,
    dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
    lineage JSONB NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key VARCHAR(256) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_usage_events_tenant_idempotency UNIQUE (tenant_id, idempotency_key)
);

-- Append-Only Immutability Trigger
CREATE OR REPLACE FUNCTION oicunt_usage.prevent_usage_events_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'oicunt_usage.usage_events is append-only. UPDATE and DELETE operations are forbidden.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_usage_events_mutation
BEFORE UPDATE OR DELETE ON oicunt_usage.usage_events
FOR EACH ROW
EXECUTE FUNCTION oicunt_usage.prevent_usage_events_mutation();
```

---

## 8. Staged Migration Path from `ai-platform/services/usage`

To avoid disrupting running systems, migration follows a four-phase rollout:

```
[Phase 1: Foundation Complete]
- platform/services/usage (@oicunt/service-usage) established and tested
- Generalized UsageEvent contract in @oicunt/contracts
- ai-platform/services/usage preserved and operational

[Phase 2: Adapter & Dual-Publishing in ai-platform]
- Configure AI services to emit canonical UsageEvent payloads
- Add dual-write / switch flag to Platform Usage AMQP queue (oicunt.usage.events)

[Phase 3: Authoritative Cutover]
- Platform Usage becomes sole consumer of usage events
- Downstream reporting/querying points to Platform Usage APIs
- Validate complete aggregation parity

[Phase 4: Decommissioning]
- Retire and archive ai-platform/services/usage
```

### Detailed Migration Phases

1. **Phase 1 (Current State)**:
   - Canonical Platform Usage service created under `platform/services/usage/` (`@oicunt/service-usage`).
   - Shared contracts defined in `platform/packages/contracts/src/usage.ts`.
   - Comprehensive test suites passing (in-memory, PostgreSQL, AMQP, HTTP, tenant isolation, aggregation, reversal).
   - `ai-platform/services/usage/` remains completely untouched so existing consumers in `ai-platform` continue functioning without outage.

2. **Phase 2 (AI Platform Event Adapter)**:
   - AI Platform services (`ai-orchestrator`, `model-gateway`) adapt their usage reporting to construct `UsageEvent` adhering to `@oicunt/contracts`.
   - AI Platform points its usage publisher to the Platform Usage AMQP topic exchange (`oicunt.usage.exchange`) or synchronous HTTP endpoint (`/api/v1/usage/events`).

3. **Phase 3 (Switch Authoritative Query Traffic)**:
   - Portals, dashboards, and quota evaluators query `platform/services/usage` instead of `ai-platform/services/usage`.
   - Historical aggregate data backfilled if necessary via migration script.

4. **Phase 4 (Safe Decommissioning)**:
   - Once all emitters and readers reference `platform/services/usage`, safely remove `ai-platform/services/usage`.
