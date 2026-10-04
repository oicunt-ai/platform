# Platform Services

This directory is reserved for OICUNT backend microservices and worker daemons as they are implemented.

> **Production Policy**: Placeholder or stub services are strictly forbidden in this directory. Only fully specified, production microservices adhering to the platform architecture standards may reside here.

---

## 1. Architectural Standards for Services

Every service introduced into this directory must implement **Hexagonal / Clean Architecture** (Ports and Adapters) with four distinct layers:

```
services/<service-name>/
├── src/
│   ├── domain/               # Core entities, aggregates, domain errors & repository ports
│   ├── application/          # Use cases, application services, DTOs & outbound ports
│   ├── infrastructure/       # Outbound adapter implementations (DB, messaging, config)
│   ├── interfaces/           # Inbound adapters (HTTP API routes, middleware, probes)
│   ├── config.ts             # Typed configuration schema extending BaseServiceConfig
│   ├── service.ts            # Service instance lifecycle manager (start, stop, probes)
│   └── index.ts              # Composition root, bootstrap & signal handling
├── tests/
│   ├── unit/                 # Domain and use case tests (pure in-memory, no I/O)
│   ├── integration/          # Adapter and repository tests
│   └── e2e/                  # End-to-end HTTP API tests
├── package.json
├── tsconfig.json
└── README.md
```

---

## 2. Mandatory Service Conventions

1. **Service Ownership Boundaries**:
   - Each service encapsulates a single Domain-Driven Design (DDD) bounded context.
   - **Database-per-service**: Services strictly own their data persistence. Direct cross-database joins or shared database connections are prohibited.
2. **Dependency Inversion**:
   - The inward dependency rule is strictly enforced: `interfaces` and `infrastructure` depend on `application` and `domain`. Inner layers never import from outer layers.
3. **HTTP API Standards**:
   - URL path versioning (`/api/v1/...`) with kebab-case resource paths.
   - Standard JSON envelopes from `@oicunt/contracts` (`ApiResponse<T>`, `ApiErrorResponse`, `PaginatedResponse<T>`).
   - Mandatory propagation of `X-Correlation-ID`.
4. **Configuration**:
   - Extends `BaseServiceConfig` from `@oicunt/config`.
   - Validated at startup; invalid configurations fail-fast and terminate the process.
5. **Error Handling**:
   - Operational failures return `Result<T, DomainError>` (`ok`/`err`).
   - Mapped at the HTTP interface layer to standard `ApiErrorResponse` envelopes without leaking internal stack traces.
6. **Logging & Observability**:
   - Structured JSON logging using `@oicunt/logging` with scoped child loggers per request.
   - Distributed tracing and metrics collection via `@oicunt/observability`.
7. **Health & Readiness Endpoints**:
   - `/healthz` (liveness probe): Returns 200 if the Node.js event loop is operational.
   - `/readyz` (readiness probe): Returns 200 when ready to receive traffic, or 503 during startup or downstream outage.
8. **Inter-Service Communication**:
   - Asynchronous event-driven messaging via `@oicunt/events` as the default.
   - Synchronous HTTP fallback requires timeouts, correlation propagation, and idempotent retry strategies.
9. **Event Publishing & Consuming**:
   - All events conform to `DomainEvent<T>` with standard `EventMetadata`.
   - Event consumers must implement idempotent processing based on `eventId`.
10. **Testing**:
    - Comprehensive unit tests for domain and application layers (`tests/unit/`).
    - Focused integration tests for outbound adapters and HTTP endpoints (`tests/integration/`).

---

## 3. Creating a New Service

To instantiate a new service from the canonical platform blueprint:

```bash
node scripts/create-service.mjs <service-name>
```

Example:

```bash
node scripts/create-service.mjs notification-service
```

This scaffolds the full 4-layer structure from [`templates/service/`](../templates/service) and configures workspace dependencies.

After scaffolding, register the new service in the root `tsconfig.json` `references` list and run:

```bash
pnpm install
pnpm verify
```

For complete architecture details, refer to [Platform Architecture Documentation](../docs/architecture.md).
