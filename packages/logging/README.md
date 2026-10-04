# @oicunt/logging

Shared logging interfaces, structured payload standards, and logger contracts for the OICUNT platform.

## Purpose

- Provide unified logging contracts across all platform services and worker nodes.
- Define structured log contexts and serialized error representation.
- Ensure consistent severity prioritization (`trace`, `debug`, `info`, `warn`, `error`, `fatal`).
- Provide standard `NoopLogger` for silence/fallback and `MemoryLogger` for deterministic test verification.

## Exports

- `Logger`: Core contract with structured logging and child logger capabilities.
- `LogLevel`: Supported log levels.
- `LogEntry`: Standard structured log entry structure.
- `NoopLogger`: Safe no-op logger instance.
- `MemoryLogger`: In-memory logger implementation for tests.
