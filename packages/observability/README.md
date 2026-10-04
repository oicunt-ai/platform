# @oicunt/observability

Shared observability, tracing abstractions, and metric collection interfaces for the OICUNT platform.

## Purpose

- Define instrumentation interfaces for distributed tracing and application metrics.
- Enforce standard telemetry contracts decoupled from vendor implementations (OpenTelemetry, Prometheus, Datadog).
- Provide default safe `NoopSpan`, `NoopTracer`, and `NoopMetricsRecorder` instances for resilient execution when telemetry is disabled or unconfigured.

## Exports

- `Tracer`, `Span`, `SpanContext`: Tracing contracts and context propagation models.
- `MetricsRecorder`: Core contract for counters, gauges, and histograms.
- `NoopTracer`, `NoopSpan`, `NoopMetricsRecorder`: Safe no-op implementations for development and testing.
