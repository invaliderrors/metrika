import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * What {@link getRequestId} reports when there is no request context at all.
 *
 * This value ends up in error bodies, so it has to mean exactly one thing.
 * `normaliseRequestId` therefore refuses to hand it back to a client: it is
 * inside the acceptable character class, so without that refusal a client
 * could send `X-Request-Id: unknown` and make its own requests indistinguishable
 * from ones where no context was established — two conditions that need very
 * different responses from whoever is reading the log.
 */
export const NO_REQUEST_ID = 'unknown';

/**
 * Never throws and never returns undefined. The exception filter calls this
 * while already handling a failure; a logging helper that can itself fail on
 * the error path turns a handled 422 into an unhandled crash.
 */
export function getRequestId(): string {
  return storage.getStore()?.requestId ?? NO_REQUEST_ID;
}

/**
 * A client MAY supply X-Request-Id, so it is untrusted input that ends up in
 * logs and in error bodies. Anything outside this narrow character class is
 * replaced rather than sanitised: a newline in a log line is a forged log
 * entry, and truncating an over-long value would let a client collide with
 * somebody else's prefix.
 */
const ACCEPTABLE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Compared case-insensitively. A log search for the sentinel is not
 * case-sensitive, so `Unknown` in an error body is exactly as misleading as
 * `unknown`; a client that wanted either as its correlation id gets a UUID.
 *
 * Rejecting the literal is the mechanism rather than moving the sentinel
 * outside the character class, because `NO_REQUEST_ID` is a published value
 * that Task 11 puts in error bodies. Note that a sentinel merely *prefixed*
 * with `-` would not work: `-` is inside the class, so `-unknown` is just as
 * forgeable as `unknown`.
 */
const FORGED_SENTINEL = NO_REQUEST_ID.toLowerCase();

export function normaliseRequestId(header: unknown): string {
  if (
    typeof header === 'string' &&
    ACCEPTABLE_REQUEST_ID.test(header) &&
    header.toLowerCase() !== FORGED_SENTINEL
  ) {
    return header;
  }
  return randomUUID();
}
