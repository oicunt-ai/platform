# OICUNT Ecosystem Map

Single cross-repository reference. Service tables reflect the verified
local development layout; reverify live ports/processes when it matters —
never assume a previous session's state.

## Repositories

| Repository    | Owns                                                                 | Consumes                              |
| ------------- | -------------------------------------------------------------------- | ------------------------------------- |
| `platform`    | Gateway, identity enforcement, admission, Usage ledger, shared libs  | AI Platform (orchestrator) downstream |
| `ai-platform` | Orchestration, Registry, Inference, Model Gateway, providers, Memory | Upstream model providers              |
| `billy`       | Standalone Next.js chat product + server BFF                         | Public Platform Gateway only          |

Upstream remotes (stable links): `github.com/oicunt-ai/platform`,
`github.com/oicunt-ai/ai-platform`. BILLY has no CI badge/remote
convention documented; treat its origin as unspecified.

## Local ports (loopback only)

| Service                    | Address                                                   |
| -------------------------- | --------------------------------------------------------- |
| Platform Gateway           | `127.0.0.1:3000`                                          |
| Model Registry             | `127.0.0.1:3001`                                          |
| Model Gateway              | `127.0.0.1:3002`                                          |
| AI Orchestrator            | `127.0.0.1:3003`                                          |
| Inference                  | `127.0.0.1:3004`                                          |
| Memory                     | `127.0.0.1:3005`                                          |
| Platform Usage             | `127.0.0.1:8090`                                          |
| BILLY app                  | `127.0.0.1:3100`                                          |
| Dev JWKS issuer            | `127.0.0.1:4567`                                          |
| Postgres (compose)         | `127.0.0.1:5433` (host `5432` is unrelated — never touch) |
| RabbitMQ AMQP / management | `127.0.0.1:5672` / `127.0.0.1:15672`                      |

Databases: `oicunt_ai` (registry, outbox), `oicunt_memory`
(conversations), `oicunt_usage` (events, aggregates, admission).
Queues: `oicunt.usage.events`, `oicunt.usage.dlq`,
`oicunt.usage.retry.{5s,30s,5m}`; exchange `oicunt.usage`.

## Identity flow (development)

Ephemeral dev issuer (`billy`, `npm run dev:auth`) → token file read
server-side → Gateway verifies user JWT against
`127.0.0.1:4567/.well-known/jwks.json` (`aud oicunt-platform`,
`scope ai:use`). Service-to-service uses HS256 internal JWTs. The browser
never sees Gateway tokens.

## Metering flow

Model Gateway captures provider usage → durable outbox → RabbitMQ
`oicunt.usage` → Usage consumer persists `usage_events` (idempotent per
completion), hourly/daily aggregates, admission windows. Flags:
`ENABLE_USAGE_ADMISSION` (platform), `ENABLE_USAGE_PUBLISHING`
(ai-platform) — both explicitly `true` in current development.

## Boundary rules

- No repo duplicates another's owned logic (auth in platform, AI in
  ai-platform, product UI in billy).
- BILLY reaches Platform only through its BFF; no direct provider calls
  from any client.
- Contract source of truth: `platform/packages/contracts/src/ai.ts`
  (public) plus `ai-platform/docs/contracts/` per capability.
