'use client';

import { useParams } from 'next/navigation';
import { EntityCard } from '@/components/platform/EntityCard';

export default function PlatformWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  return <EntityCard entity="workspace" id={id} />;
}
