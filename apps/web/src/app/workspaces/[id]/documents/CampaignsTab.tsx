'use client';

// ============================================================
// Вкладка «Ознакомления» (КЭДО, Этап 5): кампании с аналитикой ДО КОНКРЕТНОГО
// человека — кто не ознакомился, поимённо. Запуск: документ + аудитория +
// режим фиксации (клик — законно по ст. 23 п. 2 пп. 6 ТК РК и бесплатно;
// SMS — усиленное доказательство, стоит денег организации).
// ============================================================

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  CAMPAIGN_FIX_MODES,
  CAMPAIGN_MODES,
  HR_LIMITS,
  type CreateCampaignInput,
  type DocCampaignDto,
  type OrgDocumentDto,
} from '@superapp/shared';
import { apiErrorMessage } from '@/lib/api';
import {
  cancelCampaign,
  createCampaign,
  fetchCampaignDetail,
  fetchCampaigns,
  markCampaignSmsFailed,
  sweepCampaign,
} from '@/lib/hr-api';
import { fetchOrgDocuments } from './documents-api';
import { hrCampaignKey, hrCampaignsKey } from '@/lib/queries';
import { toast, toastError } from '@/lib/toast';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Chip,
  DatePicker,
  EmptyState,
  LoadingBlock,
  Modal,
  Select,
  TickBar,
  useConfirm,
} from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { EntitySelector } from '@/components/EntitySelector';
import type { Principal } from '@/lib/entities';

/** Сколько человек показываем в разделе аналитики (кампания бывает на 5000) */
const TARGETS_SHOWN = 100;

const isoToDate = (iso?: string): Date | null => (iso ? new Date(`${iso}T00:00:00`) : null);
const dateToIso = (d: Date | null): string | undefined =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;

export function CampaignsTab({ workspaceId }: { workspaceId: string }) {
  const tr = useTranslations('documents');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [confirm, confirmUI] = useConfirm();

  const listQ = useQuery({
    queryKey: hrCampaignsKey(workspaceId),
    queryFn: () => fetchCampaigns(workspaceId),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => cancelCampaign(workspaceId, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: hrCampaignsKey(workspaceId) }),
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  // «Догнать сейчас» (standing): приняли человека — не ждать ночного крона
  const sweep = useMutation({
    mutationFn: (id: string) => sweepCampaign(workspaceId, id),
    onSuccess: () => {
      toast(tr('campaigns.sweepStarted'), 'success');
      void qc.invalidateQueries({ queryKey: hrCampaignsKey(workspaceId) });
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-grid)', marginTop: 'var(--gap-grid)' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button icon="add" onClick={() => setCreateOpen(true)}>
          {tr('campaigns.start')}
        </Button>
      </div>

      {listQ.isPending ? (
        <LoadingBlock />
      ) : listQ.isError ? (
        <EmptyState
          icon="warningCircle"
          title={tr('campaigns.loadFailed')}
          description={tr('campaigns.loadFailedHint')}
          action={<Button variant="matte" icon="refresh" onClick={() => listQ.refetch()}>{tc('actions.retry')}</Button>}
        />
      ) : (listQ.data?.items ?? []).length === 0 ? (
        <EmptyState
          icon="eye"
          title={tr('campaigns.emptyTitle')}
          description={tr('campaigns.emptyText')}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
          {(listQ.data?.items ?? []).map((c) => (
            <CampaignRow
              key={c.id}
              c={c}
              onOpen={() => setDetailId(c.id)}
              onSweep={
                c.mode === 'standing' && c.status === 'active' ? () => sweep.mutate(c.id) : undefined
              }
              onCancel={
                c.status === 'active'
                  ? () =>
                      confirm(
                        {
                          title: tr('campaigns.cancelTitle'),
                          message: tr('campaigns.cancelText'),
                          confirmLabel: tc('actions.cancel'),
                          danger: true,
                        },
                        async () => {
                          await cancel.mutateAsync(c.id);
                        },
                      )
                  : undefined
              }
            />
          ))}
        </div>
      )}

      {createOpen && (
        <CreateCampaignModal
          workspaceId={workspaceId}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void qc.invalidateQueries({ queryKey: hrCampaignsKey(workspaceId) });
          }}
        />
      )}
      {detailId && <CampaignDetailModal workspaceId={workspaceId} campaignId={detailId} onClose={() => setDetailId(null)} />}
      {confirmUI}
    </div>
  );
}

