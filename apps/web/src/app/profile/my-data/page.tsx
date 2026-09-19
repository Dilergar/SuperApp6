'use client';

// ============================================================
// «Мои данные» (ЗоПД ст. 8-2: согласие/отказ, уведомление о действиях с ПДн и о доступе
// третьих лиц): на что человек соглашался и кому передавались его данные.
//  - Согласия: статус — Chip, действие — Button; принятая и действующая версии, «Лист согласия»;
//    тумблеры отзывных (`marketing`, `analytics`); согласие на обработку ПДн отзывается
//    только удалением аккаунта — вторая дверь к мастеру удаления.
//  - Кому передавались мои данные: лента учёта действий с ПДн (`PdActionRecord`).
// ============================================================

import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import type { ConsentAcceptResultDto, ConsentDocumentKey, ConsentReceiptDto, ConsentStateItemDto, CursorPage, Locale, PdTransferDto } from '@superapp/shared';
import { Alert, Button, Card, Chip, EmptyState, LoadingBlock, Modal, Toggle, type Tone } from '@/components/ui';
import { ConsentDocumentModal } from '@/components/consents/ConsentDocumentModal';
import { analytics } from '@/lib/analytics';
import { apiErrorMessage, apiGet, apiPost } from '@/lib/api';
import { useFormatters } from '@/lib/format';
import { analyticsConsentKey, consentReceiptKey, consentsMineRootKey, consentsStateKey, consentTransfersKey } from '@/lib/queries';
import { toastError } from '@/lib/toast';

const STATUS_TONE: Record<ConsentStateItemDto['status'], Tone> = {
  accepted: 'success',
  outdated: 'waiting',
  declined: 'neutral',
  none: 'neutral',
  default_on: 'accent',
};

