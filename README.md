# OICUNT Platform

[![CI](https://github.com/oicunt-ai/platform/actions/workflows/ci.yml/badge.svg)](https://github.com/oicunt-ai/platform/actions/workflows/ci.yml)
[![Node.js LTS](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D9.0.0-orange.svg)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/typescript-strict-blue.svg)](https://www.typescriptlang.org/)

The core monorepo for the **OICUNT** company platform. Engineered as a long-term production foundation utilizing strict package boundaries, type safety, modular infrastructure, and contract-driven architecture.

---

## 🏛️ Architecture Overview

The platform uses a pnpm workspaces monorepo topology:

```
platform/
├── .github/                 # CI/CD workflows (GitHub Actions)
├── docs/                    # Architecture, design decisions, and dev guides
│   ├── architecture.md      # Platform architecture & principles
│   ├── development.md       # Local environment & script reference
│   └── contributing.md      # Branching, commits, and PR standards
├── infrastructure/          # Cloud infrastructure and deployment configurations
│   ├── docker/              # Multi-stage Docker definitions
│   ├── helm/                # Kubernetes Helm charts
│   ├── kubernetes/          # Raw declarative K8s manifests & overlays
│   └── terraform/           # Terraform modules & environment state
├── packages/                # Shared foundational libraries
│   ├── config/              # Centralized environment schema & validation
│   ├── contracts/           # API response envelopes, HTTP status, Result types
│   ├── events/              # Domain event envelopes & event bus contracts
│   ├── logging/             # Structured logging interfaces & standard levels
│   └── observability/       # Distributed tracing & metrics recorder interfaces
├── services/                # Backend microservices & daemons (to be implemented)
├── tests/                   # Monorepo-level integration & foundation tests
└── scripts/                 # Platform automation scripts
```

For in-depth architectural details, see [Architecture Documentation](docs/architecture.md).

---

## 📦 Shared Packages

| Package                                           | Purpose                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`@oicunt/config`](packages/config)               | Environment resolution, service baseline config, and validation contracts                 |
| [`@oicunt/contracts`](packages/contracts)         | Standard API envelopes, pagination meta, HTTP status codes, and `Result<T, E>` monad      |
| [`@oicunt/events`](packages/events)               | Domain event envelopes, distributed metadata stamping, and publisher/subscriber contracts |
| [`@oicunt/logging`](packages/logging)             | Structured logger interfaces, severity ordering, and test memory logger                   |
| [`@oicunt/observability`](packages/observability) | Distributed tracing (`Tracer`, `Span`) and metric collection (`MetricsRecorder`)          |

---

## 🛠️ Tech Stack

- **Runtime**: Node.js LTS (`>= 20.0.0`)
- **Language**: TypeScript (`5.7+`) with strict type checking and project references
- **Package Manager**: pnpm workspaces
- **Code Quality**: ESLint 9 (flat config) + Prettier
- **Test Runner**: Vitest
- **Continuous Integration**: GitHub Actions

---

## 🚀 Getting Started

### Prerequisites

- Node.js LTS (`>= 20.0.0`)
- pnpm (`>= 9.0.0`)

### Installation

```bash
# Clone the repository
git clone https://github.com/oicunt-ai/platform.git
cd platform

# Install dependencies across all workspaces
pnpm install
```

### Verification & Validation

Run all verification checks in a single command:

```bash
pnpm verify
```

Or run individual tasks:

```bash
# Type check all packages
pnpm type-check

# Compile packages to dist
pnpm build

# Run ESLint across workspace
pnpm lint

# Check formatting
pnpm format:check

# Format files
pnpm format

# Execute test suite
pnpm test
```

---

## 🔄 CI/CD Pipeline

Every pull request and push to `main` executes the automated GitHub Actions CI workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

1. **Dependency Installation**: `pnpm install --frozen-lockfile`
2. **Format Conformity**: `pnpm format:check`
3. **Static Analysis**: `pnpm lint`
4. **Type Soundness**: `pnpm type-check`
5. **Test Suite**: `pnpm test`
6. **Package Compilation**: `pnpm build`

---

## 📚 Documentation

- [Architecture Overview](docs/architecture.md)
- [Development Guide](docs/development.md)
- [Contributing Guidelines](docs/contributing.md)

---

## 📄 License

Proprietary and confidential. Copyright &copy; OICUNT. All rights reserved.
