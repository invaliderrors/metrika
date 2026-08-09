import { z } from 'zod';

/**
 * The closed set of domain failures. Mapped to HTTP status codes at exactly
 * one boundary (the API's exception filter) — a known domain failure must
 * never surface as a generic 500. Closed deliberately: this is not meant to
 * be extended casually, since every new code needs a home in that mapping
 * and, usually, a specific UI treatment.
 */
export const DomainErrorCode = z.enum([
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'INSUFFICIENT_PERMISSIONS',
  'MODEL_NOT_FOUND',
  'MODEL_NOT_READY',
  'MODEL_NOT_PRINTABLE',
  'MODEL_TOO_COMPLEX',
  'UNSUPPORTED_FILE_FORMAT',
  'FILE_TOO_LARGE',
  'CHECKSUM_MISMATCH',
  'MALICIOUS_ARCHIVE',
  'UNITS_NOT_CONFIRMED',
  'IMPLAUSIBLE_SCALE',
  'GEOMETRY_ANALYSIS_FAILED',
  'INVALID_PRINT_CONFIGURATION',
  'DOES_NOT_FIT_BUILD_VOLUME',
  'SLICING_FAILED',
  'QUOTE_NOT_FOUND',
  'QUOTE_EXPIRED',
  'QUOTE_SUPERSEDED',
  'ORDER_NOT_FOUND',
  'INVALID_STATE_TRANSITION',
  'PAYMENT_VERIFICATION_FAILED',
  'IDEMPOTENCY_KEY_REUSED',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'INTERNAL_ERROR',
]);
export type DomainErrorCode = z.infer<typeof DomainErrorCode>;
