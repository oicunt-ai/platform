# Infrastructure: Docker

This directory houses base Docker images, multi-stage build definitions, and container configuration templates for OICUNT services and packages.

## Structure

- Future shared base images (e.g., hardened Node.js LTS runtime images).
- Local container configuration for developer workflows.

## Guidelines

- All service images must run as non-root users.
- Use multi-stage builds to minimize image surface and avoid shipping development dependencies to production.
