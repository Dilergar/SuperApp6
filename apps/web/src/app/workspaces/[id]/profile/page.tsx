'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

/** Profile index → default profile section (the company card). */
export default function WorkspaceProfileIndex() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/workspaces/${id}/profile/card`);
  }, [id, router]);
  return null;
}
