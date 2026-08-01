'use client';

// «Доступно мне» — чужие диски, где зрителю что-то открыли. Переход подставляет
// ?space=, поэтому ссылка на чужой диск переживает обновление страницы и шарится.

import Link from 'next/link';
import { Card, EmptyState, Icon, PageHeader } from '@/components/ui';
import { useDrive } from '../drive-shell';

export default function DriveSharedPage() {
  const { overview } = useDrive();
  const spaces = overview?.sharedWithMe ?? [];

  return (
    <>
      <PageHeader breadcrumb="Диск" title="Доступно мне" />
      <Card>
        {spaces.length === 0 ? (
          <EmptyState
            icon="share"
            title="Вам пока ничего не открывали"
            description="Здесь появятся диски, к которым вам дали доступ"
          />
        ) : (
          <ul style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {spaces.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/drive?space=${s.id}`}
                  className="ui-tbl-row ui-tbl-clickable"
                  style={{ gridTemplateColumns: '1fr auto', textDecoration: 'none' }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="drive" size={18} style={{ color: 'var(--primary-dim)' }} />
                    {s.title}
                  </span>
                  <Icon name="external" size={14} style={{ color: 'var(--muted)' }} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
