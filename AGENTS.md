# OICUNT Platform — Agent Instructions

Short, self-contained entry point for coding agents (OpenCode, Codex,
Claude Code, Antigravity and compatible tools). This file guides; it does
not technically enforce permissions — always request operator approval for
the actions listed under Authorization boundaries.

## 1. Project purpose

The **OICUNT company platform** monorepo: public API Gateway, internal
authentication enforcement, Usage admission, authoritative Usage accounting
and shared company infrastructure (config, contracts, events, logging,
observability). Long-term production foundation; strict package boundaries.

## 2. Three-repository relationship

- **`platform`** (this repo): company-wide capabilities — Gateway,
  tenant/user identity, admission, metering ledger, enterprise events.
- **`ai-platform`** (sibling repo): AI orchestration, Model Registry,
  Inference, Model Gateway, provider adapters, Memory. Never duplicate its
  logic here.
- **`billy`** (sibling repo): standalone Next.js chatbot. Consumes ONLY the
  public Gateway over HTTP via its server-side BFF. Never implement product
  UI here.

Dependency direction: `billy → platform → ai-platform → providers`.
Company-wide auth and business logic must never be duplicated in
`ai-platform`; AI logic must never leak into `platform` services.

## 3. Local responsibility and boundaries

- Services: `services/api-gateway` (`127.0.0.1:3000`), `services/usage`
  (`127.0.0.1:8090`, loopback only).
- Shared packages: `@oicunt/config`, `@oicunt/contracts`, `@oicunt/events`,
  `@oicunt/logging`, `@oicunt/observability`.
- `services/usage` owns the metering ledger (`oicunt_usage` schema) and
  admission windows/leases. It never applies migrations at startup — schema
  changes run only via `pnpm --filter @oicunt/service-usage migrate`.
- Public contracts live in `packages/contracts/src/ai.ts`
  (contract v1.1.0): `conversationId` is REQUIRED on completions;
  `parentMessageId` is not a supported field.

## 4. Critical source locations

- Gateway routes: `services/api-gateway/src/interfaces/http/router.ts`
- Completion flow: `.../controllers/completion.controller.ts`,
  `.../application/use-cases/forward-completion.use-case.ts`
  (auth → validate → admission acquire → forward; rejected requests never
  consume quota)
- Usage entrypoint: `services/usage/dist/start.js` (built); source
  `services/usage/src/` (hexagonal: `domain/`, `application/`,
  `infrastructure/`, `interfaces/`)
- Launchers (official, use these): `scripts/dev-up.mjs` (`pnpm dev`),
  `scripts/usage-up.mjs` (`pnpm usage`), `scripts/dev-up-lib.mjs`
- Local infra: `../ai-platform/infrastructure/docker/`
  (`docker-compose.local.yml`: Postgres `127.0.0.1:5433`, RabbitMQ
  `127.0.0.1:5672/15672`)

## 5. Verified commands (from `package.json` / CI `.github/workflows/ci.yml`)

```bash
pnpm install --frozen-lockfile
pnpm build            # tsc -b (required before running launchers)
pnpm dev              # Gateway :3000 (needs orchestrator + JWKS; + Usage when admission ON)
pnpm usage            # Usage :8090 (pins loopback; never migrates)
pnpm test             # vitest run
pnpm type-check       # tsc -p tsconfig.typecheck.json
pnpm lint             # eslint .
pnpm format:check     # prettier --check .
pnpm verify           # format + lint + type-check + build + tests
```

CI runs format-check, lint, type-check, test, build on push/PR to `main`.

## 6. Coding conventions (observed, not aspirational)

- Hexagonal layout per service; domain stays framework-free.
- Operational flows return `Result<T, DomainError>`; map errors to
  `ApiErrorResponse` with `X-Correlation-ID` / `X-Request-ID`.
- Every service exposes `/healthz` (liveness) and `/readyz` (readiness);
  readiness must reflect real dependencies (never hardcode "up").
- TypeScript strict; avoid `any` (prefer `unknown` + guards, justify
  exceptions). Prettier + ESLint clean required.
- Unit-testable pure logic lives in exported functions
  (see `scripts/*-lib.mjs`, `src/.../*.test.ts` patterns).

## 7. Security expectations

- User JWTs verify against external JWKS (`JWKS_URI`); internal
  service-to-service JWTs are HS256-signed (`aud: platform-usage`).
- Tokens and passwords are never logged — problems name variables only.
- Real `.env` is git-ignored; `.env.example` holds placeholders.
  `GROQ_API_KEY` never belongs in this repo's processes.
- BILLY dev JWTs come from the sibling issuer file only; never mint,
  forge or bypass identity.

## 8. Working methodology

- Inspect existing implementation before proposing changes; keep diffs
  narrowly scoped; preserve service boundaries and the public contract.
- Run the relevant verification for touched files (`pnpm test`,
  `type-check`, `lint`) and report actual results — never claim
  unperformed tests.
- Distinguish verified observations from assumptions in reports.
- Distinguish IMPLEMENTED (source + tests) from PROPOSED (vision docs);
  company/product direction lives in `docs/company-vision.md` and is
  marked OPEN where undecided.

## 9. Authorization boundaries (operator approval required)

Live AI provider requests; database migrations or direct data changes;
destructive operations; service/Docker restarts affecting the live dev
environment; credential, configuration or feature-flag changes; commits,
pushes, deployments. Read-only inspection and safe local validation
(`test`, `type-check`, `lint`, offline validator harnesses) are fine.

## 10. Deeper documentation

- `README.md` — topology and tech stack
- `docs/architecture.md` — principles and boundaries
- `docs/development.md` — environment, launchers, Usage lifecycle
- `docs/contracts/` — `first-vertical-slice.md`, `usage.md` (ledger side)
- `docs/contributing.md` — branches, commits, PRs
- `docs/company-vision.md` — company direction (some OPEN DECISIONS)
- `docs/ecosystem.md` — three-repo map, ports, identity and metering flows
