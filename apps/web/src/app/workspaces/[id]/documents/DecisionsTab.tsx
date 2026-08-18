'use client';

// ============================================================
// «Ждут решения» внутри Документов — та же стопка, что в топбаре и на Главной.
//
// Отдельного списка решений здесь НЕТ намеренно: витрина одна (`core/approvals`),
// и второй её экземпляр со своей вёрсткой немедленно разъехался бы с первым.
// Раздел — это вход в общую стопку, отфильтрованный организацией.
// ============================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchInbox } from '@/lib/approvals-api';
import { approvalInboxKey } from '@/lib/queries';
import { BentoGrid, Button, Card, CardHeader, Chip, EmptyState, LoadingBlock } from '@/components/ui';
import { DecisionStack } from '@/components/approvals/DecisionStack';
import { MyApprovalsList } from '@/components/approvals/MyApprovalsList';

export function DecisionsTab({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  // Раздел живёт ВНУТРИ организации — и решения показывает только её
  const scope = { workspaceId };

  const inboxQuery = useQuery({
    queryKey: approvalInboxKey(scope),
    queryFn: () => fetchInbox(scope),
  });

  const items = inboxQuery.data?.items ?? [];

  return (
    <>
      <BentoGrid style={{ marginTop: 'var(--gap-grid)' }}>
        <Card span={12}>
          {inboxQuery.isPending ? (
            <LoadingBlock />
          ) : inboxQuery.isError ? (
            <EmptyState
              icon="warningCircle"
              title="Не удалось загрузить стопку решений"
              action={
                <Button variant="matte" icon="refresh" onClick={() => inboxQuery.refetch()}>
                  Повторить
                </Button>
              }
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon="check"
              title="Ничего не ждёт вашего решения"
              description="Здесь появятся документы, которые надо согласовать, подписать или прочитать."
            />
          ) : (
            <div style={{ display: 'grid', gap: 'var(--spacing-2)' }}>
              {items.map((item, i) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setOpen(true)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap', // телефон: чипы переносятся, а не распирают страницу
                    gap: 'var(--spacing-3)',
                    width: '100%',
                    textAlign: 'left',
                    padding: 'var(--spacing-3)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)',
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{item.title}</div>
                    {item.subtitle && (
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{item.subtitle}</div>
                    )}
                  </div>
                  {item.overdue && (
                    <Chip size="sm" tone="danger">
                      Просрочено
                    </Chip>
                  )}
                  {i === 0 && (
                    <Chip size="sm" tone="accent">
                      Разобрать
                    </Chip>
                  )}
                </button>
              ))}
              <div style={{ marginTop: 'var(--spacing-3)' }}>
                <Button icon="check" onClick={() => setOpen(true)}>
                  Разобрать стопку
                </Button>
              </div>
            </div>
          )}
        </Card>

        {/* Обратная сторона: не «что ждёт меня», а «где то, что отправил я».
            Список — тот же компонент, что и в модалке стопки. */}
        <Card span={12}>
          <CardHeader title="Мои заявки" subtitle="Что вы отправили и у кого оно сейчас" />
          <MyApprovalsList scope={scope} />
        </Card>
      </BentoGrid>

      <DecisionStack open={open} onClose={() => setOpen(false)} scope={scope} />
    </>
  );
}
