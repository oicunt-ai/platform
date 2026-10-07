import type { IdentityContext } from '../../domain/index.js';

export interface TokenVerifierPort {
  /**
   * Verifies an incoming raw JWT string.
   * Performs signature verification, algorithm check (RS256), expiration,
   * not-before, issuer, audience, and extracts the authoritative IdentityContext.
   * Throws AuthenticationError or ValidationError if invalid.
   */
  verifyToken(token: string): Promise<IdentityContext>;
}
