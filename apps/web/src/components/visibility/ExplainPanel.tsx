'use client';

// ============================================================
// «Проверить сотрудника» (§5.10 B.4): что видит выбранный человек по типу записи (и по
// чьей записи — для относительных правил «руководитель», «сам»), уровень и «почему» по
// каждому полю. Ответ — объяснение СЕРВЕРА (тот же план, что режет ответы), только чтение;
// факт проверки пишется в журнал организации. За замком тарифа.
// ============================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { VisibilityTypeMetaDto, VisibilityWhyDto } from '@superapp/shared';
import { Card, CardHeader, EmptyState, Field, LoadingBlock, Select, Table, TableCell, TableHeader, TableRow } from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import { EntitlementLock } from '@/components/entitlements';
import { fetchVisibilityExplain } from '@/lib/visibility-api';
import { wsVisibilityExplainKey } from '@/lib/queries';
import type { Principal } from '@/lib/entities';
import { LevelChip } from './PolicyMatrix';

export function ExplainPanel({ workspaceId, types }: { workspaceId: string; types: VisibilityTypeMetaDto[] }) {
  const t = useTranslations('visibility');
  const tc = useTranslations('common');
  const [viewer, setViewer] = useState<Principal[]>([]);
  const [subject, setSubject] = useState<Principal[]>([]);
  const [recordType, setRecordType] = useState(types[0]?.recordType ?? '');
  const meta = types.find((x) => x.recordType === recordType);
  const viewerId = viewer[0]?.id ?? null;
  const subjectId = meta?.subject === 'user' ? (subject[0]?.id ?? null) : null;
  const q = useQuery({
    queryKey: wsVisibilityExplainKey(workspaceId, recordType, viewerId ?? '-', subjectId),
    queryFn: () => fetchVisibilityExplain(workspaceId, { recordType, viewerId: viewerId!, ...(subjectId ? { subjectId } : {}) }),
    enabled: !!viewerId && !!recordType,
    retry: false,
  });

  const why = (w: VisibilityWhyDto): string => {
    const base = t(`why.${w.source}`);
    if (w.audience) return `${base} · ${w.audience.kind === 'role' && w.audience.id ? tc(`role.workspace.${w.audience.id}`) : t(`audiences.${w.audience.kind}`)}`;
    if (w.role) return `${base} · ${tc(`role.workspace.${w.role}`)}`;
    if (w.relative) return `${base} · ${t(`audiences.${w.relative}`)}`;
    return base;
  };

  return (
    <Card>
      <CardHeader
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
            {t('org.explain.title')}
            <EntitlementLock keyName="visibility.explain" workspaceId={workspaceId} />
          </span>
        }
        subtitle={t('org.explain.body')}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-4)' }}>
        <Field label={t('org.explain.viewer')}>
          <EntitySelector types={['user']} multi={false} context={{ workspaceId }} value={viewer} onChange={setViewer} />
        </Field>
        <Select label={t('org.recordType')} value={recordType} onChange={setRecordType} options={types.map((x) => ({ value: x.recordType, label: t(`types.${x.recordType}.title`) }))} />
        {meta?.subject === 'user' && (
          <Field label={t('org.explain.subject')}>
            <EntitySelector types={['user']} multi={false} context={{ workspaceId }} value={subject} onChange={setSubject} />
          </Field>
        )}
      </div>
      {!viewerId ? (
        <EmptyState icon="user" title={t('org.explain.empty')} />
      ) : q.isPending ? (
        <LoadingBlock />
      ) : q.data ? (
        <Table
          lines
          aria-label={t('org.explain.title')}
          columns={[
            { key: 'field', label: t('org.explain.colField') },
            { key: 'level', label: t('org.explain.colLevel'), width: 'max-content' },
            { key: 'why', label: t('org.explain.colWhy'), hideOnMobile: true },
          ]}
        >
          <TableHeader />
          {q.data.fields.map((fld) => (
            <TableRow key={fld.fieldKey}>
              <TableCell>{t(`types.${recordType}.fields.${fld.fieldKey}.label`)}</TableCell>
              <TableCell>
                <LevelChip cell={{ level: fld.level, reveal: fld.reveal === 'one' }} />
              </TableCell>
              <TableCell hideOnMobile>
                <span className="label-sm">{why(fld.why)}</span>
              </TableCell>
            </TableRow>
          ))}
        </Table>
      ) : null}
    </Card>
  );
}
