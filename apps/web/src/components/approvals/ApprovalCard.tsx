'use client';

// ============================================================
// Карточка заявки «Ждут решения» — ОДНА реализация на два адреса.
//
// Сюда ведут ВСЕ уведомления движка (`actionUrl`), кнопка «Открыть целиком» в
// стопке и строки «Моих заявок». Доступ к заявке решает её ПРЕДМЕТ, а не место в
// навигации, но САМ адрес всё же обязан нести организацию: каркас приложения
// выводит контекст «Личное / Организация» ровно из пути, и по личному адресу
// человек, открывший заявление сотрудника, оказывался в «Личном» — с личным
// сайдбаром и рабочим документом рядом со своими задачами.
//
// Поэтому маршрутов два (`/approvals/:id` и `/workspaces/:ws/approvals/:id`), а
// компонент один: второй экран с той же семантикой разъехался бы с первым.
//
// Стопка отвечает на «что от меня требуется сейчас», а эта страница — на «как
// устроен маршрут и кто уже ответил»: их задачи разные, поэтому здесь маршрут
// показан целиком, вместе с комментариями и отпечатками решений.
// ============================================================

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { approvalHref } from '@superapp/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useFormatters } from '@/lib/format';
import {
  APPROVAL_DECISIONS_NEEDING_COMMENT,
  APPROVAL_KIND_DECISIONS,
  APPROVAL_STEP_KIND_META,
  type ApprovalDecisionKind,
  type ApprovalStepDto,
  type ApprovalStepKind,
} from '@superapp/shared';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { approvalKey, approvalsRootKey } from '@/lib/queries';
import { cancelApproval, decideApproval, fetchApproval } from '@/lib/approvals-api';

import { PersonChip } from '@/app/circles/PersonCard';
import { SignStepModal } from '@/components/sign/SignStepModal';
import {
  BentoGrid, Button, Card, CardHeader, Chip, EmptyState, Icon, Input, LoadingBlock, PageHeader,
} from '@/components/ui';

import { toastApiError } from '@/lib/api-errors';
import { useIdempotencyKey } from '@/lib/useIdempotencyKey';
import { OutcomeUnknownAlert, SlowRequestNote, useOutcomeUnknown } from '@/components/idempotency/OutcomeUnknownAlert';
const STATUS_TONE: Record<string, 'accent' | 'success' | 'danger' | 'warning' | 'neutral'> = {
  pending: 'accent',
  approved: 'success',
  rejected: 'danger',
  returned: 'warning',
  cancelled: 'neutral',
};

// На КНОПКЕ стоит действие (`approvals.decision.<исход>`), а в истории —
// результат (`approvals.decisionDone.<исход>`): «Отклонить» под уже принятым
// решением читается как призыв.

