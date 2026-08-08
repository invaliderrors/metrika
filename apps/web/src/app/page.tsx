import { useTranslations } from 'next-intl';

export default function HomePage() {
  const t = useTranslations('home');
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col items-center justify-center p-8">
      <h1 className="mb-4 text-4xl font-bold">{t('title')}</h1>
      <p className="mb-8 text-lg opacity-80">{t('subtitle')}</p>
      <button
        type="button"
        className="rounded bg-white px-6 py-3 font-medium text-black hover:opacity-90"
      >
        {t('cta')}
      </button>
    </main>
  );
}
