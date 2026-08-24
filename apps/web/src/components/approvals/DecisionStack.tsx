'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalDecisionKind, InboxItemDto } from '@superapp/shared';
import { APPROVAL_INBOX_TITLE } from '@superapp/shared';
import { Button, Card, EmptyState, Icon, Input, LoadingBlock, Modal, Tabs } from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { approvalInboxKey, approvalsRootKey, type ApprovalScope } from '@/lib/queries';
import { decideApproval, fetchInbox } from '@/lib/approvals-api';
import { acknowledgeCampaign } from '@/lib/hr-api';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { MyApprovalsList } from './MyApprovalsList';
import { SignStepModal } from '@/components/sign/SignStepModal';

/**
 * Стопка «Ждут решения» — одна модалка на всё приложение.
 *
 * Листается по одному: человек видит предмет, маршрут и кнопки, решает и сразу
 * попадает на следующее. Элемент рисуется по ОБЩЕЙ форме реестра источников —
 * поэтому когда рядом с согласованиями встанут очереди отделов и приёмка задач,
 * этот файл меняться не будет.
 */
export function DecisionStack({
  open,
  onClose,
  scope,
}: {
  open: boolean;
  onClose: () => void;
  /** Чей вопрос: сквозной (топбар), личный (Главная) или организации. См. ApprovalScope */
  scope?: ApprovalScope;
}) {
  const qc = useQueryClient();
  const [index, setIndex] = useState(0);
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState<ApprovalDecisionKind | null>(null);
  // Вторая сторона того же вопроса: «что ждёт меня» и «где то, что отправил я».
  // Здесь, а не отдельной страницей: стопка открывается из топбара с любого
  // экрана, и «мои заявки» обязаны быть доступны оттуда же — иначе автор узнаёт
  // об исходе только из уведомления.
  const [tab, setTab] = useState<'inbox' | 'mine'>('inbox');
  // Шаг, который человек пошёл ПОДПИСЫВАТЬ: подпись собирается своим окном
  // (соглашение сторон, код или ключ ЭЦП), а не нажатием кнопки в списке.
  const [signingStepId, setSigningStepId] = useState<string | null>(null);

  const inboxQ = useQuery({
    queryKey: approvalInboxKey(scope),
    queryFn: () => fetchInbox(scope),
    enabled: open,
  });

  const items = useMemo(() => inboxQ.data?.items ?? [], [inboxQ.data]);
  const item: InboxItemDto | undefined = items[index];

  // Список сжимается под ногами: решённое исчезает, и индекс должен остаться в
  // пределах. Держим его на последнем, а не сбрасываем в начало — иначе человек,
  // разгребающий стопку с середины, каждый раз возвращался бы к первому элементу.
  useEffect(() => {
    if (index > 0 && index >= items.length) setIndex(Math.max(0, items.length - 1));
  }, [items.length, index]);

  useEffect(() => {
    setComment('');
    setPending(null);
  }, [item?.id]);

  const decide = useMutation({
    // Кнопки исполняет ИСТОЧНИК элемента: заявка движка решений — своей ручкой,
    // кампания ознакомления КЭДО — своей («Ознакомлен» = фиксация клика).
    mutationFn: async (decision: ApprovalDecisionKind): Promise<void> => {
      if (item!.sourceKey === 'hr_campaign') {
        await acknowledgeCampaign(item!.id);
        return;
      }
      await decideApproval(item!.id, { decision, comment: comment || undefined });
    },
    onSuccess: () => {
      // Префикс — обновляются и стопка, и счётчик бейджа, и «мои заявки»
      void qc.invalidateQueries({ queryKey: approvalsRootKey });
      setComment('');
      setPending(null);
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const needsComment = pending ? (item?.actions.find((a) => a.key === pending)?.commentRequired ?? false) : false;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={APPROVAL_INBOX_TITLE}
      subtitle={tab === 'inbox' && items.length > 0 ? `${index + 1} из ${items.length}` : undefined}
      size="md"
    >
      <div style={{ marginBottom: 'var(--spacing-4)' }}>
        <Tabs
          aria-label="Решения"
          value={tab}
          onChange={setTab}
          items={[
            { key: 'inbox', label: 'На мне', icon: 'checkCircle', count: items.length },
            { key: 'mine', label: 'Мои заявки', icon: 'send' },
          ]}
        />
      </div>

      {tab === 'mine' ? (
        <MyApprovalsList scope={scope} />
      ) : inboxQ.isPending ? (
        <LoadingBlock />
      ) : inboxQ.isError ? (
        <EmptyState
          icon="warningCircle"
          title="Стопка не загрузилась"
          description="Это сбой связи, а не пустая стопка."
          action={
            <Button variant="matte" icon="refresh" onClick={() => inboxQ.refetch()}>
              Повторить
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState icon="checkCircle" title="Ничего не ждёт" description="Все решения приняты." />
      ) : item ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-4)' }}>
          <Card>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--spacing-3)' }}>
              <Icon name="file" size={22} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="title-sm" style={{ wordBreak: 'break-word' }}>
                  {item.title}
                </div>
                {item.subtitle && <div className="meta">{item.subtitle}</div>}
                <div style={{ display: 'flex', gap: 'var(--spacing-3)', marginTop: '0.4rem', flexWrap: 'wrap' }}>
                  {item.dueAt && (
                    <span className="meta" style={item.overdue ? { color: 'var(--danger-text)' } : undefined}>
                      {item.overdue ? 'Просрочено' : 'Срок'} · {new Date(item.dueAt).toLocaleString('ru-RU')}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {item.requestedById && inboxQ.data?.actors[item.requestedById] && (
              <div style={{ marginTop: 'var(--spacing-3)' }}>
                <span className="meta">Просит: </span>
                <PersonChip
                  size="S"
                  userId={item.requestedById}
                  firstName={inboxQ.data.actors[item.requestedById].firstName}
                  lastName={inboxQ.data.actors[item.requestedById].lastName}
                  avatar={inboxQ.data.actors[item.requestedById].avatar}
                />
              </div>
            )}

            {item.href && (
              <div style={{ marginTop: 'var(--spacing-3)' }}>
                <Button variant="ghost" size="sm" href={item.href} icon="eye">
                  Открыть целиком
                </Button>
              </div>
            )}
          </Card>

          {needsComment && (
            <Input
              label="Причина"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Что именно поправить"
              autoFocus
            />
          )}

          {/* Шаг, который закрывается ПОДПИСЬЮ, кнопок решения не имеет: подпись
              собирается на своём экране — соглашение сторон, код или ключ ЭЦП.
              Сервер такой шаг обычным решением тоже не закроет. */}
          {item.signRequirement && (
            <Button
              variant="primary"
              icon="signature"
              onClick={() => setSigningStepId(item.id)}
            >
              {item.signRequirement === 'ecp' ? 'Подписать ЭЦП' : 'Подписать'}
            </Button>
          )}

          <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
            {item.actions.map((action) => {
              const armed = pending === action.key;
              return (
                <Button
                  key={action.key}
                  variant={action.tone === 'primary' ? 'primary' : 'matte'}
                  tone={action.tone === 'danger' ? 'danger' : 'accent'}
                  loading={decide.isPending && armed}
                  disabled={decide.isPending || (armed && action.commentRequired && !comment.trim())}
                  onClick={() => {
                    // Причина обязательна → первый клик раскрывает поле, второй
                    // отправляет: иначе отказ уходил бы пустым мимо валидации сервера.
                    if (action.commentRequired && !armed) {
                      setPending(action.key as ApprovalDecisionKind);
                      return;
                    }
                    decide.mutate(action.key as ApprovalDecisionKind);
                  }}
                >
                  {action.label}
                </Button>
              );
            })}
          </div>

          {items.length > 1 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Button
                variant="ghost"
                size="sm"
                icon="arrowLeft"
                disabled={index === 0}
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
              >
                Назад
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconRight="arrowRight"
                disabled={index >= items.length - 1}
                onClick={() => setIndex((i) => Math.min(items.length - 1, i + 1))}
              >
                Следующее
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {signingStepId && (
        <SignStepModal
          stepId={signingStepId}
          onClose={() => setSigningStepId(null)}
          onSigned={() => {
            void qc.invalidateQueries({ queryKey: approvalsRootKey });
            // Очередь подписания «N из M» (мастер онбординг-пакета сотрудника и
            // очередь работодателя на пачку приказов): следующий подписной шаг
            // открывается САМ — 200 приказов не требуют 200 ручных заходов.
            // Список ещё не перезагружен — следующий кандидат считается по
            // текущему снимку без только что подписанного шага.
            const rest = items.filter((i) => i.id !== signingStepId);
            const next = rest[Math.min(index, Math.max(0, rest.length - 1))];
            setSigningStepId(next?.signRequirement ? next.id : null);
          }}
        />
      )}
    </Modal>
  );
}
