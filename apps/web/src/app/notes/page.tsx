'use client';

import { Suspense } from 'react';
import { NotesWorkspace } from './_components/NotesWorkspace';
import RouteLoading from '@/components/shell/RouteLoading';

/** Личные заметки: пространство зрителя (без организации) */
export default function NotesPage() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <NotesWorkspace scope={{}} />
    </Suspense>
  );
}
