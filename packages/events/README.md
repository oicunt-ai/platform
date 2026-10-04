# @oicunt/events

Shared event schemas, domain event envelopes, and publisher/subscriber interfaces for the OICUNT platform.

## Purpose

- Provide strict contracts for domain events and message envelopes.
- Guarantee metadata uniformity (correlation ID, causation ID, producer, timestamp, versioning).
- Provide abstract publisher and subscriber contracts ready to be backed by message brokers.
- Include a zero-dependency in-memory implementation for unit testing and local development.

## Exports

- `DomainEvent<T>`: Canonical domain event wrapper.
- `EventMetadata`: Distributed tracing and auditing metadata.
- `EventPublisher`: Contract for event publishing.
- `EventSubscriber`: Contract for event subscription.
- `createDomainEvent()`: Factory creating immutable domain events with UUIDs.
- `InMemoryEventBus`: Test and local development bus implementation.
