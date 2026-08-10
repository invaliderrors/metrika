import { getTranslations } from 'next-intl/server';

/**
 * `#main` is the skip link's target, so this id is part of the shell contract
 * rather than decoration — `e2e/shell.spec.ts` proves the link is focusable,
 * and the id is what makes it useful once activated.
 */
export default async function Page() {
  const t = await getTranslations('app');

  return (
    <main id="main" className="mx-auto max-w-3xl p-8">
      <h1 className="text-4xl font-semibold tracking-tight">{t('name')}</h1>
      <p className="mt-3 text-muted-foreground">{t('tagline')}</p>
    </main>
  );
}