function CampaignRow({
  c,
  onOpen,
  onSweep,
  onCancel,
}: {
  c: DocCampaignDto;
  onOpen: () => void;
  onSweep?: () => void;
  onCancel?: () => void;
}) {
  // Справочники кампании общие с КЭДО — слово берём из его неймспейса
  const thr = useTranslations('hr');
  const tr = useTranslations('documents');
  const tc = useTranslations('common');
  const pct = c.total ? Math.round((c.counts.acknowledged / c.total) * 100) : 0;
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 220, flex: 1 }}>
          <div style={{ fontWeight: 700 }}>{c.title}</div>
          <div className="meta" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            <Chip tone={c.status === 'active' ? 'accent' : c.status === 'done' ? 'success' : 'neutral'}>
              {thr(`campaignStatus.${c.status}`)}
            </Chip>
            <Chip tone="neutral">{thr(`campaignFixMode.${c.fixMode}`)}</Chip>
            {c.mode === 'standing' && <Chip tone="warning">{thr('campaignMode.standing')}</Chip>}
            {c.counts.sms_failed > 0 && (
              <Chip tone="danger">{tr('campaigns.smsFailedCount', { count: c.counts.sms_failed })}</Chip>
            )}
          </div>
        </div>
        <div style={{ width: 220 }}>
          <TickBar value={pct} label={tr('campaigns.progress', { done: c.counts.acknowledged, total: c.total })} showValue />
        </div>
        {onSweep && (
          <Button variant="matte" size="sm" icon="refresh" onClick={onSweep}>
            {tr('campaigns.sweep')}
          </Button>
        )}
        <Button variant="matte" size="sm" icon="eye" onClick={onOpen}>
          {tr('campaigns.whoPending')}
        </Button>
        {onCancel && (
          <Button variant="ghost" size="sm" tone="danger" onClick={onCancel}>
            {tc('actions.cancel')}
          </Button>
        )}
      </div>
    </Card>
  );
}

