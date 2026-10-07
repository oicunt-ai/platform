# OICUNT Platform: API Gateway / Perimeter

The **OICUNT Platform API Gateway** is the authoritative ingress controller and security perimeter boundary for the platform.

## Architecture

```text
BILLY (Client)
  ↓ HTTPS + Bearer JWT
OICUNT API Gateway (services/api-gateway)
  ↓ trusted internal context (X-User-ID, X-Tenant-ID, X-Request-ID, X-Correlation-ID)
AI Orchestrator (internal service)
```

## Security Invariants

1. **Perimeter Authentication**:
   - Authenticates incoming JWT access tokens using OIDC/JWKS RS256 signature verification.
   - Validates `alg: 'RS256'`, `iss`, `aud`, `exp`, and `nbf`.
   - Never trusts unsigned or client-decoded tokens.
   - Rejects unauthenticated requests with HTTP 401 (`UNAUTHORIZED`).

2. **Authoritative Identity Establishment**:
   - `userId` is strictly extracted from verified `sub` claim.
   - `tenantId` is strictly extracted from verified `tenant_id` or `tenantId` claim.
   - `roles`, `scopes`, and `permissions` are derived solely from verified token claims.

3. **Perimeter Header Sanitization**:
   - Client-supplied internal identity, authorization, service-name, and request headers (`X-User-ID`, `X-Tenant-ID`, `X-Roles`, `X-Scopes`, `X-Permissions`, `X-Service-Name`, `X-Request-ID`) are unconditionally stripped and ignored to prevent identity spoofing.
   - Authoritative `X-Request-ID` (UUID v4) is generated at the gateway ingress.
   - `X-Correlation-ID` is preserved if provided as a valid string, or generated (UUID v4) if absent.
   - Trusted identity headers are injected solely by the API Gateway when forwarding downstream.

4. **Authorization**:
   - AI completion endpoint requires the `ai:use` scope or permission.
   - Authenticated callers lacking `ai:use` receive HTTP 403 (`FORBIDDEN`).

5. **Unary JSON Forwarding**:
   - Step 1 supports unary JSON completion forwarding only.
   - Streaming SSE responses are explicitly deferred to Step 5.
   - Requests asserting `stream: true` are rejected with HTTP 400 (`VALIDATION_FAILED`).
   - Service-to-service authentication is deferred to Step 6.

6. **Isolation**:
   - Provider credentials reside exclusively in the Model Gateway; the API Gateway has zero exposure to provider API keys.
   - Downstream services receive identity solely over trusted internal service boundaries from the API Gateway.

## Endpoints

| Method | Path                     | Authentication        | Description                                                                   |
| ------ | ------------------------ | --------------------- | ----------------------------------------------------------------------------- |
| `GET`  | `/healthz`               | None                  | Liveness probe (`200 OK`)                                                     |
| `GET`  | `/readyz`                | None                  | Readiness probe (`200 OK` / `503 Service Unavailable`)                        |
| `GET`  | `/api/v1/context`        | Bearer JWT            | Returns authoritative user, tenant, and role context without exposing raw JWT |
| `POST` | `/api/v1/ai/completions` | Bearer JWT (`ai:use`) | Validates payload, injects trusted headers, and proxies unary completion      |

## Architecture & Code Structure

Follows standard Clean / Hexagonal Architecture:

```text
services/api-gateway/
├── src/
│   ├── domain/               # IdentityContext, JWT claim definitions, domain errors
│   ├── application/          # Ports (TokenVerifier, OrchestratorClient) and use cases
│   ├── infrastructure/       # JwksTokenVerifier (RS256), HttpOrchestratorClient (unary)
│   ├── interfaces/           # HTTP router, middleware (header sanitizer), controllers
│   ├── config.ts             # Gateway configuration
│   ├── service.ts            # GatewayServiceInstance lifecycle
│   └── index.ts              # Composition root
└── tests/
    ├── unit/                 # Identity, JWKS verifier, header sanitization, use case tests
    └── integration/          # Health probes, context endpoint, unary completions proxy tests
```
