import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { clientEnv } from '@/config/env';
import './globals.css';

/**
 * THE ONLY REASON `clientEnv` IS IMPORTED ANYWHERE THE APP ROUTER REACHES.
 *
 * `src/config/env.ts` parses at module scope and its header claims that a
 * misconfigured deployment therefore "fails at build, not on a user's first
 * render". That was true of the module and FALSE OF THE APPLICATION until this
 * line: nothing under `src/` imported it, so MEASURED, `turbo run build` with
 * both `NEXT_PUBLIC_` keys unset exited 0 and inlined nothing. The claim was
 * self-evidently correct and enforced nothing.
 *
 * Consuming the VALUE rather than importing the module for its side effect is
 * the load-bearing part. A bare `import '@/config/env'` reads as dead code and
 * is exactly what a later tidy-up deletes, silently reopening the hole. The
 * preconnect hint below is a real optimisation — it opens the TCP and TLS
 * handshake to the API origin before the first fetch needs it — so DELETING the
 * import costs the page a real element and `e2e/shell.spec.ts` goes red on the
 * missing `<link>`. MEASURED, in both directions.
 *
 * WHAT THAT TEST DOES NOT CATCH IS SUBSTITUTION, and the distinction is worth
 * writing down rather than leaving to be rediscovered. Replace
 * `clientEnv.NEXT_PUBLIC_API_BASE_URL` with the literal origin Playwright
 * supplies and the element is still there with the same href: all seven e2e
 * tests pass, INCLUDING the one that names this import, while `turbo run build`
 * with both keys unset goes back to exit 0 and the build-time guarantee is gone.
 * MEASURED. Two byte-identical documents are byte-identical — this is the same
 * shape as the hardcoded-copy hole `test/messages.test.ts` documents, and no
 * browser assertion can close either.
 *
 * The proof that covers substitution is the build-time one: `turbo run build`
 * with both keys unset must fail with `ClientEnvSchema`'s ZodError naming them.
 * It lives in the task report rather than in a suite because unsetting the
 * environment and shelling out to a full `next build` costs more than the inner
 * loop can carry. Anything that changes this line should re-run it.
 *
 * `new URL(...).origin` rather than the raw string: `rel="preconnect"` takes an
 * ORIGIN, and normalising through `URL` also means a value that is not a
 * parseable URL fails here rather than emitting a hint browsers silently
 * ignore. The Zod schema already requires an `http(s)://` prefix; this is the
 * part it cannot check — `http://` on its own satisfies that regex and is not a
 * URL.
 *
 * The rethrow is what makes that second failure USABLE. `new URL('http://')`
 * throws `TypeError [ERR_INVALID_URL]: Invalid URL`, which names neither the
 * offending value nor the variable it came from; inside `next build` it surfaces
 * as a failure to collect page data for `/` with no clue which of the
 * environment's keys is wrong. Every other environment failure in this app
 * arrives through `EnvValidationError` naming the key, and this one has no
 * business being the exception.
 */
function apiOriginFrom(value: string): string {
  try {
    return new URL(value).origin;
  } catch (cause) {
    throw new Error(
      `NEXT_PUBLIC_API_BASE_URL is not a parseable URL: ${JSON.stringify(value)}. ` +
        'It needs a host, not just a scheme — http://localhost:3001, not http://.',
      { cause },
    );
  }
}

const API_ORIGIN = apiOriginFrom(clientEnv.NEXT_PUBLIC_API_BASE_URL);

/**
 * Title and description come from the catalogue, so the browser tab and every
 * link preview are localised by the same mechanism as the page body rather than
 * by a literal that no translator will ever see.
 *
 * The translator is bound to `tApp`, NOT to `t`, and that is not a style
 * preference. `test/messages.test.ts` scrapes call sites by binding NAME over
 * the whole file's text: two bindings both called `t` in one file make every
 * `t('…')` call resolve against BOTH namespaces, so `t('skipToContent')` below
 * would be checked as `app.skipToContent` and fail. Distinct names keep each
 * call attributable to one namespace.
 */
export async function generateMetadata(): Promise<Metadata> {
  const tApp = await getTranslations('app');

  return { title: tApp('name'), description: tApp('tagline') };
}

/**
 * `lang` comes from `getLocale()`, not a literal. The two would agree today,
 * and the day they stop agreeing is the day a screen reader announces Spanish
 * copy with an English voice — a defect nothing else in this repo would catch.
 *
 * `NextIntlClientProvider` takes no props: rendered inside a Server Component
 * it inherits locale and messages from `src/i18n/request.ts`. Passing them by
 * hand would be a second source for the same two values.
 *
 * The skip link is the first FOCUSABLE node in the body, which is what makes it
 * reachable by the first Tab press. `<link>` above it is not focusable, and
 * React hoists it into the head regardless. `sr-only` until focused, so it
 * costs sighted users nothing and costs keyboard users nothing to find.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const t = await getTranslations('shell');

  return (
    <html lang={locale}>
      <body className="bg-surface text-surface-foreground antialiased">
        <link rel="preconnect" href={API_ORIGIN} />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded-card focus:bg-brand focus:px-4 focus:py-2 focus:text-brand-foreground"
        >
          {t('skipToContent')}
        </a>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
