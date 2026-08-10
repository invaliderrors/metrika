import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import './globals.css';

/**
 * `lang` comes from `getLocale()`, not a literal. The two would agree today,
 * and the day they stop agreeing is the day a screen reader announces Spanish
 * copy with an English voice — a defect nothing else in this repo would catch.
 *
 * `NextIntlClientProvider` takes no props: rendered inside a Server Component
 * it inherits locale and messages from `src/i18n/request.ts`. Passing them by
 * hand would be a second source for the same two values.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const t = await getTranslations('shell');

  return (
    <html lang={locale}>
      <body className="bg-surface text-surface-foreground">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:m-2 focus:rounded-card focus:bg-brand focus:px-4 focus:py-2 focus:text-brand-foreground"
        >
          {t('skipToContent')}
        </a>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
