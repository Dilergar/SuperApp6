'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  LIFECYCLE_HOLD_REASONS,
  lifecycleHoldableClasses,
  type LifecycleDataClass,
  type LifecycleHoldCreateInput,
  type LifecycleHoldDto,
  type LifecycleHoldReason,
  type WorkspaceMember,
} from '@superapp/shared';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  LoadingBlock,
  Modal,
  SegmentedControl,
  Select,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  Textarea,
  useConfirm,
  type TableColumn,
} from '@/components/ui';
import { EntitySelector } from '@/components/EntitySelector';
import { EntitlementLock, useEntitlementGate } from '@/components/entitlements/EntitlementLock';
import { PersonChip } from '@/app/circles/PersonCard';
import { splitName } from '@/app/workspaces/[id]/members/members-lib';
import { useFormatters } from '@/lib/format';
import { toastApiError } from '@/lib/api-errors';
import { useEntitlementDenied } from '@/lib/hooks/useEntitlements';
import { lifecycleHoldsKey, lifecycleRootKey } from '@/lib/queries';
import { createWorkspaceHold, fetchWorkspaceHolds, releaseWorkspaceHold } from '@/lib/lifecycle-api';

type Scope = 'custodian' | 'workspace' | 'class';

/**
 * Заморозки организации (legal hold, план §11.2): таблица «что · причина · кто поставил · с
 * какого дня · статус» + «Заморозить». Заморозка тихая: хранителю не сообщается (M365,
 * Dropbox), а снятие предупреждает, что удаление возобновится по политике. Тариф — замок у
 * кнопки (`lifecycle.holds`), заморозки платформы организация не видит.
 */
