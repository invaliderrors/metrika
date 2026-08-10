import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

export default function Page() {
  const t = useTranslations('app');

  return (
    <main id="main" className="p-8">
      <h1 className="text-2xl font-semibold">{t('name')}</h1>
      <p className="mt-2 text-muted-foreground">{t('tagline')}</p>
      <Button className="mt-6">{t('name')}</Button>
    </main>
  );
}
