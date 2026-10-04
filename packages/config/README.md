# @oicunt/config

Shared configuration contracts, environment management definitions, and validation interfaces for the OICUNT platform.

## Purpose

- Define standard service configuration schemas.
- Provide strong environment typing (`development`, `staging`, `production`, `test`).
- Expose validation result wrappers for environment and runtime configuration.

## Exports

- `Environment`: Environment union type.
- `BaseServiceConfig`: Common configuration contract for all platform services.
- `ConfigProvider<T>`: Interface for service-specific configuration loaders.
- `resolveEnvironment()`: Safe environment parser with fallbacks.
- `createBaseConfig()`: Factory for foundational service settings.
