import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * One request-scoped store. Carries the correlation ID end-to-end:
 * web → API → Temporal → worker. Never read `process.env` here.
 */
export type RequestContext = {
  correlationId: string;
  // Populated by auth guard once Phase 1 lands. Pre-declared so the
  // shape does not churn when auth arrives.
  userId?: string;
  organizationId?: string;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export const currentCorrelationId = (): string | undefined =>
  requestContext.getStore()?.correlationId;