export default function MyDataPage() {
  const t = useTranslations('consents');
  const shell = useTranslations('shell');
  const fmt = useFormatters();
  const locale = useLocale() as Locale;
  const qc = useQueryClient();
  const [openDoc, setOpenDoc] = useState<{ versionId?: string; documentKey: ConsentDocumentKey } | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);

  const state = useQuery({ queryKey: consentsStateKey, queryFn: () => apiGet<ConsentStateItemDto[]>('/consents/state') });

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: consentsMineRootKey });
    await qc.invalidateQueries({ queryKey: analyticsConsentKey });
  };
  const accept = useMutation({
    mutationFn: (item: ConsentStateItemDto) => apiPost<ConsentAcceptResultDto>('/consents/accept', { versionIds: [item.currentVersionId], locale, channel: 'web' }),
    onSuccess: async (_res, item) => {
      // SDK аналитики держит отказ и у себя: тумблер обязан дойти до него сразу, а не после F5
      if (item.documentKey === 'analytics') analytics.setOptOut(false);
      await refresh();
    },
    onError: (err) => toastError(apiErrorMessage(err)),
  });
  const revoke = useMutation({
    mutationFn: (item: ConsentStateItemDto) => apiPost<{ revoked: number }>('/consents/revoke', { documentKey: item.documentKey }),
    onSuccess: async (_res, item) => {
      if (item.documentKey === 'analytics') analytics.setOptOut(true);
      await refresh();
    },
    onError: (err) => toastError(apiErrorMessage(err)),
  });
  const busy = accept.isPending || revoke.isPending;

  return (
    <div>
      <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-2)' }}>{t('myData.title')}</h2>
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-6)' }}>{t('myData.subtitle')}</p>

      <h3 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>{t('myData.consentsTitle')}</h3>
      {state.isLoading && <LoadingBlock />}
      {state.isError && <Alert tone="danger">{apiErrorMessage(state.error)}</Alert>}
      <div className="ui-stack" style={{ gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-8)' }}>
        {(state.data ?? []).map((item) => {
          const on = item.status === 'accepted' || item.status === 'outdated' || item.status === 'default_on';
          const toggleable = item.revocable && !!item.currentVersionId;
          return (
            <Card key={item.documentKey}>
              <div className="my-data-row">
                <div className="my-data-row-main">
                  <div className="my-data-row-title">
                    <span style={{ fontWeight: 700 }}>{shell(`consents.documents.${item.documentKey}`)}</span>
                    <Chip size="sm" tone={STATUS_TONE[item.status]}>{t(`myData.status.${item.status}`)}</Chip>
                    <Chip size="sm" tone="neutral">{item.required ? t('myData.required') : t('myData.optional')}</Chip>
                  </div>
                  <p className="label-sm" style={{ margin: 0 }}>
                    {item.acceptedVersion !== null && item.acceptedAt
                      ? t('myData.acceptedVersion', { version: item.acceptedVersion, date: fmt.date(item.acceptedAt) })
                      : item.currentVersion !== null
                        ? t('myData.currentVersion', { version: item.currentVersion })
                        : null}
                  </p>
                  {item.documentKey === 'privacy' && <p className="label-sm" style={{ margin: 0 }}>{t('myData.privacyNote')}</p>}
                </div>
                <div className="my-data-row-actions">
                  <Button size="sm" variant="ghost" onClick={() => setOpenDoc({ documentKey: item.documentKey, versionId: item.currentVersionId ?? undefined })}>{t('myData.read')}</Button>
                  {item.acceptanceId && <Button size="sm" variant="ghost" icon="sealCheck" onClick={() => setReceiptId(item.acceptanceId)}>{t('myData.receipt')}</Button>}
                  {/* Обязательный документ без приёмки (аккаунты прошлой эпохи, уведомительная политика): принять здесь же */}
                  {item.status === 'none' && item.required && item.currentVersionId && <Button size="sm" variant="matte" tone="accent" disabled={busy} onClick={() => accept.mutate(item)}>{shell('consents.gate.accept')}</Button>}
                  {item.status === 'outdated' && <Button size="sm" variant="matte" tone="waiting" disabled={busy} onClick={() => accept.mutate(item)}>{t('myData.acceptNew')}</Button>}
                  {toggleable && (
                    <Toggle
                      checked={on}
                      disabled={busy}
                      aria-label={shell(`consents.documents.${item.documentKey}`)}
                      onChange={(next) => (next ? accept.mutate(item) : revoke.mutate(item))}
                    />
                  )}
                  {item.documentKey === 'privacy' && <Button size="sm" variant="outline" tone="danger" href="/account/delete">{t('myData.deleteAccount')}</Button>}
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <TransfersSection />

      <ConsentDocumentModal open={!!openDoc} onClose={() => setOpenDoc(null)} versionId={openDoc?.versionId} documentKey={openDoc?.documentKey} />
      {receiptId && <ReceiptModal acceptanceId={receiptId} onClose={() => setReceiptId(null)} />}
    </div>
  );
}

// ------------------------------------------------------------
// Кому передавались мои данные
// ------------------------------------------------------------

function TransfersSection() {
  const t = useTranslations('consents');
  const common = useTranslations('common');
  const fmt = useFormatters();
  const feed = useInfiniteQuery({
    queryKey: consentTransfersKey,
    queryFn: ({ pageParam }) => apiGet<CursorPage<PdTransferDto>>('/consents/my-data/transfers', { params: pageParam ? { cursor: pageParam } : {} }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section aria-labelledby="my-data-transfers">
      <h3 id="my-data-transfers" className="title-md" style={{ marginBottom: 'var(--spacing-2)' }}>{t('myData.transfersTitle')}</h3>
      <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)' }}>{t('myData.transfersHint')}</p>
      {feed.isLoading && <LoadingBlock />}
      {feed.isError && <Alert tone="danger">{t('myData.loadFailed')}</Alert>}
      {!feed.isLoading && !items.length && !feed.isError && <EmptyState icon="shield" title={t('myData.transfersEmpty')} />}
      <ul className="my-data-transfers">
        {items.map((x) => (
          <li key={x.id}>
            <div className="my-data-transfer-head">
              <span style={{ fontWeight: 700 }}>{x.recipientName ?? t('myData.byYou')}</span>
              {x.crossBorder && <Chip size="sm" tone="warning" icon="globe">{t('myData.crossBorder')}</Chip>}
              <span className="label-sm" style={{ marginLeft: 'auto' }}>{fmt.dateTime(x.occurredAt)}</span>
            </div>
            <p className="label-sm" style={{ margin: 0 }}>
              {t(`purposes.${x.purpose}`)}
              {x.fields.length > 0 && <> · {fmt.list(x.fields.map((f) => t(`fields.${f}`)))}</>}
            </p>
          </li>
        ))}
      </ul>
      {feed.hasNextPage && (
        <Button variant="ghost" onClick={() => void feed.fetchNextPage()} loading={feed.isFetchingNextPage} style={{ marginTop: 'var(--spacing-3)' }}>
          {common('actions.loadMore')}
        </Button>
      )}
    </section>
  );
}

// ------------------------------------------------------------
// «Лист согласия» — 8 реквизитов ЗоПД ст. 8 п. 4
// ------------------------------------------------------------

function ReceiptModal({ acceptanceId, onClose }: { acceptanceId: string; onClose: () => void }) {
  const t = useTranslations('consents');
  const shell = useTranslations('shell');
  const fmt = useFormatters();
  const q = useQuery({ queryKey: consentReceiptKey(acceptanceId), queryFn: () => apiGet<ConsentReceiptDto>(`/consents/receipt/${acceptanceId}`) });
  const r = q.data;
  const fields = (codes: string[]) => fmt.list(codes.map((f) => t(`fields.${f}`)));

  return (
    <Modal open onClose={onClose} size="lg" title={t('receipt.title')} footer={<Button variant="ghost" icon="file" onClick={() => window.print()}>{shell('consents.viewer.print')}</Button>}>
      {q.isLoading && <LoadingBlock />}
      {q.isError && <Alert tone="danger">{apiErrorMessage(q.error)}</Alert>}
      {r && (
        <dl className="receipt">
          <dt>{t('receipt.document')}</dt>
          <dd>{shell(`consents.documents.${r.documentKey}`)} · {shell('consents.viewer.version', { version: r.version })}</dd>
          <dt>{t('receipt.operator')}</dt>
          <dd>{r.operator.legalName}, {t('receipt.bin')} {r.operator.bin}<br />{r.operator.address}<br />{r.operator.privacyEmail}</dd>
          <dt>{t('receipt.subject')}</dt>
          <dd>{r.subject.fullName}{r.subject.actorFullName ? <><br />{t('receipt.actor')}: {r.subject.actorFullName}</> : null}</dd>
          <dt>{t('receipt.term')}</dt>
          <dd>{t(`receipt.termValue.${r.term.until}`)}</dd>
          <dt>{t('receipt.thirdParties')}</dt>
          <dd>{r.thirdParties.length ? r.thirdParties.map((x) => <div key={x.key}>{x.name} — {fields(x.fields)}</div>) : t('receipt.no')}</dd>
          <dt>{t('receipt.crossBorder')}</dt>
          <dd>{r.crossBorder.length ? r.crossBorder.map((x) => <div key={x.key}>{x.name}{x.country ? ` (${x.country})` : ''} — {fields(x.fields)}</div>) : t('receipt.no')}</dd>
          <dt>{t('receipt.publication')}</dt>
          <dd>{r.publication ? t('receipt.publicationYes') : t('receipt.no')}</dd>
          <dt>{t('receipt.dataFields')}</dt>
          <dd>{r.dataFields.length ? fields(r.dataFields) : t('receipt.no')}</dd>
          <dt>{t('receipt.acceptedAt')}</dt>
          <dd>{fmt.dateTime(r.acceptedAt)} · {t('receipt.channel')}: {t(`receipt.channels.${r.channel}`)} · {t('receipt.language')}: {r.locale}</dd>
          {r.revokedAt && (<><dt>{t('receipt.revokedAt')}</dt><dd>{fmt.dateTime(r.revokedAt)}</dd></>)}
          <dt>{t('receipt.contentHash')}</dt>
          <dd className="receipt-mono">{r.contentHash}</dd>
          <dt>{t('receipt.signature')}</dt>
          <dd><Chip size="sm" tone={r.signatureValid ? 'success' : 'danger'}>{r.signatureValid ? t('receipt.signatureValid') : t('receipt.signatureInvalid')}</Chip></dd>
        </dl>
      )}
    </Modal>
  );
}
