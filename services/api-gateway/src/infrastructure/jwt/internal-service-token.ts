import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface InternalServiceTokenClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly exp: number;
  readonly iat: number;
  readonly jti: string;
  readonly tenantId?: string | undefined;
  readonly userId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly [key: string]: unknown;
}

export interface CreateInternalServiceTokenParams {
  readonly issuer?: string | undefined;
  readonly serviceName?: string | undefined;
  readonly subject?: string | undefined;
  readonly audience: string;
  readonly secret: string;
  readonly expiresInSeconds?: number | undefined;
  readonly tenantId?: string | undefined;
  readonly userId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly correlationId?: string | undefined;
}

export interface VerifyInternalServiceTokenOptions {
  readonly secret: string;
  readonly expectedAudience?: string | undefined;
  readonly allowedServiceIdentities?: readonly string[] | undefined;
  readonly clockSkewSeconds?: number | undefined;
}

export type TokenVerificationResult =
  | {
      readonly success: true;
      readonly claims: InternalServiceTokenClaims;
      readonly serviceName: string;
    }
  | {
      readonly success: false;
      readonly statusCode: 401 | 403;
      readonly errorCode: string;
      readonly message: string;
    };

/**
 * Mints a short-lived HMAC-SHA256 signed internal service JWT.
 */
export function createInternalServiceToken(params: CreateInternalServiceTokenParams): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (params.expiresInSeconds ?? 300);
  const header = { alg: 'HS256', typ: 'JWT' };
  const identity = params.serviceName ?? params.issuer ?? 'unknown';
  const payload: InternalServiceTokenClaims = {
    iss: params.issuer ?? identity,
    sub: params.subject ?? params.serviceName ?? identity,
    aud: params.audience,
    iat: now,
    exp,
    jti: randomUUID(),
    tenantId: params.tenantId,
    userId: params.userId,
    requestId: params.requestId,
    correlationId: params.correlationId,
  };

  const headerB64 = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', params.secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  return `${headerB64}.${payloadB64}.${signature}`;
}

/**
 * Validates an internal service token against the shared secret, audience, and calling service identity.
 */
export function verifyInternalServiceToken(
  token: string,
  options: VerifyInternalServiceTokenOptions,
): TokenVerificationResult {
  if (!token || typeof token !== 'string') {
    return {
      success: false,
      statusCode: 401,
      errorCode: 'AUTHENTICATION_ERROR',
      message: 'Missing or empty internal service token',
    };
  }

  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    return {
      success: false,
      statusCode: 401,
      errorCode: 'AUTHENTICATION_ERROR',
      message: 'Invalid internal service token format',
    };
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) {
    return {
      success: false,
      statusCode: 401,
      errorCode: 'AUTHENTICATION_ERROR',
      message: 'Invalid internal service token format',
    };
  }

  let header: { alg?: string; typ?: string };
  let payload: InternalServiceTokenClaims;

  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return {
      success: false,
      statusCode: 401,
      errorCode: 'AUTHENTICATION_ERROR',
      message: 'Malformed internal service token payload',
    };
  }

  if (header.alg !== 'HS256') {
    return {
      success: false,
      statusCode: 401,
      errorCode: 'AUTHENTICATION_ERROR',
      message: `Unsupported token algorithm: expected HS256, got ${header.alg}`,
    };
  }

  const expectedSignature = createHmac('sha256', options.secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  const sigBuffer = Buffer.from(signatureB64, 'utf8');
  const expBuffer = Buffer.from(expectedSignature, 'utf8');

  if (sigBuffer.length !== expBuffer.length || !timingSafeEqual(sigBuffer, expBuffer)) {
    return {
      success: false,
      statusCode: 401,
      errorCode: 'AUTHENTICATION_ERROR',
      message: 'Invalid internal service token signature',
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const clockSkew = options.clockSkewSeconds ?? 5;

  if (typeof payload.exp !== 'number' || payload.exp < now - clockSkew) {
    return {
      success: false,
      statusCode: 401,
      errorCode: 'AUTHENTICATION_ERROR',
      message: 'Expired internal service token',
    };
  }

  if (options.expectedAudience && payload.aud !== options.expectedAudience) {
    return {
      success: false,
      statusCode: 403,
      errorCode: 'FORBIDDEN',
      message: `Invalid token audience: expected '${options.expectedAudience}', got '${payload.aud}'`,
    };
  }

  const serviceName = payload.sub || payload.iss;
  if (!serviceName) {
    return {
      success: false,
      statusCode: 403,
      errorCode: 'FORBIDDEN',
      message: 'Token does not contain a valid service identity subject',
    };
  }

  if (
    options.allowedServiceIdentities &&
    options.allowedServiceIdentities.length > 0 &&
    !options.allowedServiceIdentities.includes(serviceName)
  ) {
    return {
      success: false,
      statusCode: 403,
      errorCode: 'FORBIDDEN',
      message: `Service '${serviceName}' is not authorized to invoke this service`,
    };
  }

  return {
    success: true,
    claims: payload,
    serviceName,
  };
}
