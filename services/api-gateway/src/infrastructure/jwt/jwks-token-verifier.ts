import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import {
  type IdentityContext,
  type JwkKey,
  type JwksDocument,
  type JwtClaims,
  type JwtHeader,
  AuthenticationError,
  createIdentityContext,
} from '../../domain/index.js';
import type { TokenVerifierPort } from '../../application/ports/token-verifier.port.js';

export interface JwksTokenVerifierOptions {
  readonly jwksUri?: string | undefined;
  readonly issuer?: string | undefined;
  readonly audience?: string | undefined;
  readonly clockSkewSeconds?: number | undefined;
  readonly staticJwks?: JwksDocument | undefined;
  readonly cacheTtlMs?: number | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}

export class JwksTokenVerifier implements TokenVerifierPort {
  private readonly jwksUri?: string | undefined;
  private readonly issuer?: string | undefined;
  private readonly audience?: string | undefined;
  private readonly clockSkewSeconds: number;
  private readonly cacheTtlMs: number;
  private readonly fetchFn: typeof fetch;

  // Cached key objects mapped by kid or '__default__'
  private cachedKeys: Map<string, { key: KeyObject; jwk: JwkKey }> = new Map();
  private lastJwksFetch = 0;

  constructor(options: JwksTokenVerifierOptions = {}) {
    this.jwksUri = options.jwksUri;
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.clockSkewSeconds = options.clockSkewSeconds ?? 60;
    this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60 * 1000; // 10 minutes
    this.fetchFn = options.fetchFn ?? globalThis.fetch;

    if (options.staticJwks) {
      this.loadJwksDocument(options.staticJwks);
    }
  }

  async verifyToken(rawToken: string): Promise<IdentityContext> {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new AuthenticationError('Token must be a non-empty string');
    }

    const parts = rawToken.split('.');
    if (parts.length !== 3) {
      throw new AuthenticationError(
        'Malformed JWT: must consist of header, payload, and signature',
      );
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    if (!headerB64 || !payloadB64) {
      throw new AuthenticationError('Malformed JWT: header and payload must not be empty');
    }

    // 1. Decode & parse header
    const header = this.parseHeader(headerB64);

    // 2. Algorithm validation - strictly RS256
    if (header.alg !== 'RS256') {
      throw new AuthenticationError(
        `Unsupported JWT algorithm '${header.alg}'. Only 'RS256' is accepted`,
      );
    }

    if (!signatureB64) {
      throw new AuthenticationError('Malformed JWT: signature must not be empty');
    }

    // 3. Resolve public key for verification
    const publicKey = await this.resolvePublicKey(header.kid);

    // 4. Verify cryptographic signature
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
    const signatureBuffer = Buffer.from(signatureB64, 'base64url');

    const isValidSignature = verify('RSA-SHA256', signingInput, publicKey, signatureBuffer);
    if (!isValidSignature) {
      throw new AuthenticationError('Invalid JWT cryptographic signature');
    }

    // 5. Decode & parse payload claims
    const claims = this.parseClaims(payloadB64);

    // 6. Validate standard claims
    this.validateClaims(claims);

    // 7. Extract authoritative identity context
    return this.buildIdentityContext(claims);
  }

  private parseHeader(headerB64: string): JwtHeader {
    try {
      const decoded = Buffer.from(headerB64, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Header is not a JSON object');
      }
      if (typeof parsed['alg'] !== 'string') {
        throw new Error("Header missing required 'alg' field");
      }
      return {
        alg: parsed['alg'],
        kid: typeof parsed['kid'] === 'string' ? parsed['kid'] : undefined,
        typ: typeof parsed['typ'] === 'string' ? parsed['typ'] : undefined,
      };
    } catch (err) {
      throw new AuthenticationError(
        `Failed to parse JWT header: ${err instanceof Error ? err.message : 'Invalid JSON'}`,
      );
    }
  }

  private parseClaims(payloadB64: string): JwtClaims {
    try {
      const decoded = Buffer.from(payloadB64, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Payload is not a JSON object');
      }
      return parsed as JwtClaims;
    } catch (err) {
      throw new AuthenticationError(
        `Failed to parse JWT claims: ${err instanceof Error ? err.message : 'Invalid JSON'}`,
      );
    }
  }