export function ApprovalCard({
  id,
  contextWorkspaceId,
}: {
  id: string;
  /** Организация, ВНУТРИ которой открыта карточка. Пусто — личный адрес */
  contextWorkspaceId?: string;
}) {
  const t = useTranslations('approvals');
  const { isReady } = useRequireAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const [armed, setArmed] = useState<ApprovalDecisionKind | null>(null);
  const [cancelArmed, setCancelArmed] = useState(false);

  const q = useQuery({ queryKey: approvalKey(id), queryFn: () => fetchApproval(id), enabled: isReady });

  // Рабочая заявка, открытая по личному адресу, переезжает в свою организацию.
  // Это не косметика и не дубль логики адресов: так самолечатся уже разосланные
  // уведомления (их actionUrl записан в БД и переписать его задним числом нельзя)
  // и любая будущая ссылка, собранная без организации. `replace`, а не `push` —
  // иначе «Назад» возвращало бы на тот же адрес и снова сюда.
  const workspaceId = q.data?.workspaceId ?? null;
  useEffect(() => {
    if (!contextWorkspaceId && workspaceId) router.replace(approvalHref(id, workspaceId));
  }, [contextWorkspaceId, workspaceId, id, router]);

  // Шаг, который человек пошёл подписывать (подпись — своё окно, не кнопка списка)
  const [signingStepId, setSigningStepId] = useState<string | null>(null);

  // Ключ НАМЕРЕНИЯ «решить по этой заявке»: решение необратимо, двойной клик
  // обязан дать ОДНО решение. Правка причины — другое намерение (ключ обновится).
  const decideKey = useIdempotencyKey([id, comment]);
  const outcome = useOutcomeUnknown();

  const decide = useMutation({
    mutationFn: (decision: ApprovalDecisionKind) =>
      decideApproval(q.data!.myStepId!, { decision, comment: comment || undefined }, decideKey.key),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: approvalsRootKey });
      decideKey.reset();
      setComment('');
      setArmed(null);
    },
    onError: (e) => {
      // Исход неизвестен — перечитываем заявку: маршрут на ЭТОМ же экране, и он
      // сам покажет, двинулся ли шаг. Отдельная «история» здесь была бы лишней.
      if (outcome.capture(e)) {
        void qc.invalidateQueries({ queryKey: approvalsRootKey });
        return;
      }
      toastApiError(e);
    },
  });

  const cancel = useMutation({
    mutationFn: () => cancelApproval(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: approvalsRootKey });
      setCancelArmed(false);
    },
    onError: (e) => toastApiError(e),
  });

  if (!isReady || q.isPending) return <LoadingBlock />;

  if (q.isError || !q.data) {
    return (
      <>
        <PageHeader breadcrumb={t('inboxTitle')} title={t('card.title')} />
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="checkCircle"
              title={t('card.notOpened')}
              description={t('card.notOpenedHint')}
            />
          </Card>
        </BentoGrid>
      </>
    );
  }

  const req = q.data;
  const myStep = req.steps.find((s) => s.id === req.myStepId);
  const allowed = myStep ? (APPROVAL_KIND_DECISIONS[myStep.kind] ?? []) : [];
  const needsComment = armed ? APPROVAL_DECISIONS_NEEDING_COMMENT.includes(armed) : false;
  // Группы очерёдности: одинаковый order — шаги, идущие одновременно.
  const groups = [...new Set(req.steps.map((s) => s.order))].sort((a, b) => a - b);

  return (
    <>
      <PageHeader
        breadcrumb={t('inboxTitle')}
        title={req.ref?.title ?? req.refTitle}
        chip={
          <Chip tone={STATUS_TONE[req.status] ?? 'neutral'} icon="checkCircle">
            {t(`status.${req.status}`)}
          </Chip>
        }
        actions={
          req.ref?.href ? (
            <Button variant="matte" href={req.ref.href} icon="eye">
              {t('card.openSubject')}
            </Button>
          ) : undefined
        }
      />

      <BentoGrid>
        {/* ---------- Что требуется от меня ---------- */}
        {myStep && (
          <Card span={12}>
            <CardHeader
              title={t(`kind.${myStep.kind}.action`)}
              subtitle={myStep.title}
            />
            {needsComment && (
              <Input
                label={t('reason')}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={t('commentPlaceholder')}
                autoFocus
              />
            )}
            {/* Шаг закрывается ПОДПИСЬЮ — обычные кнопки решения на него не
                действуют (сервер отвергает их кодом approval_needs_signature).
                Подпись собирается своим окном: соглашение, код или ключ ЭЦП. */}
            {myStep.requiredSignatureKind && (
              <div style={{ marginTop: 'var(--spacing-3)' }}>
                <Button variant="primary" icon="signature" onClick={() => setSigningStepId(myStep.id)}>
                  {myStep.requiredSignatureKind === 'ecp' ? t('signEcp') : t('sign')}
                </Button>
              </div>
            )}
            <div
              style={{
                display: myStep.requiredSignatureKind ? 'none' : 'flex',
                gap: 'var(--spacing-2)',
                flexWrap: 'wrap',
                marginTop: 'var(--spacing-3)',
              }}
            >
              {allowed.map((decision) => {
                const isArmed = armed === decision;
                const requiresComment = APPROVAL_DECISIONS_NEEDING_COMMENT.includes(decision);
                return (
                  <Button
                    key={decision}
                    variant={decision === 'approved' ? 'primary' : 'matte'}
                    tone={decision === 'rejected' ? 'danger' : 'accent'}
                    loading={decide.isPending && isArmed}
                    disabled={decide.isPending || (isArmed && requiresComment && !comment.trim())}
                    onClick={() => {
                      // Первый клик раскрывает поле причины, второй отправляет —
                      // иначе отказ уходил бы пустым мимо валидации сервера.
                      if (requiresComment && !isArmed) {
                        setArmed(decision);
                        return;
                      }
                      decide.mutate(decision);
                    }}
                  >
                    {decision === 'approved' ? t(`kind.${myStep.kind}.action`) : t(`decision.${decision}`)}
                  </Button>
                );
              })}
              <SlowRequestNote pending={decide.isPending} />
            </div>
            {/* «Исход неизвестен» тостом не показывают: решение МОГЛО пройти.
                Проверить — в маршруте ниже: там видно, чей сейчас шаг. */}
            <OutcomeUnknownAlert error={outcome.error} onDismiss={outcome.clear} />
          </Card>
        )}

        {/* ---------- Маршрут ---------- */}
        <Card span={12}>
          <CardHeader
            title={t('card.route')}
            subtitle={groups.length > 1 ? t('card.routeSteps', { n: groups.length }) : t('card.routeOneStep')}
            actions={
              req.canCancel ? (
                <Button
                  variant={cancelArmed ? 'matte' : 'ghost'}
                  tone={cancelArmed ? 'danger' : 'accent'}
                  size="sm"
                  loading={cancel.isPending}
                  onClick={() => (cancelArmed ? cancel.mutate() : setCancelArmed(true))}
                >
                  {cancelArmed ? t('card.cancelArmed') : t('card.cancel')}
                </Button>
              ) : undefined
            }
          />
          <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
            {groups.map((order) => (
              <div key={order} style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
                {req.steps
                  .filter((s) => s.order === order)
                  .map((step) => (
                    <StepRow key={step.id} step={step} index={groups.indexOf(order) + 1} actors={req.actors} />
                  ))}
              </div>
            ))}
          </div>
        </Card>
      </BentoGrid>

      {signingStepId && (
        <SignStepModal
          stepId={signingStepId}
          onClose={() => setSigningStepId(null)}
          onSigned={() => {
            void qc.invalidateQueries({ queryKey: approvalsRootKey });
            setSigningStepId(null);
          }}
        />
      )}
    </>
  );
}

