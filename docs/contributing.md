# Contributing to OICUNT Platform

Thank you for contributing to the OICUNT company platform.

---

## 1. Branching Strategy

- `main`: Production-ready, always passing CI. Direct pushes to `main` are restricted.
- Feature branches: `feat/<feature-name>`
- Bug fix branches: `fix/<issue-name>`
- Maintenance branches: `chore/<description>`

---

## 2. Commit Message Guidelines

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <short description>

[optional body]

[optional footer(s)]
```

### Supported Types

- `feat`: A new feature or capability
- `fix`: A bug fix
- `docs`: Documentation only changes
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `test`: Adding missing tests or correcting existing tests
- `chore`: Changes to build process, tooling, or package configurations

---

## 3. Pull Request Requirements

Before submitting a Pull Request, ensure:

1. **All Verification Steps Pass**:
   ```bash
   pnpm verify
   ```
2. **No Regression in Coverage**: All new shared functions, contracts, and utilities must include corresponding unit tests.
3. **Docs are Updated**: Architecture and development docs must be updated if contracts or conventions change.
4. **Clean Git History**: Commits must be logically organized with informative commit messages.

---

## 4. Code Review Criteria

- Strict adhering to shared package boundaries.
- No direct tight-coupling between services.
- Clean separation between interfaces/contracts and implementation details.
- Comprehensive handling of error scenarios via `Result<T, E>`.
