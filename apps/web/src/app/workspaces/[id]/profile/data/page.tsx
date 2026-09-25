import { redirect } from 'next/navigation';

// Раздел по умолчанию — сроки хранения
export default async function WorkspaceDataIndex({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/workspaces/${id}/profile/data/retention`);
}
