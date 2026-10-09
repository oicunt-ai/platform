import type { PublicAiErrorCode } from '@oicunt/contracts';

const messages: Record<PublicAiErrorCode, string> = {
  VALIDATION_ERROR: 'The request is invalid.',
  AUTHENTICATION_ERROR: 'Authentication is required.',
  FORBIDDEN: 'Access to this operation is not permitted.',
  RATE_LIMITED: 'The request rate limit has been reached.',
  CONCURRENCY_LIMITED: 'The active stream limit has been reached.',
  MODEL_UNAVAILABLE: 'The selected model is unavailable.',
  PROVIDER_UNAVAILABLE: 'The model provider is temporarily unavailable.',
  TIMEOUT: 'The request deadline was exceeded.',
  CANCELLED: 'The request was cancelled.',
  PERSISTENCE_FAILURE: 'The conversation could not be persisted.',
  INTERNAL_ERROR: 'An internal error occurred.',
};

export function normalizePublicAiError(statusCode: number, body: unknown): unknown {
  const upstreamCode = extractUpstreamCode(body);
  let code: PublicAiErrorCode;
  if (statusCode === 400 || statusCode === 404 || statusCode === 409) code = 'VALIDATION_ERROR';
  else if (statusCode === 401) code = 'AUTHENTICATION_ERROR';
  else if (statusCode === 403) code = 'FORBIDDEN';
  else if (statusCode === 429) {
    code =
      upstreamCode.includes('CONCURRENCY') || upstreamCode.includes('QUOTA')
        ? 'CONCURRENCY_LIMITED'
        : 'RATE_LIMITED';
  } else if (statusCode === 499 || upstreamCode.includes('CANCEL')) code = 'CANCELLED';
  else if (statusCode === 504 || upstreamCode.includes('TIMEOUT')) code = 'TIMEOUT';
  else if (upstreamCode.includes('MEMORY') || upstreamCode.includes('PERSIST')) {
    code = 'PERSISTENCE_FAILURE';
  } else if (upstreamCode.includes('MODEL') || upstreamCode.includes('TARGET')) {
    code = 'MODEL_UNAVAILABLE';
  } else if (statusCode === 502 || statusCode === 503 || upstreamCode.includes('PROVIDER')) {
    code = 'PROVIDER_UNAVAILABLE';
  } else code = 'INTERNAL_ERROR';

  return { success: false, error: { code, message: messages[code] } };
}

function extractUpstreamCode(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const error = (body as Record<string, unknown>)['error'];
  if (!error || typeof error !== 'object' || Array.isArray(error)) return '';
  const code = (error as Record<string, unknown>)['code'];
  return typeof code === 'string' ? code.toUpperCase() : '';
}
