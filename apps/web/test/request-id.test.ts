import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, apiUrl } from '../src/lib/api/fetch.js';
import { REQUEST_ID_HEADER, newRequestId } from '../src/lib/request-id/request-id.js';
import type * as RequestIdModule from '../src/lib/request-id/request-id.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

/**
 * `apps/api`'s request-context module, READ FROM DISK.
 *
 * `apps/web` must not import `apps/api` — there is no dependency between them
 * and there must not be one — so the alternative to reading the file is a second
 * copy of the allowlist regex typed into this suite. A copy asserts that
 * `newRequestId()` matches *what this file thinks the API accepts*, which is
 * exactly the assertion that keeps passing after the API narrows its rule.
 *
 * `apps/web/turbo.json` declares both files under `$TURBO_ROOT$` in this task's
 * `inputs`. Without that declaration Turbo hashes only this package's own files
 * and the suite reports success FROM CACHE after the API has changed — measured
 * on this very pair, and the reason the declaration is there.
 */
function apiSource(file: string): string {
  return readFileSync(path.join(repoRoot, 'apps/api/src/shared/request-context', file), 'utf8');
}

const REQUEST_CONTEXT = apiSource('request-context.ts');
const MIDDLEWARE = apiSource('request-context.middleware.ts');

/**
 * The allowlist, extracted from the API's source rather than restated.
 *
 * Extraction is by pattern, so it can fail silently in exactly one way — a
 * rename on the API side making the match miss — and the first `describe` below
 * is what closes that: it asserts the extracted regex REJECTS values the real
 * one rejects. A degenerate extraction (`/./`, or a stale literal) accepts them
 * and goes red there rather than quietly making every assertion in this file
 * vacuous.
 */
function extract(source: string, pattern: RegExp, what: string): string {
  const captured = pattern.exec(source)?.[1];
  if (captured === undefined) {
    throw new Error(
      `Could not find ${what} in apps/api's request-context module. It was renamed or moved; ` +
        'update this extraction rather than deleting the assertions it feeds.',
    );
  }
  return captured;
}

const ACCEPTABLE_REQUEST_ID = new RegExp(
  extract(REQUEST_CONTEXT, /const ACCEPTABLE_REQUEST_ID = \/(.+?)\/;/, 'ACCEPTABLE_REQUEST_ID'),
);

const NO_REQUEST_ID = extract(
  REQUEST_CONTEXT,
  /export const NO_REQUEST_ID = '([^']+)';/,
  'NO_REQUEST_ID',
);

const API_REQUEST_ID_HEADER = extract(
  MIDDLEWARE,
  /export const REQUEST_ID_HEADER = '([^']+)';/,
  'REQUEST_ID_HEADER',
);

/** Enough samples that a generator with a biased branch shows up. */
const SAMPLES = Array.from({ length: 200 }, () => newRequestId());

const API_ORIGIN = 'http://localhost:3001';

describe('the extraction this suite is built on', () => {
  it('extracts the real rule, not something that accepts everything', () => {
    expect(ACCEPTABLE_REQUEST_ID.source).toBe('^[A-Za-z0-9._-]{1,128}$');

    // The four shapes the API's comment says the class exists to exclude. If the
    // extraction ever degenerates, these are what fail.
    expect(ACCEPTABLE_REQUEST_ID.test('')).toBe(false);
    expect(ACCEPTABLE_REQUEST_ID.test('has space')).toBe(false);
    expect(ACCEPTABLE_REQUEST_ID.test('forged\nlog line')).toBe(false);
    expect(ACCEPTABLE_REQUEST_ID.test('a'.repeat(129))).toBe(false);
  });

  it('extracts the sentinel and the header name', () => {
    expect(NO_REQUEST_ID).toBe('unknown');
    expect(API_REQUEST_ID_HEADER).toBe('x-request-id');
  });
});

