'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { NotesWorkspace } from '@/app/notes/_components/NotesWorkspace';
import RouteLoading from '@/components/shell/RouteLoading';

/** Заметки организации: тот же экран, пространство — организация из адреса */
export default function WorkspaceNotesPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <Suspense fallback={<RouteLoading />}>
      <NotesWorkspace scope={{ workspaceId: id }} />
    </Suspense>
  );
}
