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
  ROUTE_NOT_FOUND: { status: 404, retryable: false },
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

/**
 * The code to report for an `HttpException` the FRAMEWORK threw — an unmatched
 * route, a guard rejecting a request, a body over the configured limit — where
 * there is no `DomainError` to read a code from.
 *
 * Keyed by status, and every entry must name a code the table above pins to that
 * SAME status, so that choosing a code and choosing a status are one decision
 * rather than two that can drift. `error-mapping.test.ts` asserts exactly that,
 * because nothing in the type system does.
 *
 * A 4xx status absent from this table falls back to `VALIDATION_FAILED`, which
 * means the response goes out at 400 rather than at the framework's status: a
 * 415 is reported as "your request was rejected" instead of the more precise
 * "unsupported media type". That imprecision is deliberate and is the cheaper
 * side of the trade — the alternative is shipping a code at a status the
 * published contract table pins elsewhere, which is what this whole arrangement
 * exists to prevent. Add a row here when a status starts mattering enough to be
 * distinguished, and give it a code whose mapped status agrees.
 *
 * 5xx is deliberately absent: it never reaches this table. See the filter.
 */
export const FRAMEWORK_ERROR_CODE: Readonly<Record<number, DomainErrorCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'INSUFFICIENT_PERMISSIONS',
  404: 'ROUTE_NOT_FOUND',
  413: 'FILE_TOO_LARGE',
  429: 'RATE_LIMITED',
};

/** Used when {@link FRAMEWORK_ERROR_CODE} has no row for a 4xx status. */
export const FRAMEWORK_FALLBACK_CODE = 'VALIDATION_FAILED' satisfies DomainErrorCode;
