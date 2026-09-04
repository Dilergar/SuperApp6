'use client';

// Старый раздел «Объекты» внутри «Сотрудников» переехал в самостоятельный сервис
// «Объекты» (дерево площадок, штатное расписание, график смен, оборудование).
// Оставляем редирект: на адрес ведут закладки, письма и ссылки в хронике.

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function LegacyBranchesRedirect() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  useEffect(() => {
    router.replace(`/workspaces/${id}/objects`);
  }, [router, id]);

  return null;
}
