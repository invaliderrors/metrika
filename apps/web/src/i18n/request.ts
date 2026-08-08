import { getRequestConfig } from 'next-intl/server';
import { headers } from 'next/headers';

export const defaultLocale = 'es-CO' as const;
export const locales = [defaultLocale] as const;
export type Locale = (typeof locales)[number];

export default getRequestConfig(async () => {
  // Phase 0: hard-default to es-CO. Phase 1+ may negotiate from headers/user prefs.
  void headers;
  return {
    locale: defaultLocale,
    messages: (await import(`../messages/${defaultLocale}.json`)) as Record<string, unknown>,
  };
});
