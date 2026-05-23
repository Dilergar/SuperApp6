'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// /profile itself has no content — bounce to the default section.
// Client redirect (the whole profile area is client-gated anyway).
export default function ProfileIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/profile/card');
  }, [router]);
  return <p className="label-md" style={{ fontSize: '1rem' }}>Загрузка...</p>;
}
