# Infrastructure: Kubernetes

This directory houses base Kubernetes manifests, cluster resource definitions, and environment overlays (dev, staging, prod) using Kustomize or standard declarative manifests.

## Structure

- Base manifests and CRDs.
- Environment overlays for cluster governance, network policies, and resource quotas.

## Guidelines

- Network policies default to deny-all ingress across namespaces.
- All deployments enforce explicit CPU and memory resource requests and limits.
- Secrets must never be committed to source control; use external secret operators or KMS providers.
