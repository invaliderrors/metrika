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
 * Never throws and never returns undefined. The exception filter calls this
 * while already handling a failure; a logging helper that can itself fail on
 * the error path turns a handled 422 into an unhandled crash.
 */
export function getRequestId(): string {
  return storage.getStore()?.requestId ?? 'unknown';
}

/**
 * A client MAY supply X-Request-Id, so it is untrusted input that ends up in
 * logs and in error bodies. Anything outside this narrow character class is
 * replaced rather than sanitised: a newline in a log line is a forged log
 * entry, and truncating an over-long value would let a client collide with
 * somebody else's prefix.
 */
const ACCEPTABLE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function normaliseRequestId(header: unknown): string {
  if (typeof header === 'string' && ACCEPTABLE_REQUEST_ID.test(header)) {
    return header;
  }
  return randomUUID();
}
