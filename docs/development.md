# Development Guide

This guide describes how to set up, build, test, and contribute to the **OICUNT Platform** monorepo.

---

## 1. Prerequisites

Before getting started, ensure you have the following installed on your workstation:

- **Node.js**: LTS version `>= 20.0.0` (Recommended: Node 22 LTS)
- **pnpm**: `>= 9.0.0` (Recommended: pnpm 10+)
- **Git**: `>= 2.40.0`

To verify your environment:

```bash
node -v
pnpm -v
git --version
```

---

## 2. Getting Started

1. Clone the repository:

   ```bash
   git clone https://github.com/oicunt-ai/platform.git
   cd platform
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Run full verification suite:
   ```bash
   pnpm verify
   ```

---

## 3. Available Workspace Scripts

The root `package.json` provides centralized commands for managing the monorepo:

| Script              | Command                          | Description                                                  |
| ------------------- | -------------------------------- | ------------------------------------------------------------ |
| `pnpm build`        | `tsc -b`                         | Builds all packages using TypeScript project references      |
| `pnpm type-check`   | `tsc -p tsconfig.typecheck.json` | Runs strict type checking without emitting build artifacts   |
| `pnpm lint`         | `eslint .`                       | Runs ESLint analysis across all files                        |
| `pnpm lint:fix`     | `eslint . --fix`                 | Automatically fixes autofixable ESLint errors                |
| `pnpm format`       | `prettier --write .`             | Formats the entire codebase using Prettier                   |
| `pnpm format:check` | `prettier --check .`             | Verifies that all files conform to Prettier formatting       |
| `pnpm test`         | `vitest run`                     | Runs unit and integration tests across the workspace         |
| `pnpm test:watch`   | `vitest`                         | Starts interactive watch mode for testing during development |
| `pnpm verify`       | `node ./scripts/verify.mjs`      | Executes format check, lint, type check, build, and tests    |
| `pnpm clean`        | `node ./scripts/clean.mjs`       | Cleans all `dist`, `coverage`, and compiler artifact caches  |

---

## 4. Package Boundaries & Workspaces

The platform uses `pnpm` workspaces configured in `pnpm-workspace.yaml`.

Shared packages reside in `packages/`:

- `packages/config` -> `@oicunt/config`
- `packages/contracts` -> `@oicunt/contracts`
- `packages/events` -> `@oicunt/events`
- `packages/logging` -> `@oicunt/logging`
- `packages/observability` -> `@oicunt/observability`

To consume a workspace package inside another package or service, use `workspace:*`:

```json
{
  "dependencies": {
    "@oicunt/contracts": "workspace:*",
    "@oicunt/logging": "workspace:*"
  }
}
```

---

## 5. Adding New Packages

When introducing a new shared package under `packages/<name>`:

1. Create `packages/<name>/package.json` with `@oicunt/<name>` name, module exports, and scripts.
2. Create `packages/<name>/tsconfig.json` extending `../../tsconfig.base.json`.
3. Add the package reference to the root `tsconfig.json`.
4. Create `packages/<name>/src/index.ts` with explicit type exports.
5. Create `packages/<name>/src/index.test.ts` for unit test coverage.
6. Create `packages/<name>/README.md` documenting the package purpose.
7. Run `pnpm verify` to confirm everything builds and passes.

---

## 6. Code Style & Standards

- **TypeScript Strictness**: Do not use `any` unless strictly necessary with documented justification. Prefer `unknown` and type guards.
- **Explicit Returns**: Keep exported functions and public API contracts strongly typed.
- **Formatting**: Run `pnpm format` before opening a pull request.
