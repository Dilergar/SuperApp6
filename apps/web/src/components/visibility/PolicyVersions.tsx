'use client';

// ============================================================
// «Версии» политики типа записи (§5.10 B.3): опубликованные версии (кто и когда, сколько
// правил). «Вернуть эту версию» создаёт НОВЫЙ ЧЕРНОВИК — публикуется обычным путём (дифф,
// подтверждение), история не переписывается.
// ============================================================

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Button, Card, Chip, EmptyState, LoadingBlock, Table, TableCell, TableHeader, TableRow, useConfirm } from '@/components/ui';
import { fetchVisibilityVersions, restoreVisibilityVersion } from '@/lib/visibility-api';
import { wsVisibilityVersionsKey } from '@/lib/queries';
import { useFormatters } from '@/lib/format';
import { toast } from '@/lib/toast';

export function PolicyVersions({ workspaceId, recordType, onRestored }: { workspaceId: string; recordType: string; onRestored: () => void }) {
  const t = useTranslations('visibility');
  const f = useFormatters();
  const [confirm, confirmDialog] = useConfirm();
  const q = useQuery({ queryKey: wsVisibilityVersionsKey(workspaceId, recordType), queryFn: () => fetchVisibilityVersions(workspaceId, recordType) });
  const rows = (q.data ?? []).filter((v) => v.status !== 'draft');

  if (q.isPending) return <LoadingBlock />;
  if (!rows.length) return <EmptyState icon="history" title={t('org.versions.empty')} />;
  return (
    <Card>
      {confirmDialog}
      <Table
        lines
        aria-label={t('org.versions.title')}
        columns={[
          { key: 'v', label: t('org.versions.title'), width: 'minmax(8rem, 1fr)' },
          { key: 'at', label: '', width: 'minmax(8rem, 1fr)', hideOnMobile: true },
          { key: 'rules', label: '', width: 'max-content' },
          { key: 'act', label: '', width: 'max-content' },
        ]}
      >
        <TableHeader />
        {rows.map((v) => (
          <TableRow key={v.id}>
            <TableCell>
              <span style={{ display: 'inline-flex', gap: 'var(--spacing-2)', alignItems: 'center' }}>
                {t('org.versions.version', { version: v.version })}
                {v.status === 'published' && <Chip size="sm" tone="success">{t('org.versions.current')}</Chip>}
              </span>
            </TableCell>
            <TableCell hideOnMobile>{v.publishedAt ? f.dateTime(v.publishedAt) : '—'}</TableCell>
            <TableCell>{t('org.versions.rules', { n: v.ruleCount })}</TableCell>
            <TableCell>
              {v.status !== 'published' && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon="restore"
                  onClick={() =>
                    confirm({ title: t('org.versions.restore'), message: t('org.versions.restoreConfirm', { version: v.version }), confirmLabel: t('org.versions.restore') }, async () => {
                      await restoreVisibilityVersion(workspaceId, recordType, v.version);
                      toast(t('org.versions.restored', { version: v.version }), 'success');
                      onRestored();
                    })
                  }
                >
                  {t('org.versions.restore')}
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </Table>
    </Card>
  );
}
