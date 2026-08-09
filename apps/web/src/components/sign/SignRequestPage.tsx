'use client';

/**
 * Карточка подписания — ОДИН компонент на ДВА адреса (как `ApprovalCard`):
 * `/workspaces/[id]/sign/[signId]` у рабочей заявки и `/sign/[id]` у личной.
 *
 * Сюда ведут уведомления «Подпишите документ». Адрес собирает общий
 * `signRequestHref(requestId, workspaceId?)` из shared, и строкой на месте его
 * собирать нельзя: у approvals это ровно так и кончилось — КАЖДОЕ уведомление
 * вело в 404, потому что адрес собирали в двух местах, а страницы с таким путём
 * в вебе не было вовсе.
 *
 * Рабочая заявка, открытая по личному адресу, переезжает в свою организацию:
 * каркас выводит контекст «Личное / Организация» РОВНО из пути, и иначе человек
 * смотрел бы рабочий приказ в личном сайдбаре.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  SIGN_ACT_STATUS_LABELS,
  SIGN_LEVEL_LABELS,
  SIGN_METHOD_LABELS,
  signRequestHref,
} from '@superapp/shared';
import { Alert, Button, Card, CardHeader, Chip, Icon, LoadingBlock, PageHeader } from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiErrorMessage } from '@/lib/api';
import { fetchSignFlow, signFlowKey } from './sign-api';
import { SignFlowModal } from './SignFlowModal';

export function SignRequestPage({
  id,
  contextWorkspaceId,
}: {
  id: string;
  /** Организация из АДРЕСА; null — открыто по личному пути */
  contextWorkspaceId?: string | null;
}) {
  const { isReady: ready } = useRequireAuth();
  const router = useRouter();
  const [signing, setSigning] = useState(false);

  const q = useQuery({
    queryKey: signFlowKey(id),
    queryFn: () => fetchSignFlow(id),
    enabled: ready,
  });

  const workspaceId = q.data?.request.workspaceId ?? null;
  useEffect(() => {
    if (!contextWorkspaceId && workspaceId) router.replace(signRequestHref(id, workspaceId));
  }, [contextWorkspaceId, workspaceId, id, router]);

  if (!ready || q.isPending) return <LoadingBlock />;
  if (q.isError || !q.data) return <Alert tone="danger">{apiErrorMessage(q.error)}</Alert>;

  const { request, subject, myAct, canSign } = q.data;

  return (
    <>
      <PageHeader
        breadcrumb="Подписание"
        title={request.refTitle}
        actions={
          <Button variant="matte" href={subject.url} icon="eye">
            Открыть документ
          </Button>
        }
      />

      <Card>
        <CardHeader
          title={SIGN_LEVEL_LABELS[request.level].short}
          subtitle={SIGN_LEVEL_LABELS[request.level].full}
        />
        {/* Отпечаток показываем всегда: он — единственное, чем «этот документ»
            отличается от «похожего документа», и он же печатается в протоколе. */}
        <div className="meta" style={{ wordBreak: 'break-all' }}>
          Отпечаток SHA-256: {subject.sha256}
        </div>

        {canSign && (
          <div style={{ marginTop: 'var(--spacing-3)' }}>
            <Button variant="primary" icon="signature" onClick={() => setSigning(true)}>
              {request.level === 'ecp' ? 'Подписать ЭЦП' : 'Подписать'}
            </Button>
          </div>
        )}
        {myAct && !canSign && (
          <div style={{ marginTop: 'var(--spacing-3)' }}>
            <Alert tone={myAct.status === 'signed' ? 'success' : 'warning'}>
              {SIGN_ACT_STATUS_LABELS[myAct.status]}
              {myAct.declineReason ? `: ${myAct.declineReason}` : ''}
            </Alert>
          </div>
        )}
      </Card>

      <Card style={{ marginTop: 'var(--spacing-3)' }}>
        <CardHeader title="Подписи" subtitle={`Всего подписантов: ${request.acts.length}`} />
        <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
          {request.acts.map((act) => {
            const actor = act.signerUserId ? request.actors[act.signerUserId] : undefined;
            return (
              <div
                key={act.id}
                style={{
                  display: 'grid',
                  gap: 4,
                  padding: 'var(--spacing-2) var(--spacing-3)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-item)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                  {actor ? (
                    <PersonChip
                      size="S"
                      userId={act.signerUserId}
                      firstName={actor.firstName}
                      lastName={actor.lastName}
                      avatar={actor.avatar}
                    />
                  ) : (
                    <span>
                      <Icon name="people" size={14} /> {act.signerName}
                      {act.signerPhoneMasked ? ` · ${act.signerPhoneMasked}` : ''}
                    </span>
                  )}
                  <Chip
                    size="sm"
                    tone={act.status === 'signed' ? 'success' : act.status === 'pending' ? 'neutral' : 'danger'}
                  >
                    {SIGN_ACT_STATUS_LABELS[act.status]}
                  </Chip>
                </div>
                {act.status === 'signed' && (
                  <div className="meta">
                    {act.method ? SIGN_METHOD_LABELS[act.method].title : SIGN_LEVEL_LABELS[act.level].short}
                    {act.signedAt ? ` · ${new Date(act.signedAt).toLocaleString('ru-RU')}` : ''}
                  </div>
                )}
                {act.checkUrl && (
                  <a className="meta" href={act.checkUrl} target="_blank" rel="noreferrer">
                    Проверить подпись
                  </a>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {signing && (
        <SignFlowModal
          requestId={id}
          onClose={() => setSigning(false)}
          onSigned={() => void q.refetch()}
        />
      )}
    </>
  );
}
