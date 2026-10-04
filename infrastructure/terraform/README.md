# Infrastructure: Terraform

This directory manages cloud infrastructure as code (IaC) across cloud environments for the OICUNT platform.

## Structure

- `modules/`: Reusable, parameterized infrastructure modules (networking, compute, storage, security).
- `environments/`: Environment-level state root configurations (dev, staging, prod) using remote state backends.

## Guidelines

- All resources must be tagged with environment, owner, and service metadata.
- Remote state with state locking is mandatory for multi-engineer environments.
- Zero secrets committed; integrate with cloud provider secret managers.
