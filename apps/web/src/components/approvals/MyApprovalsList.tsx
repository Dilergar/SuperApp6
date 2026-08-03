'use client';

// ============================================================
// «Мои заявки» — обратная сторона стопки: не «что ждёт меня», а «где сейчас то,
// что я отправил». Без этого экрана человек, нажавший «Отправить на маршрут»,
// узнавал об исходе только из уведомления и не мог ни посмотреть этап, ни
// отозвать заявку.
//
// Компонент ОДИН на все витрины (модалка стопки, раздел Документов): второй
// список с той же семантикой немедленно разъехался бы с первым — ровно то, чего
// движок избегает реестром источников на стороне сервера.
// ============================================================

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalMineDto } from '@superapp/shared';
import { APPROVAL_REQUEST_STATUS_LABELS } from '@superapp/shared';
import { Button, Chip, EmptyState, Icon, LoadingBlock, SegmentedControl } from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { myApprovalsKey, approvalsRootKey, type ApprovalScope } from '@/lib/queries';
import { cancelApproval, fetchMyApprovals } from '@/lib/approvals-api';
import { apiErrorMessage } from '@/lib/api';
import { toastError } from '@/lib/toast';

/** Корзина списка. Со скоупом движка (чьи заявки) не путать — это «какие» */
type Bucket = 'active' | 'archived';

const STATUS_TONE: Record<string, 'accent' | 'success' | 'danger' | 'warning' | 'neutral'> = {
  pending: 'accent',
  approved: 'success',
  rejected: 'danger',
  returned: 'warning',
  cancelled: 'neutral',
};

export function MyApprovalsList({ scope }: { scope?: ApprovalScope }) {
  const qc = useQueryClient();
  const [bucket, setBucket] = useState<Bucket>('active');
  // Отзыв необратим, поэтому спрашиваем — но НЕ вложенной модалкой: список живёт
  // и внутри модалки стопки, а диалог поверх диалога ломает ловушку фокуса.
  // Первый клик взводит кнопку, второй отправляет — тот же приём, что у причины
  // отказа в самой стопке.
  const [armed, setArmed] = useState<string | null>(null);

  const archived = bucket === 'archived';
  const listQ = useQuery({
    queryKey: myApprovalsKey(scope, archived),
    queryFn: () => fetchMyApprovals(scope, { archived }),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => cancelApproval(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: approvalsRootKey });
      setArmed(null);
    },
    onError: (e) => toastError(apiErrorMessage(e)),
  });

  const items = listQ.data?.items ?? [];
  const actors = listQ.data?.actors ?? {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
      <SegmentedControl
        aria-label="Какие заявки показать"
        value={bucket}
        onChange={setBucket}
        items={[
          { key: 'active', label: 'В работе' },
          { key: 'archived', label: 'Завершённые' },
        ]}
      />

      {listQ.isPending ? (
        <LoadingBlock />
      ) : items.length === 0 ? (
        <EmptyState
          icon="send"
          title={archived ? 'Завершённых заявок нет' : 'Вы ничего не отправляли'}
          description={
            archived
              ? 'Сюда попадают согласованные, отклонённые и отменённые заявки.'
              : 'Отправьте документ на маршрут — и увидите здесь, у кого он сейчас.'
          }
        />
      ) : (
        <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
          {items.map((r) => (
            <Row
              key={r.id}
              item={r}
              actors={actors}
              armed={armed === r.id}
              busy={cancel.isPending && armed === r.id}
              onArm={() => setArmed(r.id)}
              onCancel={() => cancel.mutate(r.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  item,
  actors,
  armed,
  busy,
  onArm,
  onCancel,
}: {
  item: ApprovalMineDto;
  actors: Record<string, { firstName: string; lastName: string | null; avatar: string | null }>;
  armed: boolean;
  busy: boolean;
  onArm: () => void;
  onCancel: () => void;
}) {
  const waiting = item.awaitingUserIds.slice(0, 3);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--spacing-3)',
        padding: 'var(--spacing-3)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-item)',
        background: 'var(--surface)',
      }}
    >
      <Icon name="file" size={20} style={{ marginTop: 2, color: 'var(--label)' }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>{item.refTitle}</div>
        {/* У закрытой заявки stageLabel — это и есть её статус, а он уже стоит
            чипом справа. Вместо повтора того же слова показываем, КОГДА закрыли. */}
        <div className="meta">
          {item.status === 'pending'
            ? item.stageLabel
            : item.finishedAt
              ? new Date(item.finishedAt).toLocaleString('ru-RU', {
                  day: 'numeric',
                  month: 'long',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : item.stageLabel}
        </div>

        {waiting.length > 0 && item.status === 'pending' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.4rem', flexWrap: 'wrap' }}>
            <span className="meta">Ждём:</span>
            {/* Человек — карточкой, а не строкой имени (Принцип 2) */}
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
            {item.awaitingUserIds.length > waiting.length && (
              <Chip size="sm" tone="neutral">
                +{item.awaitingUserIds.length - waiting.length}
              </Chip>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
        {item.overdue && (
          <Chip size="sm" tone="danger">
            Просрочено
          </Chip>
        )}
        {item.status !== 'pending' && (
          <Chip size="sm" tone={STATUS_TONE[item.status] ?? 'neutral'}>
            {APPROVAL_REQUEST_STATUS_LABELS[item.status]}
          </Chip>
        )}
        {item.href && (
          <Button variant="ghost" size="sm" href={item.href} icon="eye" aria-label="Открыть предмет заявки" />
        )}
        {item.status === 'pending' && (
          <Button
            variant={armed ? 'matte' : 'ghost'}
            tone={armed ? 'danger' : 'accent'}
            size="sm"
            loading={busy}
            onClick={armed ? onCancel : onArm}
          >
            {armed ? 'Точно отозвать?' : 'Отозвать'}
          </Button>
        )}
      </div>
    </div>
  );
}
