import {
  type IdentityContext,
  AuthenticationError,
  createIdentityContext,
} from '../../domain/index.js';
import type { TokenVerifierPort } from '../../application/ports/token-verifier.port.js';

export interface StaticTokenMapping {
  readonly token: string;
  readonly identity: IdentityContext;
}

export class StaticTokenVerifier implements TokenVerifierPort {
  private readonly tokens: Map<string, IdentityContext> = new Map();

  constructor(initialTokens: readonly StaticTokenMapping[] = []) {
    for (const item of initialTokens) {
      this.tokens.set(item.token, item.identity);
    }
  }

  registerToken(token: string, identity: IdentityContext): void {
    this.tokens.set(token, identity);
  }

  async verifyToken(token: string): Promise<IdentityContext> {
    const identity = this.tokens.get(token);
    if (!identity) {
      throw new AuthenticationError('Token not recognized or expired in static verifier');
    }
    return createIdentityContext(identity);
  }
}
