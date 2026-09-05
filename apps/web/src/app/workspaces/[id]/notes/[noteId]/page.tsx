'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { LoadingBlock } from '@/components/ui';

/** `/workspaces/:id/notes/:noteId` → трёхпанельный экран с выбранной заметкой */
export default function WorkspaceNoteShortLinkPage() {
  const { id, noteId } = useParams<{ id: string; noteId: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/workspaces/${id}/notes?note=${noteId}`);
  }, [id, noteId, router]);
  return <LoadingBlock />;
}
