# @oicunt/contracts

Shared API, messaging, and data transfer contracts for the OICUNT platform.

## Purpose

- Define standard API response envelopes (`ApiResponse`, `ApiErrorResponse`, `PaginatedResponse`).
- Standardize HTTP status codes across all services.
- Provide functional `Result<T, E>` monad primitives for resilient error handling without unhandled exceptions.
- Provide deterministic pagination metadata contracts.

## Exports

- `HttpStatus`: Constant map of canonical HTTP status codes.
- `ApiResponse<T>`: Standard success envelope.
- `ApiErrorResponse`: Standard error envelope with actionable error codes.
- `PaginatedResponse<T>`: Standard pagination structure.
- `Result<T, E>`, `ok()`, `err()`: Result pattern primitives.
- `calculatePagination()`: Pagination metadata calculation utility.
