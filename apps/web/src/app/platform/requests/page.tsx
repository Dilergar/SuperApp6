'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { PlatformRequestDto } from '@superapp/shared';
import { Alert, Button, Chip, EmptyState, LoadingBlock, PageHeader, SegmentedControl, Table, TableCell, TableRow, useConfirm } from '@/components/ui';
import { PersonAvatar } from '@/app/messenger/messenger-ui';
import { decidePlatformRequest, fetchPlatformRequests, platformRequestsKey, platformRootKey, withdrawPlatformRequest } from '@/lib/platform/api';
import { useFormatters } from '@/lib/format';
import { RISK_TONE, isStepUpRequired, notifyCommandError } from '@/components/platform/CommandRunner';
import { usePlatformAuth } from '@/lib/platform/usePlatformAuth';
import { StepUpModal } from '@/components/platform/StepUpModal';
import { toast } from '@/lib/toast';

type State = 'pending' | 'mine' | 'history';

const STATUS_TONE = { pending: 'warning', approved: 'accent', executed: 'success', rejected: 'danger', cancelled: 'neutral', failed: 'danger' } as const;

/** Очередь four-eyes: ожидают решения / мои / история; автор свою заявку не одобряет — кнопок нет. */
export default function PlatformRequestsPage() {
  const t = useTranslations('platform');
  const tc = useTranslations('common');
  const f = useFormatters();
  const qc = useQueryClient();
  const search = useSearchParams();
  const highlight = search.get('id');
  const [state, setState] = useState<State>('pending');
  const q = useQuery({ queryKey: platformRequestsKey(state), queryFn: () => fetchPlatformRequests(state) });
  const [confirm, confirmUI] = useConfirm();
  const [stepUp, setStepUp] = useState<null | (() => Promise<void>)>(null);
  const { me } = usePlatformAuth();

  const decide = async (r: PlatformRequestDto, outcome: 'approved' | 'rejected') => {
    const run = async () => {
      try {
        await decidePlatformRequest(r.id, outcome);
        toast(t(outcome === 'approved' ? 'requests.approved' : 'requests.rejected'), 'success');
        void qc.invalidateQueries({ queryKey: platformRootKey });
      } catch (err) {
        if (isStepUpRequired(err)) setStepUp(() => run);
        else notifyCommandError(err);
      }
    };
    confirm(
      { title: t(outcome === 'approved' ? 'requests.confirmApprove' : 'requests.confirmReject'), message: t(r.titleKey.replace(/^platform\./, '')), danger: outcome === 'rejected' },
      run,
    );
  };

  /** Своя заявка отзывается ЗДЕСЬ: продуктовый «отзыв автором» заявок кабинета не касается. */
  const withdraw = (r: PlatformRequestDto) =>
    confirm({ title: t('requests.confirmWithdraw'), message: t(r.titleKey.replace(/^platform\./, '')), danger: true }, async () => {
      try {
        await withdrawPlatformRequest(r.id);
        toast(t('requests.withdrawn'), 'success');
        void qc.invalidateQueries({ queryKey: platformRootKey });
      } catch (err) {
        notifyCommandError(err);
      }
    });

  const items = q.data?.items ?? [];
  return (
    <>
      <PageHeader breadcrumb={t('shell.title')} title={t('nav.requests')} description={t('requests.description')} />
      <div style={{ marginBottom: 'var(--spacing-4)' }}>
        <SegmentedControl<State>
          value={state}
          onChange={setState}
          items={[
            { key: 'pending', label: t('requests.state.pending') },
            { key: 'mine', label: t('requests.state.mine') },
            { key: 'history', label: t('requests.state.history') },
          ]}
          aria-label={t('nav.requests')}
        />
      </div>
      {q.isPending ? (
        <LoadingBlock />
      ) : q.isError ? (
        <Alert tone="danger">{tc('state.error')}</Alert>
      ) : items.length === 0 ? (
        <EmptyState icon="check" title={t('requests.empty')} />
      ) : (
        <Table
          columns={[
            { key: 'command', label: t('audit.col.command') },
            { key: 'target', label: t('audit.col.target'), hideOnMobile: true },
            { key: 'actor', label: t('requests.col.author'), width: 'max-content' },
            { key: 'reason', label: t('audit.reason'), hideOnMobile: true },
            { key: 'status', label: t('requests.col.status'), width: 'max-content' },
            { key: 'actions', label: '', width: 'max-content' },
          ]}
          lines
          aria-label={t('nav.requests')}
        >
          {items.map((r, i) => (
            <TableRow key={r.id} rowIndex={i + 1} selected={highlight === r.id}>
              <TableCell>
                <span style={{ display: 'inline-flex', gap: '0.375rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="body-sm">{t(r.titleKey.replace(/^platform\./, ''))}</span>
                  <Chip tone={RISK_TONE[r.risk]} size="sm">{t(`risk.${r.risk}`)}</Chip>
                </span>
              </TableCell>
              <TableCell hideOnMobile><span className="label-sm">{r.targetType ? `${r.targetType} · ${r.targetId?.slice(0, 8)}` : '—'}</span></TableCell>
              <TableCell>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}>
                  {r.actor && <PersonAvatar userId={r.actor.id} name={`${r.actor.firstName} ${r.actor.lastName ?? ''}`.trim()} avatar={r.actor.avatar} size="sm" />}
                  <span className="label-sm">{f.dateTime(r.createdAt)}</span>
                </span>
              </TableCell>
              <TableCell hideOnMobile><span className="label-sm">{r.reason ?? ''}</span></TableCell>
              <TableCell>
                <Chip tone={STATUS_TONE[r.status]} size="sm">{t(`requests.status.${r.status}`)}</Chip>
              </TableCell>
              <TableCell align="end">
                {r.canDecide ? (
                  <span style={{ display: 'inline-flex', gap: '0.375rem' }}>
                    <Button size="sm" variant="primary" tone="success" icon="check" onClick={() => void decide(r, 'approved')}>{t('requests.approve')}</Button>
                    <Button size="sm" variant="matte" tone="danger" icon="close" onClick={() => void decide(r, 'rejected')}>{t('requests.reject')}</Button>
                  </span>
                ) : r.status === 'pending' && r.actorId === me?.userId ? (
                  <Button size="sm" variant="ghost" icon="close" onClick={() => withdraw(r)}>{t('requests.withdraw')}</Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </Table>
      )}
      {confirmUI}
      <StepUpModal open={!!stepUp} onClose={() => setStepUp(null)} onDone={() => { const run = stepUp; setStepUp(null); if (run) void run(); }} />
    </>
  );
}
