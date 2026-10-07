-- OICUNT Usage & Metering Subsystem Initial Migration
-- Dedicated Schema: oicunt_usage

CREATE SCHEMA IF NOT EXISTS oicunt_usage;

-- Table: usage_events (Raw, Immutable Historical Records)
CREATE TABLE IF NOT EXISTS oicunt_usage.usage_events (
    event_id            VARCHAR(64) NOT NULL,
    schema_version      VARCHAR(16) NOT NULL,
    tenant_id           VARCHAR(64) NOT NULL,
    user_id             VARCHAR(64),
    actor_id            VARCHAR(64),
    product_id          VARCHAR(64) NOT NULL,
    source_service      VARCHAR(64) NOT NULL,
    operation           VARCHAR(64) NOT NULL,
    resource_id         VARCHAR(128) NOT NULL,
    measurements        JSONB NOT NULL,
    dimensions          JSONB NOT NULL DEFAULT '{}'::jsonb,
    lineage             JSONB NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key     VARCHAR(128) NOT NULL,
    occurred_at         TIMESTAMPTZ NOT NULL,
    ingested_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_usage_events PRIMARY KEY (event_id, occurred_at),
    CONSTRAINT uq_usage_events_idempotency UNIQUE (tenant_id, idempotency_key)
);

-- Indexes for Tenant Queries, Lineage, and Filtering
CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_time ON oicunt_usage.usage_events (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_resource ON oicunt_usage.usage_events (tenant_id, resource_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_correlation ON oicunt_usage.usage_events USING btree ((lineage->>'correlationId'));

-- Table: usage_aggregates_hourly (Materialized Hourly UTC Rollups)
CREATE TABLE IF NOT EXISTS oicunt_usage.usage_aggregates_hourly (
    bucket_start        TIMESTAMPTZ NOT NULL,
    tenant_id           VARCHAR(64) NOT NULL,
    product_id          VARCHAR(64) NOT NULL,
    source_service      VARCHAR(64) NOT NULL,
    resource_id         VARCHAR(128) NOT NULL,
    metric_name         VARCHAR(64) NOT NULL,
    metric_value        NUMERIC(20, 4) NOT NULL DEFAULT 0,
    event_count         BIGINT NOT NULL DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_usage_aggregates_hourly PRIMARY KEY (
        bucket_start, tenant_id, product_id, source_service, resource_id, metric_name
    )
);

-- Table: usage_aggregates_daily (Materialized Daily UTC Rollups)
CREATE TABLE IF NOT EXISTS oicunt_usage.usage_aggregates_daily (
    bucket_date         DATE NOT NULL,
    tenant_id           VARCHAR(64) NOT NULL,
    product_id          VARCHAR(64) NOT NULL,
    source_service      VARCHAR(64) NOT NULL,
    resource_id         VARCHAR(128) NOT NULL,
    metric_name         VARCHAR(64) NOT NULL,
    metric_value        NUMERIC(20, 4) NOT NULL DEFAULT 0,
    event_count         BIGINT NOT NULL DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_usage_aggregates_daily PRIMARY KEY (
        bucket_date, tenant_id, product_id, source_service, resource_id, metric_name
    )
);

-- Invariant: An original usage event may be reversed at most once per tenant
CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_events_reversal_parent
ON oicunt_usage.usage_events (tenant_id, (lineage->>'parentEventId'))
WHERE (operation = 'usage.reversal' AND lineage->>'parentEventId' IS NOT NULL);

-- Database-Level Immutability Safeguards
-- Authoritative raw usage events are strictly append-only: updates and deletes are prohibited.
CREATE OR REPLACE FUNCTION oicunt_usage.prevent_usage_events_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'oicunt_usage.usage_events is append-only: updates and deletes are prohibited';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_usage_events_update ON oicunt_usage.usage_events;
CREATE TRIGGER trg_prevent_usage_events_update
BEFORE UPDATE ON oicunt_usage.usage_events
FOR EACH ROW EXECUTE FUNCTION oicunt_usage.prevent_usage_events_mutation();

DROP TRIGGER IF EXISTS trg_prevent_usage_events_delete ON oicunt_usage.usage_events;
CREATE TRIGGER trg_prevent_usage_events_delete
BEFORE DELETE ON oicunt_usage.usage_events
FOR EACH ROW EXECUTE FUNCTION oicunt_usage.prevent_usage_events_mutation();
