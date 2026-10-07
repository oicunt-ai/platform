import crypto, { type KeyObject } from 'node:crypto';
import type { JwkKey, JwksDocument } from '../src/index.js';

export interface TestJwtContext {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly jwk: JwkKey;
  readonly jwks: JwksDocument;
  readonly kid: string;
}

export function createTestJwtContext(kid = 'test-key-1'): TestJwtContext {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  const jwk = publicKey.export({ format: 'jwk' }) as JwkKey;
  const fullJwk: JwkKey = {
    ...jwk,
    kid,
    alg: 'RS256',
    use: 'sig',
  };

  const jwks: JwksDocument = {
    keys: [fullJwk],
  };

  return {
    privateKey,
    publicKey,
    jwk: fullJwk,
    jwks,
    kid,
  };
}

export function signTestJwt(
  payload: Record<string, unknown>,
  privateKey: KeyObject,
  headerOverrides: Record<string, unknown> = {},
): string {
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: 'test-key-1',
    ...headerOverrides,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;

  if (header.alg === 'none') {
    return `${signingInput}.`;
  }

  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  const signatureB64 = signature.toString('base64url');

  return `${signingInput}.${signatureB64}`;
}
