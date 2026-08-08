/**
 * Every domain error carries one of these codes. Transport layers map codes to
 * HTTP statuses; nothing inside the domain knows about HTTP.
 */
export const DomainErrorCode = {
  // Generic
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  FORBIDDEN: 'FORBIDDEN',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INTERNAL: 'INTERNAL',

  // Uploads / models
  UPLOAD_SESSION_EXPIRED: 'UPLOAD_SESSION_EXPIRED',
  UPLOAD_CHECKSUM_MISMATCH: 'UPLOAD_CHECKSUM_MISMATCH',
  UPLOAD_SIZE_MISMATCH: 'UPLOAD_SIZE_MISMATCH',
  UNSUPPORTED_FILE_FORMAT: 'UNSUPPORTED_FILE_FORMAT',

  // Geometry
  GEOMETRY_HOSTILE_INPUT: 'GEOMETRY_HOSTILE_INPUT',
  GEOMETRY_NOT_WATERTIGHT: 'GEOMETRY_NOT_WATERTIGHT',
  GEOMETRY_TRIANGLE_LIMIT_EXCEEDED: 'GEOMETRY_TRIANGLE_LIMIT_EXCEEDED',
  UNITS_AMBIGUOUS: 'UNITS_AMBIGUOUS',

  // Pricing / quotes
  PRICING_RULE_SET_INVALID: 'PRICING_RULE_SET_INVALID',
  QUOTE_EXPIRED: 'QUOTE_EXPIRED',
  QUOTE_NOT_ACCEPTABLE: 'QUOTE_NOT_ACCEPTABLE',

  // Payments
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',

  // State machines
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
} as const;
export type DomainErrorCode = (typeof DomainErrorCode)[keyof typeof DomainErrorCode];

export type DomainError = {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly detail?: unknown;
};

export const domainError = (
  code: DomainErrorCode,
  message: string,
  detail?: unknown,
): DomainError => ({ code, message, ...(detail !== undefined && { detail }) });

export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled case in ${context}: ${JSON.stringify(value)}`);
}
