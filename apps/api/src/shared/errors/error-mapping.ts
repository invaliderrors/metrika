import type { DomainErrorCode } from '@metrika/contracts';

export interface DomainErrorResponse {
  readonly status: number;
  /** Whether an identical retry could plausibly succeed. Drives client backoff. */
  readonly retryable: boolean;
}

/**
 * `Record<DomainErrorCode, …>` rather than a partial map, deliberately: adding
 * a code to the union without adding it here is a COMPILE error, not a runtime
 * surprise on the one request that hits it. The table is
 * docs/CONTRACTS_AND_API.md's, with the codes that table omits filled in on the
 * same principle — a rejected input is 400, a state the domain understands but
 * will not act on is 422, an upstream compute failure is 502.
 */
export const DOMAIN_ERROR_RESPONSE: Readonly<Record<DomainErrorCode, DomainErrorResponse>> = {
  VALIDATION_FAILED: { status: 400, retryable: false },
  UNAUTHENTICATED: { status: 401, retryable: false },
  INSUFFICIENT_PERMISSIONS: { status: 403, retryable: false },
  MODEL_NOT_FOUND: { status: 404, retryable: false },
  MODEL_NOT_READY: { status: 422, retryable: false },
  MODEL_NOT_PRINTABLE: { status: 422, retryable: false },
  MODEL_TOO_COMPLEX: { status: 413, retryable: false },
  UNSUPPORTED_FILE_FORMAT: { status: 400, retryable: false },
  FILE_TOO_LARGE: { status: 413, retryable: false },
  CHECKSUM_MISMATCH: { status: 400, retryable: false },
  MALICIOUS_ARCHIVE: { status: 400, retryable: false },
  UNITS_NOT_CONFIRMED: { status: 422, retryable: false },
  IMPLAUSIBLE_SCALE: { status: 422, retryable: false },
  GEOMETRY_ANALYSIS_FAILED: { status: 502, retryable: true },
  INVALID_PRINT_CONFIGURATION: { status: 400, retryable: false },
  DOES_NOT_FIT_BUILD_VOLUME: { status: 422, retryable: false },
  SLICING_FAILED: { status: 502, retryable: true },
  QUOTE_NOT_FOUND: { status: 404, retryable: false },
  QUOTE_EXPIRED: { status: 410, retryable: false },
  QUOTE_SUPERSEDED: { status: 409, retryable: false },
  ORDER_NOT_FOUND: { status: 404, retryable: false },
  INVALID_STATE_TRANSITION: { status: 409, retryable: false },
  PAYMENT_VERIFICATION_FAILED: { status: 502, retryable: true },
  IDEMPOTENCY_KEY_REUSED: { status: 409, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  QUOTA_EXCEEDED: { status: 429, retryable: true },
  INTERNAL_ERROR: { status: 500, retryable: false },
};