const STEP_TONE: Record<string, 'accent' | 'success' | 'danger' | 'warning' | 'neutral'> = {
  waiting: 'neutral',
  active: 'accent',
  approved: 'success',
  rejected: 'danger',
  returned: 'warning',
  skipped: 'neutral',
};

// Слова статусов шага — `approvals.stepStatus.<статус>` в каталоге.

function StepRow({
  step,
  index,
  actors,
}: {
  step: ApprovalStepDto;
  index: number;
  actors: Record<string, { firstName: string; lastName: string | null; avatar: string | null }>;
}) {
  const t = useTranslations('approvals');
  const f = useFormatters();
  const meta = APPROVAL_STEP_KIND_META[step.kind as ApprovalStepKind];
  // Кого ещё ждём: адресаты снимка, от которых решения пока нет.
  const answered = new Set(step.decisions.map((d) => d.userId));
  const waiting = step.awaitingUserIds.filter((u) => !answered.has(u));

  return (
    <div
      style={{
        padding: 'var(--spacing-3)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-item)',
        background: 'var(--surface)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
        <Icon name={(meta?.icon as never) ?? 'checkCircle'} size={18} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>
            {t('card.step', { index, title: step.title })}
          </div>
          <div className="meta">
            {t(`kind.${step.kind}.waiting`)}
            {step.assigneeLabel ? ` · ${step.assigneeLabel}` : ''}
            {step.rule === 'all' ? t('card.everyoneNeeded') : ''}
          </div>
        </div>
        {step.overdue && (
          <Chip size="sm" tone="danger">
            {t('stepOverdue')}
          </Chip>
        )}
        <Chip size="sm" tone={STEP_TONE[step.status] ?? 'neutral'}>
          {t(`stepStatus.${step.status}`)}
        </Chip>
      </div>

      {waiting.length > 0 && step.status === 'active' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: 'var(--spacing-2)', flexWrap: 'wrap' }}>
          <span className="meta">{t('waitingFor')}</span>
          {waiting.map((uid) =>
            actors[uid] ? (
              <PersonChip
                key={uid}
                size="S"
                userId={uid}
                firstName={actors[uid].firstName}
                lastName={actors[uid].lastName}
                avatar={actors[uid].avatar}
              />
            ) : null,
          )}
        </div>
      )}

      {step.decisions.map((d) => (
        <div
          key={d.id}
          style={{
            marginTop: 'var(--spacing-2)',
            paddingTop: 'var(--spacing-2)',
            borderTop: '1px solid var(--border)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
            {actors[d.userId] && (
              <PersonChip
                size="S"
                userId={d.userId}
                firstName={actors[d.userId].firstName}
                lastName={actors[d.userId].lastName}
                avatar={actors[d.userId].avatar}
              />
            )}
            <Chip size="sm" tone={d.decision === 'approved' ? 'success' : d.decision === 'rejected' ? 'danger' : 'warning'}>
              {d.decision === 'approved' ? t(`kind.${step.kind}.done`) : t(`decisionDone.${d.decision}`)}
            </Chip>
            <span className="meta">{f.dateTime(d.decidedAt)}</span>
          </div>
          {d.comment && <div style={{ marginTop: '0.35rem' }}>{d.comment}</div>}
          {/* Отпечаток той версии предмета, под которой стоит решение: без него
              подпись ничего не доказывает — файл могли переписать после. */}
          {d.subjectSha256 && (
            <div className="meta" style={{ marginTop: '0.35rem' }} title={d.subjectSha256}>
              {t('card.fingerprint', { kind: t(`signatureKind.${d.signatureKind}`) })}{' '}
              {d.subjectSha256.slice(0, 12)}…
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
