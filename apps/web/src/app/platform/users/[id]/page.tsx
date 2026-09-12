'use client';

import { useParams } from 'next/navigation';
import { EntityCard } from '@/components/platform/EntityCard';

export default function PlatformUserPage() {
  const { id } = useParams<{ id: string }>();
  return <EntityCard entity="user" id={id} />;
}
