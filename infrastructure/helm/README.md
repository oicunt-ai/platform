# Infrastructure: Helm

This directory contains Helm charts and values templates for packaging and deploying OICUNT platform components.

## Structure

- Shared library charts for standardized microservice deployment templates.
- Environment-specific values templates (`values.dev.yaml`, `values.prod.yaml`).

## Guidelines

- Semantic versioning for charts with strict validation in CI.
- Mandatory liveness and readiness probe configurations across all templates.
