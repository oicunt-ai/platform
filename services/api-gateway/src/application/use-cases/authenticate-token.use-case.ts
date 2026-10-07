import { type Result, ok, err } from '@oicunt/contracts';
import { type DomainError, type IdentityContext, AuthenticationError } from '../../domain/index.js';
import type { TokenVerifierPort } from '../ports/token-verifier.port.js';

export interface AuthenticateTokenInput {
  readonly authHeader?: string | undefined;
}

export class AuthenticateTokenUseCase {
  constructor(private readonly tokenVerifier: TokenVerifierPort) {}

  async execute(input: AuthenticateTokenInput): Promise<Result<IdentityContext, DomainError>> {
    const authHeader = input.authHeader;
    if (!authHeader || typeof authHeader !== 'string') {
      return err(new AuthenticationError('Missing Authorization header'));
    }

    const trimmed = authHeader.trim();
    if (!trimmed.toLowerCase().startsWith('bearer ')) {
      return err(
        new AuthenticationError("Invalid Authorization header format. Expected 'Bearer <token>'"),
      );
    }

    const token = trimmed.slice(7).trim();
    if (!token) {
      return err(new AuthenticationError('Bearer token is empty'));
    }

    try {
      const identity = await this.tokenVerifier.verifyToken(token);
      return ok(identity);
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return err(error);
      }
      const message = error instanceof Error ? error.message : 'Token verification failed';
      return err(new AuthenticationError(`Token verification failed: ${message}`));
    }
  }
}
