# Platform Services

This directory is reserved for OICUNT backend services and microservices as they are built.

## Architectural Boundaries

- Services must consume shared packages (`@oicunt/config`, `@oicunt/contracts`, `@oicunt/events`, `@oicunt/logging`, `@oicunt/observability`).
- Services must remain loosely coupled, communicating through defined contracts and domain events.
- Services must be self-contained with their own domain logic, tests, and deployment targets.
- Placeholder services are not permitted in this directory; only fully specified, production implementations are introduced.
