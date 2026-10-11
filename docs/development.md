# Development Guide

This guide describes how to set up, build, test, and contribute to the **OICUNT Platform** monorepo.

---

## 1. Prerequisites

Before getting started, ensure you have the following installed on your workstation:

- **Node.js**: LTS version `>= 20.0.0` (Recommended: Node 22 LTS)
- **pnpm**: `>= 9.0.0` (Recommended: pnpm 10+)
- **Git**: `>= 2.40.0`

To verify your environment:

```bash
node -v
pnpm -v
git --version
```

---

## 2. Getting Started

1. Clone the repository:

   ```bash
   git clone https://github.com/oicunt-ai/platform.git
   cd platform
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Run full verification suite:
   ```bash
   pnpm verify
   ```

---

## 3. Available Workspace Scripts

The root `package.json` provides centralized commands for managing the monorepo:

| Script              | Command                          | Description                                                  |
| ------------------- | -------------------------------- | ------------------------------------------------------------ |
| `pnpm build`        | `tsc -b`                         | Builds all packages using TypeScript project references      |
| `pnpm type-check`   | `tsc -p tsconfig.typecheck.json` | Runs strict type checking without emitting build artifacts   |
| `pnpm lint`         | `eslint .`                       | Runs ESLint analysis across all files                        |
| `pnpm lint:fix`     | `eslint . --fix`                 | Automatically fixes autofixable ESLint errors                |
| `pnpm format`       | `prettier --write .`             | Formats the entire codebase using Prettier                   |
| `pnpm format:check` | `prettier --check .`             | Verifies that all files conform to Prettier formatting       |
| `pnpm test`         | `vitest run`                     | Runs unit and integration tests across the workspace         |
| `pnpm test:watch`   | `vitest`                         | Starts interactive watch mode for testing during development |
| `pnpm verify`       | `node ./scripts/verify.mjs`      | Executes format check, lint, type check, build, and tests    |
| `pnpm clean`        | `node ./scripts/clean.mjs`       | Cleans all `dist`, `coverage`, and compiler artifact caches  |

---

## 4. Package Boundaries & Workspaces

The platform uses `pnpm` workspaces configured in `pnpm-workspace.yaml`.

Shared packages reside in `packages/`:

- `packages/config` -> `@oicunt/config`
- `packages/contracts` -> `@oicunt/contracts`
- `packages/events` -> `@oicunt/events`
- `packages/logging` -> `@oicunt/logging`
- `packages/observability` -> `@oicunt/observability`

To consume a workspace package inside another package or service, use `workspace:*`:

```json
{
  "dependencies": {
    "@oicunt/contracts": "workspace:*",
    "@oicunt/logging": "workspace:*"
  }
}
```

---

## 5. Adding New Shared Packages

When introducing a new shared package under `packages/<name>`:

1. Create `packages/<name>/package.json` with `@oicunt/<name>` name, module exports, and scripts.
2. Create `packages/<name>/tsconfig.json` extending `../../tsconfig.base.json`.
3. Add the package reference to the root `tsconfig.json`.
4. Create `packages/<name>/src/index.ts` with explicit type exports.
5. Create `packages/<name>/src/index.test.ts` for unit test coverage.
6. Create `packages/<name>/README.md` documenting the package purpose.
7. Run `pnpm verify` to confirm everything builds and passes.

---

## 6. Developing Microservices

All platform backend services reside in `services/<service-name>` and follow **Hexagonal / Clean Architecture** (Ports and Adapters).

### 6.1 Scaffolding a New Service

To create a new service from the canonical platform blueprint:

```bash
node scripts/create-service.mjs <service-name>
```

For example:

```bash
node scripts/create-service.mjs payment-service
```

This automates:

1. Copying the canonical blueprint from `templates/service/` to `services/<service-name>/`.
2. Setting the package name to `@oicunt/service-<service-name>`.
3. Configuring typed service configuration and initial ports.

### 6.2 Service Registration Checklist

After scaffolding:

1. Add `{ "path": "./services/<service-name>" }` to the `references` list in root `tsconfig.json`.
2. Run `pnpm install` to link workspace dependencies.
3. Verify the new service compiles and passes initial tests:
   ```bash
   pnpm verify
   ```

### 6.3 Layer Development Conventions

When implementing features inside a service:

1. **Domain (`src/domain/`)**:
   - Write pure TypeScript entities, value objects, and domain errors.
   - Define outbound port interfaces (e.g. `RepositoryPort`).
   - Do **not** import any framework, database client, or outer layer.

2. **Application (`src/application/`)**:
   - Implement use case interactors (`UseCase<TInput, TOutput>`).
   - Return functional `Result<T, DomainError>` envelopes from `@oicunt/contracts`.
   - Never leak database or HTTP specifics into use cases.

3. **Infrastructure (`src/infrastructure/`)**:
   - Implement outbound ports (database repositories, message bus publishers, remote client proxies).
   - Inject service configuration loaded via `@oicunt/config`.

4. **Interfaces (`src/interfaces/`)**:
   - Inbound adapters: HTTP controllers/routers and message subscribers.
   - Always map errors to `ApiErrorResponse` and include `X-Correlation-ID`.
   - Implement `/healthz` (liveness) and `/readyz` (readiness) probe endpoints.

---

## 7. Code Style & Standards

- **TypeScript Strictness**: Do not use `any` unless strictly necessary with documented justification. Prefer `unknown` and type guards.
- **Explicit Returns**: Keep exported functions and public API contracts strongly typed.
- **Formatting**: Run `pnpm format` before opening a pull request.
- **Error Handling**: Use `Result<T, E>` for operational flows; avoid throwing untyped runtime exceptions.

---

## 8. Local Development Stack (`pnpm dev`)

`pnpm dev` runs `scripts/dev-up.mjs`, a dependency-free Node launcher that
starts the Platform API Gateway (3000) with readiness gating, then
supervises it in the foreground. Platform Usage is never started by it.

### Prerequisites

- AI Platform stack running via its own launcher (or equivalent) so the
  Orchestrator answers `/readyz`.
- A development JWT issuer serving JWKS (BILLY's `npm run dev:auth`
  provides `http://127.0.0.1:4567/.well-known/jwks.json`).
