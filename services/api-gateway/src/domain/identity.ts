export interface IdentityContext {
  readonly userId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly scopes: readonly string[];
}

export function hasScopeOrPermission(identity: IdentityContext, required: string): boolean {
  return (
    identity.scopes.includes(required) ||
    identity.permissions.includes(required) ||
    identity.roles.includes(required)
  );
}

export function createIdentityContext(params: {
  readonly userId: string;
  readonly tenantId: string;
  readonly roles?: readonly string[];
  readonly permissions?: readonly string[];
  readonly scopes?: readonly string[];
}): IdentityContext {
  if (!params.userId || typeof params.userId !== 'string' || params.userId.trim().length === 0) {
    throw new Error('IdentityContext requires a non-empty userId');
  }
  if (
    !params.tenantId ||
    typeof params.tenantId !== 'string' ||
    params.tenantId.trim().length === 0
  ) {
    throw new Error('IdentityContext requires a non-empty tenantId');
  }

  return {
    userId: params.userId.trim(),
    tenantId: params.tenantId.trim(),
    roles: Object.freeze(params.roles ? [...params.roles] : []),
    permissions: Object.freeze(params.permissions ? [...params.permissions] : []),
    scopes: Object.freeze(params.scopes ? [...params.scopes] : []),
  };
}