  private validateClaims(claims: JwtClaims): void {
    const now = Math.floor(Date.now() / 1000);

    // Check expiration (exp)
    if (claims.exp !== undefined) {
      if (typeof claims.exp !== 'number' || Number.isNaN(claims.exp)) {
        throw new AuthenticationError("Invalid 'exp' claim: must be a number");
      }
      if (now > claims.exp + this.clockSkewSeconds) {
        throw new AuthenticationError('JWT token has expired');
      }
    } else {
      throw new AuthenticationError("JWT token is missing required 'exp' claim");
    }

    // Check not-before (nbf)
    if (claims.nbf !== undefined) {
      if (typeof claims.nbf !== 'number' || Number.isNaN(claims.nbf)) {
        throw new AuthenticationError("Invalid 'nbf' claim: must be a number");
      }
      if (now < claims.nbf - this.clockSkewSeconds) {
        throw new AuthenticationError('JWT token is not active yet (nbf check failed)');
      }
    }

    // Check issuer (iss)
    if (this.issuer !== undefined && this.issuer.length > 0) {
      if (!claims.iss || claims.iss !== this.issuer) {
        throw new AuthenticationError(
          `Invalid JWT issuer: expected '${this.issuer}', received '${claims.iss ?? 'none'}'`,
        );
      }
    }

    // Check audience (aud)
    if (this.audience !== undefined && this.audience.length > 0) {
      const aud = claims.aud;
      let audMatches = false;
      if (typeof aud === 'string') {
        audMatches = aud === this.audience;
      } else if (Array.isArray(aud)) {
        audMatches = aud.includes(this.audience);
      }
      if (!audMatches) {
        throw new AuthenticationError(
          `Invalid JWT audience: expected '${this.audience}', received '${JSON.stringify(claims.aud ?? null)}'`,
        );
      }
    }
  }

  private buildIdentityContext(claims: JwtClaims): IdentityContext {
    // Subject (userId)
    const userId = claims.sub;
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new AuthenticationError("JWT is missing required subject claim ('sub')");
    }

    // Tenant (tenantId)
    const rawTenantId = claims.tenant_id ?? claims.tenantId;
    if (!rawTenantId || typeof rawTenantId !== 'string' || rawTenantId.trim().length === 0) {
      throw new AuthenticationError(
        "JWT is missing required tenant identifier claim ('tenant_id' or 'tenantId')",
      );
    }

    // Roles
    let roles: string[] = [];
    if (Array.isArray(claims.roles)) {
      roles = claims.roles.filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
    } else if (typeof claims.role === 'string' && claims.role.trim().length > 0) {
      roles = [claims.role.trim()];
    }

    // Scopes
    let scopes: string[] = [];
    if (Array.isArray(claims.scopes)) {
      scopes = claims.scopes.filter(
        (s): s is string => typeof s === 'string' && s.trim().length > 0,
      );
    } else if (typeof claims.scope === 'string') {
      scopes = claims.scope
        .split(' ')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }

    // Permissions
    let permissions: string[] = [];
    if (Array.isArray(claims.permissions)) {
      permissions = claims.permissions.filter(
        (p): p is string => typeof p === 'string' && p.trim().length > 0,
      );
    }

    return createIdentityContext({
      userId,
      tenantId: rawTenantId,
      roles,
      scopes,
      permissions,
    });
  }

  private async resolvePublicKey(kid?: string): Promise<KeyObject> {
    // Check if key is already cached
    const cached = this.getKeyFromCache(kid);
    if (cached) {
      return cached;
    }

    // If jwksUri is configured, refresh keys
    if (this.jwksUri) {
      await this.refreshJwksFromUri();
      const afterRefresh = this.getKeyFromCache(kid);
      if (afterRefresh) {
        return afterRefresh;
      }
    }

    throw new AuthenticationError(
      kid
        ? `No matching JWK found for key id ('kid'): '${kid}'`
        : 'No matching JWK found in JWKS key set',
    );
  }

  private getKeyFromCache(kid?: string): KeyObject | null {
    if (kid) {
      const entry = this.cachedKeys.get(kid);
      return entry ? entry.key : null;
    }

    // If no kid was specified and we have exactly 1 key cached, use it
    if (this.cachedKeys.size === 1) {
      const singleKey = this.cachedKeys.values().next().value;
      return singleKey ? singleKey.key : null;
    }

    return null;
  }

  private async refreshJwksFromUri(): Promise<void> {
    if (!this.jwksUri) return;

    const now = Date.now();
    // Throttle fetches: don't re-fetch if cache is fresh within cacheTtlMs and keys exist
    if (now - this.lastJwksFetch < this.cacheTtlMs && this.cachedKeys.size > 0) {
      return;
    }

    try {
      const response = await this.fetchFn(this.jwksUri, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const doc = (await response.json()) as JwksDocument;
      this.loadJwksDocument(doc);
      this.lastJwksFetch = Date.now();
    } catch (err) {
      throw new AuthenticationError(
        `Failed to fetch JWKS from '${this.jwksUri}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  public loadJwksDocument(doc: JwksDocument): void {
    if (!doc || !Array.isArray(doc.keys)) {
      throw new Error("Invalid JWKS document: 'keys' array is required");
    }

    this.cachedKeys.clear();

    for (const jwk of doc.keys) {
      if (jwk.kty !== 'RSA') {
        continue; // Only RSA keys are supported for RS256
      }
      try {
        const keyObject = createPublicKey({
          key: jwk,
          format: 'jwk',
        });

        if (jwk.kid) {
          this.cachedKeys.set(jwk.kid, { key: keyObject, jwk });
        } else {
          this.cachedKeys.set('__default__', { key: keyObject, jwk });
        }
      } catch (_err) {
        // Skip unparseable key or log
      }
    }
  }
}