function CampaignDetailModal({
  workspaceId,
  campaignId,
  onClose,
}: {
  workspaceId: string;
  campaignId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const detailQ = useQuery({
    queryKey: hrCampaignKey(workspaceId, campaignId),
    queryFn: () => fetchCampaignDetail(workspaceId, campaignId),
  });
  // «SMS не доставлена» — ручной исход менеджера по конкретному человеку
  const smsFailed = useMutation({
    mutationFn: (userId: string) => markCampaignSmsFailed(workspaceId, campaignId, userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: hrCampaignKey(workspaceId, campaignId) });
      void qc.invalidateQueries({ queryKey: hrCampaignsKey(workspaceId) });
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });
  const thr = useTranslations('hr');
  const tr = useTranslations('documents');
  const d = detailQ.data;
  return (
    <Modal open onClose={onClose} title={d?.title ?? tr('campaigns.one')} subtitle={tr('campaigns.detailSubtitle')} size="md">
      {detailQ.isPending || !d ? (
        <LoadingBlock />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
          <TickBar
            value={d.total ? Math.round((d.counts.acknowledged / d.total) * 100) : 0}
            label={tr('campaigns.progress', { done: d.counts.acknowledged, total: d.total })}
            showValue
          />
          {(['pending', 'sms_failed', 'acknowledged'] as const).map((status) => {
            const all = d.targets.filter((t) => t.status === status);
            // Кампания бывает на 5000 человек — столько карточек вешают вкладку.
            // Показываем первые, остальных называем числом (правило «no silent caps»).
            const rows = all.slice(0, TARGETS_SHOWN);
            if (!all.length) return null;
            return (
              <div key={status}>
                <div className="label-md" style={{ fontWeight: 700, marginBottom: 6 }}>
                  {thr(`campaignTargetStatus.${status}`)} · {all.length}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {rows.map((t) => {
                    const a = d.actors[t.userId];
                    if (!a) return null;
                    return (
                      <span key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <PersonChip size="S" userId={a.id} firstName={a.firstName} lastName={a.lastName} avatar={a.avatar} />
                        {status === 'pending' && d.fixMode === 'sms' && d.status === 'active' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            tone="danger"
                            disabled={smsFailed.isPending}
                            onClick={() => smsFailed.mutate(t.userId)}
                            title={tr('campaigns.markSmsFailed')}
                          >
                            SMS ✕
                          </Button>
                        )}
                      </span>
                    );
                  })}
                  {all.length > rows.length && (
                    <span className="meta">{tr('campaigns.andMore', { count: all.length - rows.length })}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

function CreateCampaignModal({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  // Справочники режимов кампании общие с КЭДО — слово берём из его неймспейса
  const thr = useTranslations('hr');
  const tr = useTranslations('documents');
  const tc = useTranslations('common');
  const [documentId, setDocumentId] = useState('');
  const [audience, setAudience] = useState<Principal[]>([]);
  const [mode, setMode] = useState('one_off');
  const [fixMode, setFixMode] = useState('click');
  const [dueAt, setDueAt] = useState<string | undefined>(undefined);

  // Предмет кампании — документ из реестра (у него должен быть печатный PDF)
  const docsQ = useQuery({
    queryKey: [...hrCampaignsKey(workspaceId), 'doc-options'],
    // Лимит явный: со страницей по умолчанию нужного документа могло не быть в
    // списке вовсе — и выбрать его было нечем.
    queryFn: () => fetchOrgDocuments(workspaceId, { limit: 200 }),
  });
  // ТОЛЬКО изданные: кампания открывает предмет ВСЕМ адресатам, а черновик и
  // документ «на согласовании» — внутренняя кухня работодателя (то же правило,
  // по которому черновик приказа не виден его стороне).
  const docs: OrgDocumentDto[] = (docsQ.data?.items ?? []).filter((doc) =>
    ['signed', 'registered', 'active'].includes(doc.status),
  );

  const create = useMutation({
    mutationFn: () => {
      if (!documentId) throw new Error(tr('campaigns.pickDocument'));
      if (!audience.length) throw new Error(tr('campaigns.pickAudience'));
      const dto: CreateCampaignInput = {
        orgDocumentId: documentId,
        mode: mode as CreateCampaignInput['mode'],
        fixMode: fixMode as CreateCampaignInput['fixMode'],
        audience: audience.map((p) => ({ type: p.type as CreateCampaignInput['audience'][number]['type'], id: p.id })),
        ...(dueAt ? { dueAt } : {}),
      };
      return createCampaign(workspaceId, dto);
    },
    onSuccess: onCreated,
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={tr('campaigns.start')}
      subtitle={tr('campaigns.cap', { max: HR_LIMITS.campaignMaxTargets })}
      size="md"
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-4)' }}>
        <Select
          label={tr('campaigns.documentLabel')}
          value={documentId}
          onChange={setDocumentId}
          options={docs.map((doc) => ({ value: doc.id, label: doc.number ? `${doc.title} № ${doc.number}` : doc.title }))}
          placeholder={
            docsQ.isPending
              ? tc('state.loading')
              : docs.length
                ? tr('campaigns.pickDocument')
                : tr('campaigns.noIssuedDocs')
          }
          hint={tr('campaigns.documentHint')}
        />
        <div>
          <div className="label-md" style={{ marginBottom: 6 }}>{tr('campaigns.audience')}</div>
          <EntitySelector
            types={['user', 'position', 'department', 'branch', 'workspace']}
            value={audience}
            onChange={setAudience}
            context={{ workspaceId }}
            placeholder={tr('campaigns.audiencePlaceholder')}
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--spacing-3)' }}>
          <Select
            label={tr('campaigns.mode')}
            value={mode}
            onChange={setMode}
            options={CAMPAIGN_MODES.map((m) => ({ value: m, label: thr(`campaignMode.${m}`) }))}
            hint={tr('campaigns.modeHint')}
          />
          <Select
            label={tr('campaigns.fixMode')}
            value={fixMode}
            onChange={setFixMode}
            options={CAMPAIGN_FIX_MODES.map((m) => ({ value: m, label: thr(`campaignFixMode.${m}`) }))}
          />
        </div>
        {fixMode === 'sms' ? (
          <Alert tone="warning">{tr('campaigns.smsCostHint')}</Alert>
        ) : (
          <Alert tone="accent">{tr('campaigns.clickHint')}</Alert>
        )}
        <DatePicker label={tr('campaigns.dueAt')} value={isoToDate(dueAt)} onChange={(d) => setDueAt(dateToIso(d))} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--spacing-2)' }}>
          <Button variant="ghost" onClick={onClose}>{tc('actions.cancel')}</Button>
          <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
            {tr('campaigns.launch')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
