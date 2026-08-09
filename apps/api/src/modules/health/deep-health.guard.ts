// `type CanActivate` and `type ExecutionContext`: both are interfaces, and
// `verbatimModuleSyntax` is true in base.json and stays true in nest.json, so a
// value import of either is `error TS1484: '…' is a type and must be imported
// using a type-only import`. `Injectable` is a real value (the decorator) and
// must NOT be type-imported. Nothing here is injected by type, so this is not
// the DI footgun — the guard's own `EnvService` parameter is a value import.
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../../shared/errors/domain-error.js';
import { EnvService } from '../../config/env.service.js';

/**
 * The scheme is matched case-INSENSITIVELY: RFC 9110 §11.1 makes the auth-scheme
 * token case-insensitive, so `bearer <token>` is a conformant request and a
 * `startsWith('Bearer ')` check answers 401 to a client that did nothing wrong.
 * `toLowerCase()` and not `toLocaleLowerCase()` — the latter is locale-dependent
 * and would fold `I` differently under a Turkish locale.
 *
 * Only the SCHEME is compared this way. The token comparison below stays
 * byte-exact and constant-time.
 */
const BEARER = 'Bearer ';
const BEARER_LOWER = BEARER.toLowerCase();

/**
 * RFC 9110 §11.6.1 requires a 401 to carry `WWW-Authenticate`. It names the
 * scheme the client should retry with and reveals nothing — no realm, because a
 * realm here would be a name for internal topology on the one endpoint whose
 * entire purpose is to describe internal topology.
 */
const CHALLENGE_HEADER = 'WWW-Authenticate';
const CHALLENGE = 'Bearer';

/**
 * SHA-256 of the presented and expected tokens, compared with
 * `timingSafeEqual`, rather than the two raw buffers.
 *
 * `timingSafeEqual` THROWS on unequal lengths, so a raw-buffer comparison has to
 * be guarded by `presented.length !== expected.length || …` — and that guard is
 * an early return whose cost depends on the presented length, which is exactly
 * the timing signal the constant-time compare exists to remove. Digesting first
 * makes both operands unconditionally 32 bytes, so there is no length branch
 * left to leak and no input length that can make `timingSafeEqual` throw out of
 * a guard. The extra hash is ~1µs against a route that then runs a database
 * round trip.
 *
 * A digest comparison is not weaker than comparing the tokens: SHA-256 equality
 * of two byte strings implies equality of the strings for any input an attacker
 * can construct.
 */
function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(presented, 'utf8').digest(),
    createHash('sha256').update(expected, 'utf8').digest(),
  );
}

/**
 * /health/deep reports internal topology and per-dependency latency, so it is
 * authenticated. A shared secret is the control until Phase 1 replaces it with
 * the Clerk guard — and it is a real control, with a fixture asserting the 401
 * rather than a comment asserting the intent.
 *
 * It throws `DomainError`, NOT `UnauthorizedException`, and the difference is
 * visible on the wire. `DomainExceptionFilter` forwards a framework 4xx's
 * `message` verbatim in whatever language Nest or Fastify wrote it — MEASURED
 * before this guard existed, `GET /health/deep` answered
 * `"message": "Cannot GET /health/deep"` — while `ApiErrorResponse` documents
 * `message` as localised and safe to display. A `DomainError` takes the filter's
 * `isDomainError` branch instead, which carries the message written here. This
 * is the first 401 in the app a real user can hit, so it is the first place that
 * distinction has consequences; `test/health.integration.test.ts` pins both
 * strings so a later `throw new UnauthorizedException()` cannot quietly put
 * `Unauthorized` in a user-facing field.
 */
@Injectable()
export class DeepHealthGuard implements CanActivate {
  constructor(private readonly config: EnvService) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const header = http.getRequest<FastifyRequest>().headers.authorization;

    /**
     * The challenge is written on the reply and then the DomainError is thrown.
     * Fastify keeps headers written on a reply, and `DomainExceptionFilter`
     * answers on that SAME reply object rather than constructing a new one, so
     * the header survives the throw — pinned by a fixture, because "the filter
     * answers on the same reply" is somebody else's implementation detail.
     *
     * Written only on the failure paths, so a successful probe does not carry a
     * challenge it is not making.
     */
    const reject = (message: string): never => {
      http.getResponse<FastifyReply>().header(CHALLENGE_HEADER, CHALLENGE);
      throw new DomainError('UNAUTHENTICATED', message);
    };

    if (
      typeof header !== 'string' ||
      header.slice(0, BEARER.length).toLowerCase() !== BEARER_LOWER
    ) {
      return reject('Credenciales requeridas.');
    }

    if (!tokenMatches(header.slice(BEARER.length), this.config.values.HEALTH_DEEP_TOKEN)) {
      return reject('Credenciales inválidas.');
    }

    return true;
  }
}
