export interface JwtHeader {
  readonly alg: string;
  readonly kid?: string | undefined;
  readonly typ?: string | undefined;
}

export interface JwtClaims {
  readonly sub?: string | undefined;
  readonly iss?: string | undefined;
  readonly aud?: string | readonly string[] | undefined;
  readonly exp?: number | undefined;
  readonly nbf?: number | undefined;
  readonly iat?: number | undefined;
  readonly jti?: string | undefined;
  readonly tenant_id?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly roles?: readonly string[] | undefined;
  readonly role?: string | undefined;
  readonly scope?: string | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly permissions?: readonly string[] | undefined;
  readonly [key: string]: unknown;
}

export interface JwkKey {
  readonly kty: string;
  readonly use?: string | undefined;
  readonly alg?: string | undefined;
  readonly kid?: string | undefined;
  readonly n?: string | undefined;
  readonly e?: string | undefined;
  readonly [key: string]: unknown;
}

export interface JwksDocument {
  readonly keys: readonly JwkKey[];
}