describe('newRequestId', () => {
  it('produces a value the API accepts as-is', () => {
    for (const id of SAMPLES) expect(ACCEPTABLE_REQUEST_ID.test(id)).toBe(true);
  });

  /**
   * The failure this guards is silent on both sides: `normaliseRequestId`
   * REPLACES a value outside the class with a UUID of its own and returns 200,
   * so the request succeeds while the ID in the browser's network tab is not the
   * ID in the log.
   */
  it('is 32 hex characters, which is inside the class by construction', () => {
    for (const id of SAMPLES) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('can never be the NO_REQUEST_ID sentinel, in any casing', () => {
    for (const id of SAMPLES) expect(id.toLowerCase()).not.toBe(NO_REQUEST_ID.toLowerCase());
  });

  it('does not repeat', () => {
    expect(new Set(SAMPLES).size).toBe(SAMPLES.length);
  });
});

describe('the header name', () => {
  it('is the one apps/api reads', () => {
    expect(REQUEST_ID_HEADER).toBe(API_REQUEST_ID_HEADER);
  });
});

describe('apiUrl', () => {
  it('resolves a root-relative path against the configured API base', () => {
    expect(apiUrl('/quotes/1')).toBe(`${API_ORIGIN}/quotes/1`);
  });

  /**
   * Every one of these keeps the request id — and any credential a later header
   * adds — on our own origin. The last two are the interesting ones: both start
   * with `/`, and both resolve to a DIFFERENT ORIGIN under WHATWG URL parsing,
   * so a `startsWith('/')` check passes them.
   */
  it.each<[string, string]>([
    ['an absolute URL', 'https://evil.example/x'],
    ['a single-slash absolute URL', 'http:/evil.example/x'],
    ['a bare path with no leading slash', 'quotes'],
    ['the empty string', ''],
    ['a protocol-relative URL', '//evil.example/x'],
    ['a backslash-spelled protocol-relative URL', '/\\evil.example/x'],
  ])('refuses %s', (_label, input) => {
    expect(() => apiUrl(input)).toThrow(/root-relative path/);
  });

  it('never produces a URL on another origin, for any of the refused inputs', () => {
    const refused = ['https://evil.example/x', '//evil.example/x', '/\\evil.example/x'];

    for (const input of refused) {
      let resolved: string | undefined;
      try {
        resolved = apiUrl(input);
      } catch {
        resolved = undefined;
      }
      // Only reached if the guard stopped throwing. Then the URL itself has to
      // be checked, because "it threw" is not the property that matters.
      if (resolved !== undefined) expect(new URL(resolved).origin).toBe(API_ORIGIN);
    }
  });
});

describe('apiFetch', () => {
  const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response('{}'));

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sentHeaders(): Headers {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(headers).toBeInstanceOf(Headers);
    return headers as Headers;
  }

  it('sends the correlation header on every call', async () => {
    await apiFetch('/quotes');

    const value = sentHeaders().get(REQUEST_ID_HEADER);
    expect(value).not.toBeNull();
    expect(ACCEPTABLE_REQUEST_ID.test(value ?? '')).toBe(true);
  });

  it('sends it to the API origin and nowhere else', async () => {
    await apiFetch('/quotes');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${API_ORIGIN}/quotes`);
  });

  it("keeps the caller's other headers", async () => {
    await apiFetch('/quotes', { headers: { 'Accept-Language': 'es-CO' } });

    expect(sentHeaders().get('accept-language')).toBe('es-CO');
  });

  /**
   * `apiUrl`'s origin guard constrains the request this wrapper MAKES and
   * nothing after it. `fetch` follows redirects by default, and a cross-origin
   * redirect strips only `Authorization`, `Cookie` and `Proxy-Authorization` —
   * a custom header like `X-Request-Id` survives it. So the origin guard is not
   * the whole property without this.
   *
   * A default rather than a rule: it sits before the `...init` spread, so a
   * caller that genuinely needs to follow a redirect says so and the decision
   * is visible.
   */
  it('does not follow redirects, which would carry the header to another origin', async () => {
    await apiFetch('/quotes');

    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('error');
  });

  it('lets a caller opt into following one deliberately', async () => {
    await apiFetch('/quotes', { redirect: 'follow' });

    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('follow');
  });

  /**
   * The spelling that defeated the first version of this: written as
   * `{ redirect: 'error', ...init }`, an explicit `undefined` — what an options
   * object assembled from optional fields produces — spreads the key back in and
   * restores following. A destructuring default fires on `undefined` and this
   * case lands on `'error'` like any other unstated one.
   */
  it('treats an explicit undefined as not choosing, rather than as choosing to follow', async () => {
    // Asserted through a cast because `exactOptionalPropertyTypes` forbids
    // WRITING this literal — which is a large part of why the hazard survived
    // review. TypeScript cannot express the value; a JavaScript caller, a
    // `JSON.parse`d options object and a conditional spread all produce it.
    const explicitUndefined = { redirect: undefined } as unknown as RequestInit;

    await apiFetch('/quotes', explicitUndefined);

    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('error');
  });

  /**
   * THE CONTROL, and it is asserted as an ABSENCE.
   *
   * `NO_REQUEST_ID` is inside the acceptable character class, so the API rejects
   * it by literal comparison — case-insensitively, because a log search for the
   * sentinel is not case-sensitive. This is the other half: a caller cannot get
   * the value onto the wire in the first place, in any of `HeadersInit`'s three
   * shapes or any casing of the header name. A test asserting only that OUR id
   * is present would pass with the forged value sitting beside it, which is what
   * `Headers.append` would have produced.
   */
  it.each<[string, HeadersInit]>([
    ['an object, canonical casing', { 'X-Request-Id': NO_REQUEST_ID }],
    ['an object, lower case', { 'x-request-id': NO_REQUEST_ID }],
    ['an object, shouting', { 'X-REQUEST-ID': NO_REQUEST_ID.toUpperCase() }],
    ['an array of tuples', [['x-request-id', NO_REQUEST_ID]]],
    ['a Headers instance', new Headers({ 'x-request-id': NO_REQUEST_ID })],
    [
      'a duplicated array entry',
      [
        ['x-request-id', NO_REQUEST_ID],
        ['X-Request-Id', NO_REQUEST_ID],
      ],
    ],
  ])('cannot be made to send the sentinel via %s', async (_label, headers) => {
    await apiFetch('/quotes', { headers });

    const value = sentHeaders().get(REQUEST_ID_HEADER);

    expect(value?.toLowerCase()).not.toBe(NO_REQUEST_ID.toLowerCase());
    expect(ACCEPTABLE_REQUEST_ID.test(value ?? '')).toBe(true);
    // `Headers.get` joins duplicates with ', ', so this also proves the caller's
    // value was not merely appended alongside ours.
    expect(value).not.toContain(',');
  });

  /**
   * A newline in a header value is a forged log entry, which is the reason
   * `apps/api`'s character class is as narrow as it is. MEASURED: the `Headers`
   * constructor refuses it first — `TypeError: "forged\nlog line" is an invalid
   * header value` — so this one never reaches our `set` at all.
   *
   * Written as "it does not reach `fetch`" rather than "it throws", because
   * which of the two layers stops it is not the property that matters and is
   * not ours to guarantee. If a future runtime stopped throwing, this still
   * requires the value on the wire to be ours.
   */
  it('cannot be made to send an out-of-class value either', async () => {
    const call = apiFetch('/quotes', { headers: { 'x-request-id': 'forged\nlog line' } });

    let threw = false;
    try {
      await call;
    } catch {
      threw = true;
    }

    if (threw) {
      expect(fetchMock).not.toHaveBeenCalled();
    } else {
      expect(ACCEPTABLE_REQUEST_ID.test(sentHeaders().get(REQUEST_ID_HEADER) ?? '')).toBe(true);
    }
  });
});

/**
 * The navigation scoping, and the server/browser split that makes it safe.
 *
 * Modules are re-imported per case because the value under test IS module
 * state; without `resetModules` the second case would read the first one's.
 */
describe('currentRequestId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function freshModule(): Promise<typeof RequestIdModule> {
    vi.resetModules();
    return import('../src/lib/request-id/request-id.js');
  }

  it('is stable across calls within one navigation, in the browser', async () => {
    vi.stubGlobal('window', {});
    const requestId = await freshModule();

    expect(requestId.currentRequestId()).toBe(requestId.currentRequestId());
  });

  it('changes when a navigation begins', async () => {
    vi.stubGlobal('window', {});
    const requestId = await freshModule();

    const before = requestId.currentRequestId();
    requestId.beginNavigation();

    expect(requestId.currentRequestId()).not.toBe(before);
  });

  /**
   * The assertion that matters most, and it is about what must NOT happen.
   *
   * Module scope on the server is process scope: one value shared by every
   * concurrent request. A cached ID there would stamp two unrelated visitors'
   * calls with the same correlation identity, so a support agent searching for
   * one ticket's ID would find somebody else's request. Fresh per call is the
   * only safe answer until there is a request-scoped store.
   */
  it('never reuses a value on the server, where module scope is shared', async () => {
    const requestId = await freshModule();

    expect(typeof window).toBe('undefined');
    expect(requestId.currentRequestId()).not.toBe(requestId.currentRequestId());
  });

  it('does nothing on beginNavigation on the server', async () => {
    const requestId = await freshModule();

    expect(() => {
      requestId.beginNavigation();
    }).not.toThrow();
  });

  it('is the value apiFetch sends, for every call in one navigation', async () => {
    vi.stubGlobal('window', {});
    const requestId = await freshModule();
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    const { apiFetch: freshApiFetch } = await import('../src/lib/api/fetch.js');
    await freshApiFetch('/quotes');
    await freshApiFetch('/models');

    const sent = fetchMock.mock.calls.map((call) =>
      (call[1]?.headers as Headers).get(REQUEST_ID_HEADER),
    );

    expect(sent[0]).toBe(requestId.currentRequestId());
    expect(sent[1]).toBe(sent[0]);
  });
});

/**
 * The mount, asserted over the SOURCE, and the limits of that are worth stating
 * rather than leaving to be assumed.
 *
 * `NavigationRequestId` renders `null`, so there is nothing in the DOM for
 * `e2e/shell.spec.ts` to see and no browser assertion can tell a mounted
 * instance from a deleted one. What deleting it costs is silent and specific:
 * `currentRequestId()` keeps working and keeps returning the SAME value for the
 * whole session, so "a request ID per navigation" quietly becomes "per page
 * load" with every gate green.
 *
 * A text scan proves the element is written down, not that React mounted it —
 * the same trade `test/env-inlining.test.ts` documents. It is the strongest
 * assertion available for a component whose entire output is nothing.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not tidiness. MEASURED: without the
 * stripper this fixture stayed GREEN with the element deleted from the JSX,
 * because `layout.tsx`'s own comment block names `<NavigationRequestId />` while
 * explaining why it is there. A scan over prose is a scan that passes on prose.
 * Same reason `test/env-inlining.test.ts` strips before it whitelists.
 */
describe('the navigation refresh', () => {
  const LAYOUT = readFileSync(path.join(repoRoot, 'apps/web/src/app/layout.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(?<![:\\])\/\/[^\n]*/g, ' ');

  it('imports the component and nothing else provides it', () => {
    // Vacuity control for the stripper: a regex that ate the file would satisfy
    // nothing below, and this is what says so out loud.
    expect(LAYOUT).toContain(
      "import { NavigationRequestId } from '@/components/navigation-request-id'",
    );
  });

  it('is mounted in the root layout, which is the only component every navigation shares', () => {
    expect(LAYOUT).toContain('<NavigationRequestId />');
  });
});
