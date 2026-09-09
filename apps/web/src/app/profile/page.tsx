'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

// /profile itself has no content — bounce to the default section.
// Client redirect (the whole profile area is client-gated anyway).
export default function ProfileIndex() {
  const t = useTranslations('common');
  const router = useRouter();
  useEffect(() => {
    router.replace('/profile/card');
  }, [router]);
  return <p className="label-md" style={{ fontSize: '1rem' }}>{t('state.loading')}</p>;
}
