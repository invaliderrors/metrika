/**
 * The origin of the correlation chain `docs/OBSERVABILITY.md` §2 describes.
 *
 * ```
 * Browser generates X-Request-Id
 *    → API: adopts or generates it; starts the root span; binds to AsyncLocalStorage
 *    → … → API error response: { error: { requestId } }
 * ```
 *
 * The browser end is the only one that can make a support ticket resolvable to
 * a trace, because it is the only place that sees a user's whole visit. Every
 * other participant in the chain either adopts what it is given or invents a
 * value nobody can quote back.
 */

/**
 * Lower case, matching `apps/api`'s `REQUEST_ID_HEADER` exactly.
 *
 * Not a style choice, and not asserted by eye either: `test/request-id.test.ts`
 * reads the API's own module and requires the two constants to be equal, so a
 * rename on that side turns into a red test on this one rather than a silently
 * unread header. Header names are case-insensitive on the wire, so the casing
 * is cosmetic to HTTP — what is NOT cosmetic is that `apps/api` reads
 * `request.headers['x-request-id']` off Node's already-lower-cased header map,
 * where a mismatched *name* means the value is simply not there.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * 16 random bytes, hex-encoded.
 *
 * The format is a contract with `normaliseRequestId` in `apps/api`, which
 * accepts `[A-Za-z0-9._-]{1,128}` and REPLACES anything else with a UUID of its
 * own. A replacement is the failure that matters here: it exits 0, returns a
 * perfectly good response, and quietly breaks the one property this function
 * exists for — the ID in the browser's network tab is then not the ID in the
 * log. 32 hex characters cannot fail that check.
 *
 * It also cannot be the `NO_REQUEST_ID` sentinel (`unknown`), which the API
 * rejects case-insensitively so that "the client sent this" and "there was no
 * request context at all" stay distinguishable in a log search. Hex has no
 * letters past `f`; `unknown` has four.
 *
 * `crypto.getRandomValues` rather than `crypto.randomUUID`: `randomUUID` is
 * restricted to secure contexts, so it is `undefined` on a plain-HTTP origin —
 * a LAN address or a preview host without TLS — and the failure would be a
 * TypeError thrown from inside the fetch path rather than a degraded ID.
 * `getRandomValues` is available in both. `Math.random` is not an option: this
 * value goes in a log a support agent quotes, and colliding IDs make the log
 * lie rather than merely lose precision.
 */
export function newRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The current navigation's ID, held in module scope — IN THE BROWSER ONLY, and
 * that qualification is the whole of the design.
 *
 * A module-scope value on the Node side is shared by every concurrent request
 * the server is handling, so a server-rendered page that reused one would
 * stamp two unrelated visitors' API calls with the same correlation ID. That is
 * worse than having none: it makes a log search return somebody else's request.
 * Hence the `typeof window` branch below, which is a correctness boundary and
 * not an SSR-safety incantation.
 */
let browserRequestId: string | undefined;

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/**
 * The ID to stamp on the next outbound API call.
 *
 * In the browser this is stable for the whole navigation, which is what makes
 * several calls from one page share an identity. On the server every call gets
 * a fresh one — see above; the alternative is cross-request contamination, and
 * a correlated pair of server calls is not worth that. When `apps/web` grows a
 * server-side data path it will need a request-scoped store (React `cache()` or
 * `AsyncLocalStorage`) to do better, which is a decision for the task that adds
 * one rather than a hook to leave dangling here.
 */
export function currentRequestId(): string {
  if (!isBrowser()) return newRequestId();
  browserRequestId ??= newRequestId();
  return browserRequestId;
}

/**
 * Starts a new correlation identity. Called from `NavigationRequestId` on every
 * client-side route change.
 *
 * A no-op on the server, for the reason above: there is no navigation to scope
 * to, and mutating module state per render is precisely the contamination the
 * branch exists to prevent.
 */
export function beginNavigation(): void {
  if (!isBrowser()) return;
  browserRequestId = newRequestId();
}
