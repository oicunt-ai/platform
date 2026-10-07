import { type Result, ok } from '@oicunt/contracts';
import type { DomainError, IdentityContext } from '../../domain/index.js';

export interface ContextResponseData {
  readonly userId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly scopes: readonly string[];
}

export class GetContextUseCase {
  async execute(identity: IdentityContext): Promise<Result<ContextResponseData, DomainError>> {
    return ok({
      userId: identity.userId,
      tenantId: identity.tenantId,
      roles: identity.roles,
      permissions: identity.permissions,
      scopes: identity.scopes,
    });
  }
}
