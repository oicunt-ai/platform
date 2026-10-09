CREATE TABLE IF NOT EXISTS oicunt_usage.admission_windows (
    scope_type VARCHAR(16) NOT NULL,
    scope_id VARCHAR(192) NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    request_count INTEGER NOT NULL,
    PRIMARY KEY (scope_type, scope_id, window_start)
);

CREATE TABLE IF NOT EXISTS oicunt_usage.admission_leases (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admission_leases_tenant_expiry
    ON oicunt_usage.admission_leases (tenant_id, expires_at);
