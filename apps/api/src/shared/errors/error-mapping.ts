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
 * The code to report for a rejection the FRAMEWORK made — an unmatched route, a
 * guard, a body over the configured limit, a content type Fastify will not parse
 * — where there is no `DomainError` to read a code from.
 *
 * The response keeps the framework's own status; this table decides only the
 * code. Every row must therefore name a code `DOMAIN_ERROR_RESPONSE` pins to
 * that SAME status, so that the pair on the wire cannot contradict the published
 * contract table. `error-mapping.test.ts` asserts that, because nothing in the
 * type system does — the key is a `number` and the value a `DomainErrorCode`,
 * and TypeScript will happily pair 404 with a code mapped to 400.
 *
 * A 4xx absent from this table gets {@link FRAMEWORK_FALLBACK_CODE} at its own
 * status, so `VALIDATION_FAILED` is the one code that may appear at any 4xx. See
 * `frameworkErrorResponse` for why that is the honest reading and what the
 * alternative measured.
 *
 * Two independent tests pin this table, on purpose: one asserts the exact set of
 * rows longhand, and one drives each row over HTTP from a hardcoded list.
 * Deleting a row is otherwise invisible — MEASURED, removing `413` left unit and
 * integration green while a 2 MB body silently moved from `413 FILE_TOO_LARGE`
 * to `400 VALIDATION_FAILED` — because a test that iterates the table cannot see
 * a row that is not there.
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

/**
 * Used when {@link FRAMEWORK_ERROR_CODE} has no row for a 4xx status. It travels
 * at that status, NOT at the 400 the map pins it to — the framework rejected the
 * request before the domain saw it, so the status is the fact and the code is
 * only a label.
 */
export const FRAMEWORK_FALLBACK_CODE = 'VALIDATION_FAILED' satisfies DomainErrorCode;
