# Canonical Microservice Template

This template establishes the architectural foundation and code organization for all backend microservices on the **OICUNT Platform**.

## Architecture Overview

All platform services strictly enforce Clean / Hexagonal Architecture (Ports & Adapters):

```
templates/service/
├── src/
│   ├── domain/               # Enterprise domain logic, value objects & port interfaces
│   │   ├── errors.ts         # Domain error definitions
│   │   └── index.ts          # Aggregate roots & repository ports
│   ├── application/          # Use cases, interactors, and DTOs
│   │   ├── ports.ts          # Inbound & outbound application ports
│   │   └── index.ts          # Use cases returning Result<T, DomainError>
│   ├── infrastructure/       # Outbound adapter implementations
│   │   ├── adapters.ts       # Concrete port implementations (e.g. in-memory or DB)
│   │   └── index.ts          # Re-exports & configuration loading
│   ├── interfaces/           # Inbound adapters (HTTP API, Event Listeners)
│   │   ├── http/             # HTTP router, middleware, and probe endpoints
│   │   │   ├── health.ts     # /healthz and /readyz endpoints
│   │   │   ├── middleware.ts # X-Correlation-ID & error mapping middleware
│   │   │   └── router.ts     # HTTP request dispatcher
│   │   └── index.ts
│   ├── config.ts             # Service configuration schema extending BaseServiceConfig
│   ├── service.ts            # Service instance lifecycle manager (start, stop, health)
│   └── index.ts              # Composition root & signal handlers
├── tests/
│   ├── unit/                 # Domain & application logic tests (isolated, no I/O)
│   └── integration/          # HTTP probe & adapter tests
├── package.json
└── tsconfig.json
```

## Conventions Followed

1. **Clean Architecture Dependency Rule**: Inward dependencies only (`interfaces` & `infrastructure` &rarr; `application` &rarr; `domain`).
2. **Contracts & Envelopes**: All HTTP endpoints return `@oicunt/contracts` envelopes (`ApiResponse`, `ApiErrorResponse`).
3. **Correlation ID**: Incoming `X-Correlation-ID` headers are extracted and propagated into responses and structured logs.
4. **Health Probes**: Implements `/healthz` (liveness) and `/readyz` (readiness) for Kubernetes lifecycle management.
5. **Fail-Fast Configuration**: Validates environment variables at boot via `@oicunt/config`.
6. **Functional Result Pattern**: Domain operations return `Result<T, DomainError>` rather than throwing unhandled exceptions.

## Scaffolding a New Service

To instantiate a new service from this template, use the platform scaffolding script:

```bash
node scripts/create-service.mjs <service-name>
```

Example:

```bash
node scripts/create-service.mjs notification-service
```
