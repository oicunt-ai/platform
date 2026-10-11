# Metering Activation — Controlled Integration Runbook

Status: **PROCEDURE ONLY — DO NOT EXECUTE.** Each phase below needs its
own explicit authorization. Publishing and admission stay disabled until
the final phase. No step here has been run.

## Prerequisites (all phases)

- P1 (outbox), P2 (publisher), P3 (consumer), P4 (contract + explicit
  activation) code reviewed and committed.
- RabbitMQ ≥ 3.13 with the `stream_queue` feature flag enabled
  (`rabbitmqctl status` / management overview).
- Backups: PostgreSQL `oicunt_usage` AND `oicunt_ai` databases.
- Record baselines first (lengths/counts only, never secrets):
  - `oicunt_usage` ledger rows + timestamps, counts
    (usage_events / hourly / daily / admission_windows / admission_leases).
  - RabbitMQ: exchanges, bindings, queue depths, consumer counts.
  - `platform/.env` and `ai-platform/.env` contain the required keys
    (presence only).

## Phase A — Model Gateway outbox migration (separate authorization)

1. Approve and run ONLY: `pnpm --filter @oicunt-ai/service-model-gateway migrate`
   (applies `001_metering_outbox.sql` to `oicunt_ai`, nothing else).
2. Verify: `model_gateway_outbox.metering_outbox` exists with all 13
   columns; `_migrations` ledger records the file; `oicunt_usage`
   untouched (ledger + counts identical to baseline).
3. Rollback: the migration creates a new schema only — drop
   `model_gateway_outbox` to revert; no existing schema is altered.

## Phase B — Broker topology verification (read-only)

1. Confirm quorum `oicunt.usage.retry.{5s,30s,5m}` queues exist with
   `x-dead-letter-strategy: at-least-once`, `x-overflow: reject-publish`,
   uniform TTLs, DLX `oicunt.usage`, DL routing key `usage.v1.retry`.
2. Confirm the `usage.v1.#` binding still routes `usage.v1.retry`.
3. Confirm DLQ depth is 0 and `oicunt.usage.events` has exactly one
   consumer (the running Usage service).

## Phase C — Controlled Usage restart to load P3 (separate authorization)

1. Operator stops Usage (Ctrl+C in its terminal), pulls the P3 build,
   runs `pnpm build`, restarts via `pnpm usage`.
2. Verify: `usage ready` log, `/readyz` 200 with `database=up` +
   `usageQueue=up`, listener on 127.0.0.1:8090 only, consumer count
   back to 1, DB counts unchanged.

## Phase D — Isolated routing/retry tests with synthetic events

With publishing still OFF, publish synthetic events (test tenant only)
directly to `oicunt.usage` and verify: persistence, transient-failure
retry tiers with growing delays, DLQ on exhaustion, duplicate collapse
(`UNIQUE (tenant_id, idempotency_key)`), and unchanged real records.
Purge test-tenant data afterwards via reversal events (never SQL).

## Phase E — One live AI completion (separate authorization)

1. Set `ENABLE_USAGE_PUBLISHING=true` in `ai-platform/.env` (explicit;
   deployment-controlled). Leave `ENABLE_USAGE_ADMISSION` unset (OFF).
2. Restart Model Gateway only (separate authorization).
3. Issue ONE supervised completion; verify: outbox row captured then
   deleted on confirm; queue depth returns to 0/0/0; exactly one new
   `usage_events` row with provider counts; aggregates +1; unrelated
   records unchanged.
4. Recovery: any anomaly → set the flag back to `false`, restart the
   gateway, confirm metering stops; outbox leftovers drain or are
   quarantined visibly — nothing is silently discarded.

## Phase F — Admission (separate authorization, last)

Only after Phase E is stable: set `ENABLE_USAGE_ADMISSION=true`,
restart the Platform Gateway, verify acquire/release flows and 429
behavior under limits. Roll back by unsetting the flag.

## Rollback summary

Every phase is reversible without data surgery: flags to `false` +
restarts stop metering/admission; outbox and queue contents drain or
stay inspectable; usage records are append-only (reversals, never
updates); `model_gateway_outbox` can be dropped independently.
