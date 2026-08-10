import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { z } from 'zod';

/**
 * The shipped `es-CO` catalogue, READ FROM DISK, so that every copy assertion
 * below compares the DOM against the catalogue rather than against a second
 * copy of the same Spanish sentence typed into this file.
 *
 * BE PRECISE ABOUT WHAT THIS CAN AND CANNOT PROVE. No assertion over rendered
 * text can distinguish `{t('tagline')}` from the literal string pasted into
 * `page.tsx` — both produce byte-identical DOM, so a browser has nothing to
 * look at. That is a property of end-to-end testing, not a weakness of this
 * particular expectation, and it is why the brief's original
 * `getByText(/modelos arquitectónicos/i)` was worth replacing: it asserted the
 * copy and read as if it asserted the pipeline.
 *
 * What reading the catalogue buys is the OTHER half, and it is the half that
 * matters in practice: the rendered string is now required to track the
 * catalogue. Change or delete `app.tagline` here and a page that hardcoded it
 * goes red immediately — deleted, on this parse, naming the key; changed, on
 * the DOM comparison. So the pair (this file + the catalogue) is what enforces
 * the wiring, and a hardcoded literal survives only for exactly as long as
 * nobody touches the copy.
 *
 * Zod rather than a bare `JSON.parse`, for the usual reason and one specific
 * one: a catalogue missing `app.tagline` must fail HERE, loudly and by name,
 * rather than resolve to `undefined` and turn `getByText(undefined)` into an
 * assertion that quietly matches everything.
 */
const Catalogue = z.object({
  app: z.object({ name: z.string().min(1), tagline: z.string().min(1) }),
  shell: z.object({ skipToContent: z.string().min(1) }),
});

const rawCatalogue: unknown = JSON.parse(
  readFileSync(new URL('../messages/es-CO.json', import.meta.url), 'utf8'),
);
const messages = Catalogue.parse(rawCatalogue);

/**
 * Must equal `webServer.env.NEXT_PUBLIC_API_BASE_URL` in `playwright.config.ts`.
 *
 * Deliberately a second literal rather than an import from the config: loading
 * the Playwright config inside a worker to read one string is a lot of
 * machinery for a value whose drift is already loud — the two disagreeing makes
 * the preconnect test fail on a href mismatch, which is exactly the signal you
 * want, not a silent pass.
 */
const API_ORIGIN = 'http://127.0.0.1:3001';

/**
 * next-intl renders a message's own key path when the message is missing, so
 * `app.tagline` appearing in the page body is the signature of a catalogue that
 * did not resolve. Bounded so it cannot fire on prose.
 *
 * The namespace alternation is DERIVED from the catalogue, not written out.
 * Hardcoding `(?:app|shell)` would leave a third namespace silently uncovered —
 * the assertion would keep passing while saying nothing about it, which is the
 * failure shape this whole file is trying to avoid.
 *
 * Read off `rawCatalogue` rather than `messages`, and that distinction is the
 * whole point: Zod strips unknown keys, so `Object.keys(messages)` can only ever
 * return the two namespaces `Catalogue` declares — exactly the hardcoding this
 * is meant to remove. `Catalogue.parse` above has already guaranteed at least
 * `app` and `shell`, so the alternation cannot be empty (an empty group would
 * match any `.word` and fail the page for no reason).
 */
const NAMESPACES = Object.keys(z.record(z.string(), z.unknown()).parse(rawCatalogue));
const RAW_MESSAGE_KEY = new RegExp(String.raw`\b(?:${NAMESPACES.join('|')})\.[a-zA-Z][\w-]*`);

test('the shell renders the heading from the catalogue', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(messages.app.name);
});

test('the tagline the page renders is the one the es-CO catalogue holds', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText(messages.app.tagline, { exact: true })).toBeVisible();
});

test('no message renders as its own key, which is how next-intl reports a miss', async ({
  page,
}) => {
  await page.goto('/');

  const body = await page.locator('body').innerText();
  expect(body, 'a key path in the rendered text means the catalogue did not resolve').not.toMatch(
    RAW_MESSAGE_KEY,
  );
});

test('the document declares the es-CO locale', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('lang', 'es-CO');
});

test('the skip link is the first focusable element', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');

  await expect(page.getByRole('link', { name: messages.shell.skipToContent })).toBeFocused();
});

test('styles are applied, not merely referenced', async ({ page }) => {
  await page.goto('/');

  // A className present in the markup proves nothing; a computed background
  // proves the stylesheet loaded and the token resolved.
  const background = await page
    .locator('body')
    .evaluate((el) => getComputedStyle(el).backgroundColor);

  expect(background).not.toBe('');
  expect(background).not.toBe('rgba(0, 0, 0, 0)');
});

/**
 * The whole point of `src/config/env.ts` is that a misconfigured deployment
 * fails at BUILD time, and that only holds while something the App Router
 * reaches actually imports `clientEnv`. Nothing did until this shell: the
 * module parsed at import and was imported by nothing, so `next build` exited 0
 * with both keys unset — measured.
 *
 * A build-time property needs a build-time proof, and that one lives in the
 * task report (`turbo run build` with the variables unset must fail with the
 * ZodError naming them). What this test adds is the guard against the quiet
 * regression: an import kept alive only for its side effect is exactly what a
 * later cleanup deletes. The preconnect hint below consumes the VALUE, so the
 * import cannot be removed without the page losing a real element, and this
 * assertion is what notices.
 */
test('the API origin from clientEnv reaches the document', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator(`link[rel="preconnect"][href="${API_ORIGIN}"]`)).toHaveCount(1);
});