- A repo `.env` copied from `.env.example` with real local values.
- A built gateway (`pnpm build`): the launcher runs `dist/start.js`.

### Required environment variable names

`INTERNAL_SERVICE_TOKEN` (shared development secret for service auth;
`INTERNAL_SERVICE_SECRET` and `AI_ORCHESTRATOR_INTERNAL_TOKEN` are
honored when set), `JWKS_URI`, `JWT_ISSUER` (`JWT_AUDIENCE` defaults to
`oicunt-platform`). Missing names abort startup with an explicit list —
values are never printed. Use one strong random value for every local
process; this is the same shared value the AI Platform launcher uses, so
no second identity authority exists.

### Orchestrator URL and admission

The launcher forces `ORCHESTRATOR_BASE_URL=http://127.0.0.1:3003` when
unset and rejects operator-set values that are unparsable or point at
port 3001. `ENABLE_USAGE_ADMISSION=true` aborts startup: admission needs
the Usage service, which this launcher never starts — run it separately
with `pnpm usage`. There is no `--with-usage` option.

### Running, verifying, and stopping

```bash
pnpm dev
```

The Gateway is gated on `/healthz` then `/readyz` (bounded timeouts).
Output shares one terminal prefixed `[api-gateway]` (service) or
`[dev-up]` (launcher). Press Ctrl+C to stop. If the Gateway dies
unexpectedly, the launcher reports it and exits — nothing is restarted
automatically.

### Troubleshooting

- **Occupied port:** the launcher refuses duplicates and names the port
  and probe result. Stop the existing process or free the port.
- **Missing secrets:** the launcher names the exact variables.
- **Orchestrator/JWKS unreachable:** start the AI Platform stack and the
  issuer first; the launcher names which dependency failed.
- **Production guard:** the launcher refuses `NODE_ENV=production` and
  always binds `127.0.0.1`.

### Platform Usage lifecycle (explicit opt-in only)

Usage is never started by `pnpm dev`; `node dist/index.js` is a
side-effect-free library import and never auto-starts anything. The
supported way to run it locally is the official launcher:

```bash
pnpm usage          # loads .env, validates config, enforces 127.0.0.1:8090
```

`scripts/usage-up.mjs` loads the platform-owned `.env` (process values
win), requires the internal token, PostgreSQL settings (`USAGE_DB_*` wins
over `DATABASE_*`) and `RABBITMQ_URL`, refuses `NODE_ENV=production`,
`USE_DATABASE=false`, `USE_RABBITMQ=false`, the removed
`USAGE_AUTO_MIGRATE` toggle, non-loopback bind settings, a missing build
and an occupied port 8090, then supervises the child with Ctrl+C
shutdown (SIGTERM, then SIGKILL for stragglers). It spawns only
`services/usage/dist/start.js` and never a migration command. The token
it forwards is the HS256 HMAC signing secret used to sign internal
service JWTs (`aud platform-usage`, `sub api-gateway`); requests never
carry it raw, and the launcher never transmits it.

Underneath, the entrypoint itself validates its configuration and
refuses to boot without an internal token, explicit PostgreSQL access
(host, port, user, password) and an explicit `amqp://`/`amqps://` broker
URL — there is no implicit `guest@localhost` broker and no
`USE_DATABASE=false` / `USE_RABBITMQ=false` escape hatch — so a
misconfigured process fails closed instead of running degraded against
in-memory fallbacks. It then performs a **read-only schema compatibility
verification** (migration ledger plus the critical tables/columns this
build queries) and refuses to serve traffic when the deployed schema does
not match. Routine startup **never applies migrations**: schema changes
require the deliberate command `pnpm --filter @oicunt/service-usage
migrate`, after a database backup. The raw entrypoint binds all
interfaces (`0.0.0.0`) unless `USAGE_SERVICE_HOST` is set explicitly —
the `pnpm usage` launcher pins `127.0.0.1:8090`. Readiness (`/readyz`)
reflects the real dependencies: no pool or an inactive consumer reports
503, never "up". Migration history lives in `oicunt_usage._migrations`;
usage records are append-only and corrected via reversal events, never
SQL updates.