export function WorkspaceHolds({ workspaceId, member }: { workspaceId: string; member: (userId: string) => WorkspaceMember | undefined }) {
  const t = useTranslations('lifecycle');
  const fmt = useFormatters();
  const qc = useQueryClient();
  const [confirm, confirmUI] = useConfirm();
  const [creating, setCreating] = useState(false);
  const gate = useEntitlementGate('lifecycle.holds', workspaceId);

  const q = useInfiniteQuery({
    queryKey: lifecycleHoldsKey(workspaceId),
    queryFn: ({ pageParam }) => fetchWorkspaceHolds(workspaceId, { cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const holds = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.items), [q.data]);

  const person = (userId: string | null) => {
    if (!userId) return null;
    const m = member(userId);
    if (!m) return <span className="label-sm">—</span>;
    const [fn, ln] = splitName(m.userName);
    return <PersonChip size="XS" userId={m.userId} firstName={fn} lastName={ln} avatar={m.userAvatar} />;
  };
  const target = (h: LifecycleHoldDto) => {
    if (h.scope === 'custodian') return person(h.custodianUserId);
    if (h.scope === 'space') return <Chip size="sm" tone="neutral" icon={h.spaceType === 'chat' ? 'messenger' : 'workspace'}>{t(h.spaceType === 'chat' ? 'holds.target.chat' : 'holds.target.workspace')}</Chip>;
    if (h.scope === 'class' && h.dataClass) return <Chip size="sm" tone="neutral">{t(`classes.${h.dataClass}.title`)}</Chip>;
    return <Chip size="sm" tone="neutral">{t('holds.target.record')}</Chip>;
  };

  const release = (h: LifecycleHoldDto) =>
    confirm({ title: t('holds.releaseTitle'), message: t('holds.releaseText'), confirmLabel: t('holds.release'), danger: true }, async () => {
      try {
        await releaseWorkspaceHold(workspaceId, h.id);
        await qc.invalidateQueries({ queryKey: lifecycleRootKey(workspaceId) });
      } catch (err) {
        toastApiError(err);
        throw err;
      }
    });

  const columns: TableColumn[] = [
    { key: 'target', label: t('holds.columns.target'), width: 'minmax(10rem, 1.4fr)' },
    { key: 'reason', label: t('holds.columns.reason'), width: 'max-content', hideOnMobile: true },
    { key: 'by', label: t('holds.columns.by'), width: 'minmax(8rem, 1fr)', hideOnMobile: true },
    { key: 'since', label: t('holds.columns.since'), width: 'max-content', hideOnMobile: true },
    { key: 'status', label: t('holds.columns.status'), width: 'max-content' },
    { key: 'actions', label: '', width: 'max-content', align: 'end' },
  ];

  return (
    <Card span={12}>
      <CardHeader
        title={t('holds.title')}
        actions={
          <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <EntitlementLock keyName="lifecycle.holds" workspaceId={workspaceId} id={gate.lockId} />
            <Button variant="primary" icon="lock" disabled={gate.blocked} aria-describedby={gate.describedBy} onClick={() => setCreating(true)}>
              {t('holds.create')}
            </Button>
          </div>
        }
      />
      <p className="body-sm" style={{ margin: '0 0 var(--spacing-3)' }}>{t('holds.description')}</p>
      {q.isPending ? (
        <LoadingBlock />
      ) : holds.length === 0 ? (
        <EmptyState icon="lock" title={t('holds.empty')} description={t('holds.emptyText')} />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <Table columns={columns} lines aria-label={t('holds.title')}>
            <TableHeader />
            {holds.map((h, i) => (
              <TableRow key={h.id} rowIndex={i + 2}>
                <TableCell>{target(h)}</TableCell>
                <TableCell hideOnMobile><Chip size="sm" tone="neutral">{t(`holds.reasons.${h.reasonCode}`)}</Chip></TableCell>
                <TableCell hideOnMobile>{person(h.createdById)}</TableCell>
                <TableCell hideOnMobile><span className="label-sm">{fmt.date(h.createdAt)}</span></TableCell>
                <TableCell>
                  {h.releasedAt ? (
                    <Chip size="sm" tone="neutral">{t('holds.status.released')}</Chip>
                  ) : (
                    <Chip size="sm" tone="neutral" icon="lock">{t('holds.status.active')}</Chip>
                  )}
                </TableCell>
                <TableCell align="end">
                  {!h.releasedAt && h.canRelease && (
                    <Button size="sm" variant="matte" tone="danger" onClick={() => release(h)}>{t('holds.release')}</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </Table>
        </div>
      )}
      {q.hasNextPage && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--spacing-4)' }}>
          <Button variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('holds.more')}</Button>
        </div>
      )}
      {creating && <CreateHoldModal workspaceId={workspaceId} onClose={() => setCreating(false)} />}
      {confirmUI}
    </Card>
  );
}

function CreateHoldModal({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useTranslations('lifecycle');
  const qc = useQueryClient();
  const denied = useEntitlementDenied();
  const [scope, setScope] = useState<Scope>('custodian');
  const [who, setWho] = useState<{ type: string; id: string }[]>([]);
  const [dataClass, setDataClass] = useState<LifecycleDataClass | null>(null);
  const [reason, setReason] = useState<LifecycleHoldReason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const classes = lifecycleHoldableClasses();
  const ready = !!reason && (scope === 'workspace' || (scope === 'custodian' && who.length === 1) || (scope === 'class' && !!dataClass));

  const submit = async () => {
    if (!ready || busy) return;
    const base = { reasonCode: reason!, ...(note.trim() ? { note: note.trim() } : {}) };
    const input: LifecycleHoldCreateInput =
      scope === 'custodian'
        ? { scope: 'custodian', custodianUserId: who[0]!.id, ...base }
        : scope === 'class'
          ? { scope: 'class', dataClass: dataClass!, ...base }
          : { scope: 'space', spaceType: 'workspace', spaceId: workspaceId, ...base };
    setBusy(true);
    try {
      await createWorkspaceHold(workspaceId, input);
      await qc.invalidateQueries({ queryKey: lifecycleRootKey(workspaceId) });
      onClose();
    } catch (err) {
      if (!denied(err)) toastApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('holds.form.title')}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('holds.form.cancel')}</Button>
          <Button variant="primary" icon="lock" disabled={!ready} loading={busy} onClick={() => void submit()}>{t('holds.form.submit')}</Button>
        </>
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        <SegmentedControl<Scope>
          aria-label={t('holds.form.scope')}
          value={scope}
          onChange={setScope}
          items={[
            { key: 'custodian', label: t('holds.form.scopeCustodian') },
            { key: 'workspace', label: t('holds.form.scopeWorkspace') },
            { key: 'class', label: t('holds.form.scopeClass') },
          ]}
        />
        {scope === 'custodian' && (
          <EntitySelector types={['user']} value={who} onChange={(v) => setWho(v.slice(-1))} context={{ workspaceId }} placeholder={t('holds.form.member')} />
        )}
        {scope === 'class' && (
          <Select<LifecycleDataClass>
            label={t('holds.form.class')}
            value={dataClass}
            onChange={setDataClass}
            options={classes.map((c) => ({ value: c, label: t(`classes.${c}.title`) }))}
          />
        )}
        <Select<LifecycleHoldReason>
          label={t('holds.form.reason')}
          value={reason}
          onChange={setReason}
          options={LIFECYCLE_HOLD_REASONS.map((r) => ({ value: r, label: t(`holds.reasons.${r}`) }))}
        />
        <Textarea label={t('holds.form.note')} hint={t('holds.form.noteHint')} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}
