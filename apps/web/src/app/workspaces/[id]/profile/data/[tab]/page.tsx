'use client';

import { notFound, useParams } from 'next/navigation';
import { WORKSPACE_DATA_TABS, WorkspaceDataPage, type WorkspaceDataTab } from '@/components/lifecycle/WorkspaceDataPage';

export default function WorkspaceDataTabPage() {
  const { id, tab } = useParams<{ id: string; tab: string }>();
  if (!(WORKSPACE_DATA_TABS as readonly string[]).includes(tab)) notFound();
  return <WorkspaceDataPage workspaceId={id} tab={tab as WorkspaceDataTab} />;
}
