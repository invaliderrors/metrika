import { clientEnv } from '../../config/env';
import { REQUEST_ID_HEADER, currentRequestId } from '../request-id/request-id';

/**
 * The one way `apps/web` talks to the API, and therefore the one place the
 * correlation header is attached.
 *
 * This is a header wrapper, not a data layer. TanStack Query, the generated
 * client and every feature's hooks arrive in later phases and are expected to
 * call THIS rather than `fetch` — the whole value of a request ID is that no
 * call escapes it, and a second call site that reaches for the global `fetch`
 * is a request nobody can find in a log.
 */

/**
 * Trailing slashes stripped once, at module scope, so `apiUrl('/quotes')`
 * cannot produce `//quotes` for a base URL that happens to end in one.
 */
const API_BASE = clientEnv.NEXT_PUBLIC_API_BASE_URL.replace(/\/+$/, '');

/**
 * The two shapes rejected here are both a request ID leaving our own origin,
 * and neither is theoretical:
 *
 *   - `//evil.example/x` is a PROTOCOL-RELATIVE URL. It starts with `/`, so a
 *     `startsWith('/')` check passes it, and `new URL('//evil.example/x',
 *     'http://localhost:3001')` resolves to `http://evil.example/x` — a
 *     different origin, reached through a string that looks like a path.
 *   - `/\evil.example/x` is the same attack spelled with a backslash. WHATWG
 *     URL parsing normalises `\` to `/` for http(s), so this is
 *     `//evil.example/x` by the time anything resolves it. A `//` check alone
 *     does not see it.
 *
 * Concatenation rather than `new URL(path, API_BASE)` is the second half of the
 * defence, and it also preserves a base URL carrying a path prefix
 * (`https://api.example.com/v1`), which `new URL` would discard.
 *
 * **WHAT THIS DOES NOT COVER, stated because the obvious reading is wrong:** it
 * constrains the origin of the REQUEST THIS FUNCTION MAKES, and nothing else.
 * `fetch` follows redirects by default, and a cross-origin redirect strips only
 * `Authorization`, `Cookie` and `Proxy-Authorization` — a custom header such as
 * `X-Request-Id` survives it. So a compromised or misconfigured API answering
 * `302` to another origin would carry the correlation ID there regardless of
 * this check. `apiFetch` closes that half with `redirect: 'error'`; the guard
 * here is not sufficient on its own and never was.
 */
export function apiUrl(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) {
    throw new Error(
      `apiFetch takes a root-relative path on the API's own origin, not ${JSON.stringify(path)}. ` +
        'A protocol-relative or absolute URL would send the request id to somebody else.',
    );
  }
  return `${API_BASE}${path}`;
}

/**
 * `fetch`, with this navigation's correlation ID on it.
 *
 * **The header is SET, never merged, and a caller cannot influence it.** That
 * is the control, and it is worth being explicit about what it closes:
 * `Headers.set` is case-insensitive, so a caller passing `X-Request-Id`,
 * `x-request-id` or `X-REQUEST-ID` in any of `HeadersInit`'s three shapes has
 * its value replaced rather than appended. Without that, a caller could send
 * `unknown` — `apps/api`'s `NO_REQUEST_ID` sentinel — and make its own requests
 * indistinguishable in the log from requests where no context existed at all.
 * The API rejects the sentinel on its side too; this is the other half, and
 * `test/request-id.test.ts` asserts the ABSENCE of the forged value on the
 * wire rather than merely the presence of ours.
 *
 * `headers` is placed after the `...init` spread for the same reason. Before
 * it, a caller's `headers` key would overwrite the whole object and the header
 * would silently vanish.
 *
 * **`redirect: 'error'` is the other half of `apiUrl`'s origin guard.** Following
 * a redirect is a legitimate thing for some future endpoint to need; doing it by
 * accident is not, because a cross-origin redirect carries `X-Request-Id` — and
 * every header this wrapper grows later — to whatever answered. A caller that
 * needs to follow one writes `redirect: 'follow'` and the decision is visible in
 * review.
 *
 * Destructured with a DEFAULT rather than written before the `...init` spread,
 * and the difference is a real hole rather than a style question: with
 * `{ redirect: 'error', ...init }`, a caller passing `redirect: undefined`
 * explicitly — which is what an options object built from optional fields
 * produces — spreads the key back in as `undefined` and silently restores
 * following. A default only fires on `undefined`, so both spellings of "I did
 * not choose" land on `'error'`.
 *
 * The cost, so it is not a surprise at the first 308: a redirect now rejects
 * with a `TypeError` instead of being followed. For an API on our own origin
 * that is the correct signal — the path was wrong.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set(REQUEST_ID_HEADER, currentRequestId());

  const { redirect = 'error' } = init ?? {};

  return fetch(apiUrl(path), { ...init, redirect, headers });
}
