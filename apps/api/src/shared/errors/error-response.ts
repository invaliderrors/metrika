import type { DomainErrorCode } from '@metrika/contracts';
import {
  DOMAIN_ERROR_RESPONSE,
  FRAMEWORK_ERROR_CODE,
  FRAMEWORK_FALLBACK_CODE,
} from './error-mapping.js';

export interface ErrorEnvelope {
  readonly error: {
    /**
     * `DomainErrorCode`, not `string`. Typing it loosely is what let this API
     * ship `VALIDATION_FAILED` at 404, 500 and 503 while the mapping table
     * pinned it at 400 — a response that contradicted the published contract and
     * that no test over the MAP could ever have caught.
     */
    readonly code: DomainErrorCode;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly requestId: string;
    readonly retryable: boolean;
  };
}

export interface ErrorResponse {
  readonly status: number;
  readonly body: ErrorEnvelope;
}

/** Localised and fixed. Never derived from the exception. */
export const INTERNAL_ERROR_MESSAGE = 'Ha ocurrido un error inesperado.';

function envelope(
  code: DomainErrorCode,
  message: string,
  requestId: string,
  retryable: boolean,
  details?: Readonly<Record<string, unknown>>,
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      ...(details !== undefined && { details }),
      requestId,
      retryable,
    },
  };
}

/**
 * A failure THE DOMAIN decided: status and `retryable` both come from
 * `DOMAIN_ERROR_RESPONSE`, because the code is the fact and the status is its
 * published consequence.
 *
 * Writing `retryable` by hand next to a lookup of `status` — which two branches
 * of the filter used to do — makes the wire silently disagree with the table the
 * moment the table changes, and the disagreement is invisible to any test that
 * only reads the table. There is deliberately no parameter here for either.
 */
export function domainErrorResponse(
  code: DomainErrorCode,
  message: string,
  requestId: string,
  details?: Readonly<Record<string, unknown>>,
): ErrorResponse {
  const { status, retryable } = DOMAIN_ERROR_RESPONSE[code];
  return { status, body: envelope(code, message, requestId, retryable, details) };
}

/**
 * A rejection THE FRAMEWORK decided — an unmatched route, a guard, a body over
 * the limit, a content type Fastify will not parse. Here the STATUS is the fact
 * and we choose only a code to describe it.
 *
 * This is why the status is not read from the map. MEASURED when it was: a
 * thrown 415 arrived as 400, and so did 409, 422 and 405 — two of which are
 * statuses this API's own contract table uses heavily, and the 415 needs no
 * application code at all (`POST` with `content-type: application/x-tar` and
 * Fastify raises it). When the first upload endpoint lands, 413 and 415 are
 * precisely the two statuses a client branches on.
 *
 * The consequence is that {@link FRAMEWORK_FALLBACK_CODE} — `VALIDATION_FAILED`
 * — may appear at ANY 4xx, which is the one sanctioned departure from "a code
 * implies its mapped status". It is honest: at that point the framework rejected
 * the request and the domain never saw it. Codes chosen from
 * {@link FRAMEWORK_ERROR_CODE} do agree with the map, and a test asserts it.
 */
export function frameworkErrorResponse(
  status: number,
  message: string,
  requestId: string,
): ErrorResponse {
  const code = FRAMEWORK_ERROR_CODE[status] ?? FRAMEWORK_FALLBACK_CODE;
  const { retryable } = DOMAIN_ERROR_RESPONSE[code];
  return { status, body: envelope(code, message, requestId, retryable) };
}

/** The generic 500. Carries nothing derived from whatever went wrong. */
export function internalErrorResponse(requestId: string): ErrorResponse {
  return domainErrorResponse('INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE, requestId);
}
