import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyInternalServiceToken(
  token: string,
  secret: string,
): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart || !signaturePart) return null;
  try {
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString()) as { alg?: string };
    if (header.alg !== 'HS256') return null;
    const expected = createHmac('sha256', secret)
      .update(`${headerPart}.${payloadPart}`)
      .digest('base64url');
    const actualBuffer = Buffer.from(signaturePart);
    const expectedBuffer = Buffer.from(expected);
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    )
      return null;
    const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    if (claims['aud'] !== 'platform-usage' || claims['sub'] !== 'api-gateway') return null;
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof claims['iss'] !== 'string' ||
      typeof claims['jti'] !== 'string' ||
      typeof claims['iat'] !== 'number' ||
      claims['iat'] > now + 5 ||
      typeof claims['exp'] !== 'number' ||
      claims['exp'] < now - 5
    )
      return null;
    return claims;
  } catch {
    return null;
  }
}
