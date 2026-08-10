import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, type SupportedLocale } from './routing';

/**
 * One statically-analysable `import()` per locale, rather than the shorter
 * `import(`../../messages/${locale}.json`)`.
 *
 * Two reasons, both load-bearing. A template-literal specifier resolves to
 * `any`, and `.default` off an `any` is an error under `no-unsafe-member-access`
 * — the shorter form cannot pass this repo's lint at all. And `satisfies
 * Record<SupportedLocale, …>` makes the compiler reject a locale added to
 * `config/env.ts` that has no catalogue behind it, which is otherwise a runtime
 * MISSING_MESSAGE discovered by a user. The bundler also keeps the two
 * catalogues in separate chunks, which the template form cannot guarantee.
 */
const CATALOGUES = {
  'es-CO': async () => import('../../messages/es-CO.json'),
  'en-US': async () => import('../../messages/en-US.json'),
} satisfies Record<SupportedLocale, () => Promise<{ default: unknown }>>;

/**
 * No `[locale]` segment and no locale negotiation: there is one shipped locale
 * at MVP and the routing tree is flat. `next-intl` still needs a request config
 * so that `useTranslations` resolves on the server, and routing it through this
 * single function is what makes adding a segment later a change in one file.
 */
export default getRequestConfig(async () => ({
  locale: DEFAULT_LOCALE,
  messages: (await CATALOGUES[DEFAULT_LOCALE]()).default,
}));
