import type { DomainErrorCode } from '@metrika/contracts';

/**
 * A failure the domain understands. Anything thrown that is not one of these
 * becomes INTERNAL_ERROR at the boundary — a generic 500 for a condition the
 * domain does understand is a bug: it tells the client nothing and hides a
 * real state from monitoring.
 */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
