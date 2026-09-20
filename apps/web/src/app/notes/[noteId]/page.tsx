'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { LoadingBlock } from '@/components/ui';

import { fetchNote } from '@/lib/notes-api';

import { toastApiError } from '@/lib/api-errors';
/**
 * Короткий адрес заметки (`/notes/:id` из ленты упоминаний, поиска, карточек в чате):
 * личный маршрут сам переадресует рабочую заметку внутрь организации — адрес обязан
 * нести организацию (правило каркаса).
 */
export default function NoteShortLinkPage() {
  const { noteId } = useParams<{ noteId: string }>();
  const router = useRouter();
  useEffect(() => {
    fetchNote(noteId)
      .then((note) => router.replace(note.ownerType === 'workspace' ? `/workspaces/${note.ownerId}/notes?note=${note.id}` : `/notes?note=${note.id}`))
      .catch((e) => {
        toastApiError(e);
        router.replace('/notes');
      });
  }, [noteId, router]);
  return <LoadingBlock />;
}
