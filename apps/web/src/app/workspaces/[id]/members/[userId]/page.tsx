'use client';

// ============================================================
// Страница человека в организации (КЭДО, Этап 1): Обзор · Трудовые данные ·
// Хроника. Чужие сервисы дают ВИДЖЕТЫ-ЧИПЫ со счётчиком и переходом к
// источнику («Документы · N»), вкладки вешать не могут — решение грилла.
// ============================================================

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiGet, apiErrorMessage } from '@/lib/api';
import { fetchHrMemberCard, fetchPersonalFileZip, saveHrBlob } from '@/lib/hr-api';
import { toastError } from '@/lib/toast';
import { hrMemberKey } from '@/lib/queries';
import {
  Alert,
  BentoGrid,
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  LoadingBlock,
  PageHeader,
  SegmentedControl,
  type TabItem,
} from '@/components/ui';
import { PersonChip } from '@/app/circles/PersonCard';
import { ChronicleFeed } from '@/components/chatter/ChronicleFeed';
import { SubmitDocumentModal } from '../../documents/SubmitDocumentModal';
import { WORKSPACE_ROLES, type ChatterPageDto, type HrActionKind, type WorkspaceRole } from '@superapp/shared';
import { ActionsCard, EmploymentCard, HrActionModal, fmtMoney } from './member-hr-ui';

type Tab = 'overview' | 'employment' | 'chronicle';

export default function MemberCardPage() {
  const { isReady, user } = useRequireAuth();
  const { id: workspaceId, userId } = useParams<{ id: string; userId: string }>();
  const [tab, setTab] = useState<Tab>('overview');
  const [actionKind, setActionKind] = useState<HrActionKind | null>(null);
  const [docOpen, setDocOpen] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);

  const cardQ = useQuery({
    queryKey: hrMemberKey(workspaceId, userId),
    queryFn: () => fetchHrMemberCard(workspaceId, userId),
    enabled: isReady,
  });

  const chronicleQ = useQuery({
    queryKey: [...hrMemberKey(workspaceId, userId), 'chronicle'],
    queryFn: () => apiGet<ChatterPageDto>(`/chatter/hr_member/${workspaceId}:${userId}`),
    enabled: isReady && tab === 'chronicle' && (cardQ.data?.canSeeEmployment ?? false),
  });

  if (!isReady || cardQ.isPending) return <LoadingBlock />;
  if (cardQ.isError || !cardQ.data) {
    return (
      <EmptyState
        icon="warningCircle"
        title="Карточка не загрузилась"
        description="Человек не в организации либо нет доступа."
        action={
          <Button variant="matte" href={`/workspaces/${workspaceId}/members`} icon="arrowLeft">
            К сотрудникам
          </Button>
        }
      />
    );
  }

  const card = cardQ.data;
  const e = card.employment;
  const fullName = `${card.user.firstName} ${card.user.lastName ?? ''}`.trim();
  const hasLive = !!e && e.status !== 'terminated';

  const tabs: TabItem<Tab>[] = [
    { key: 'overview', label: 'Обзор', icon: 'dashboard' },
    ...(card.canSeeEmployment ? [{ key: 'employment' as Tab, label: 'Трудовые данные', icon: 'file' as const }] : []),
    ...(card.canSeeEmployment ? [{ key: 'chronicle' as Tab, label: 'Хроника', icon: 'journal' as const }] : []),
  ];

  return (
    <>
      <PageHeader
        breadcrumb="Сотрудники"
        title={fullName}
        description={card.assignments.map((a) => a.positionName).join(', ') || 'Без должности'}
        chip={
          // role = null — человек уже не в организации: карточка остаётся
          // доступной кадровику (личное дело, основание и дата увольнения — то,
          // ради чего на неё и заходят после увольнения).
          card.role ? (
            <Chip tone="accent" icon="staff">
              {WORKSPACE_ROLES[card.role as WorkspaceRole]?.name ?? card.role}
            </Chip>
          ) : (
            <Chip tone="neutral" icon="signOut">
              Не в организации
            </Chip>
          )
        }
        actions={
          // Ушедшему из организации кадровые действия не заводятся (сервер
          // отвергнет) — кнопок тоже нет: карточка открыта ради архива и дела.
          card.canManage && card.role ? (
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
              {!hasLive && (
                <Button variant="primary" icon="userAdd" onClick={() => setActionKind('hire')}>
                  Оформить приём
                </Button>
              )}
              {hasLive && (
                <>
                  <Button variant="matte" icon="refresh" onClick={() => setActionKind('transfer')}>
                    Перевести
                  </Button>
                  <Button variant="matte" icon="coins" onClick={() => setActionKind('salary_change')}>
                    Оклад
                  </Button>
                  <Button variant="matte" icon="sun" onClick={() => setActionKind('leave')}>
                    Отпуск
                  </Button>
                  <Button variant="matte" tone="danger" icon="signOut" onClick={() => setActionKind('dismissal')}>
                    Уволить
                  </Button>
                </>
              )}
            </div>
          ) : undefined
        }
      />

      {card.mismatch.mismatch && (
        <div style={{ marginBottom: 'var(--gap-grid)' }}>
          {/* Эталон плашки — Alert tone="warning" из SendToCounterpartyModal:
              не блокирует, называет последствие, подсказывает путь. */}
          <Alert tone="warning">
            Расхождение факт/договор: фактически — <b>{card.mismatch.factPositionName ?? '—'}</b>
            {card.mismatch.factBranchName ? ` (${card.mismatch.factBranchName})` : ''}, по договору —{' '}
            <b>{card.mismatch.legalPositionName ?? '—'}</b>
            {card.mismatch.legalBranchName ? ` (${card.mismatch.legalBranchName})` : ''}. Это плашка, не ошибка:
            выровняйте переводом (галочка «обновить фактическое назначение») или правкой трудовой карточки.
          </Alert>
        </div>
      )}

      <div style={{ marginBottom: 'var(--gap-grid)' }}>
        <SegmentedControl aria-label="Разделы карточки" items={tabs} value={tab} onChange={setTab} />
      </div>

      {tab === 'overview' && (
        <BentoGrid>
          <Card>
            <CardHeader title="Человек" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
              <PersonChip
                size="M"
                userId={card.user.id}
                firstName={card.user.firstName}
                lastName={card.user.lastName}
                avatar={card.user.avatar}
                role={card.assignments[0]?.positionName ?? null}
              />
              {card.user.phone && <div className="meta">Телефон: {card.user.phone}</div>}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {/* Виджеты чужих сервисов — чипы со счётчиком и переходом к источнику */}
                <Button
                  variant="matte"
                  size="sm"
                  icon="file"
                  href={`/workspaces/${workspaceId}/documents?subject=${card.user.id}`}
                >
                  Документы · {card.documentsCount}
                </Button>
                {card.canManage && (
                  // Документ НА сотрудника с его карточки (тот же вход, что в
                  // модалке ростера): кадровик работает там, где смотрит человека
                  <Button variant="matte" size="sm" icon="filePlus" onClick={() => setDocOpen(true)}>
                    Оформить документ
                  </Button>
                )}
                {card.canManage && (
                  <Button
                    variant="matte"
                    size="sm"
                    icon="download"
                    disabled={zipBusy}
                    onClick={async () => {
                      // Байтами с токеном: простая ссылка на JWT-ручку отвечает 401
                      setZipBusy(true);
                      try {
                        const blob = await fetchPersonalFileZip(workspaceId, card.user.id);
                        saveHrBlob(blob, `Личное дело — ${fullName}.zip`);
                      } catch (err) {
                        toastError(apiErrorMessage(err));
                      } finally {
                        setZipBusy(false);
                      }
                    }}
                  >
                    {zipBusy ? 'Собираем…' : 'Личное дело (ZIP)'}
                  </Button>
                )}
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Как работает (факт)" subtitle="Назначения из «Сотрудников»" />
            {card.assignments.length === 0 ? (
              <EmptyState icon="position" title="Назначений нет" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
                {card.assignments.map((a) => (
                  <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Chip tone="accent" icon="position">{a.positionName}</Chip>
                    {a.departmentName && <Chip tone="neutral">{a.departmentName}</Chip>}
                    {a.branchName && <Chip tone="neutral" icon="office">{a.branchName}</Chip>}
                    <Chip tone={a.status === 'certified' ? 'success' : 'warning'}>
                      {a.status === 'certified' ? 'Аттестован' : 'Стажируется'}
                    </Chip>
                  </div>
                ))}
              </div>
            )}
            {card.canSeeEmployment && e && (
              <div className="meta" style={{ marginTop: 'var(--spacing-3)' }}>
                По договору: {e.legalPositionName ?? '—'}
                {e.legalBranchName ? ` · ${e.legalBranchName}` : ''} · оклад {fmtMoney(e.salaryAmount)}
              </div>
            )}
          </Card>

          <ActionsCard workspaceId={workspaceId} card={card} meId={user?.id} />
        </BentoGrid>
      )}

      {tab === 'employment' && <EmploymentCard workspaceId={workspaceId} userId={userId} card={card} />}

      {tab === 'chronicle' &&
        (chronicleQ.isPending ? (
          <LoadingBlock />
        ) : (
          <Card>
            <CardHeader title="Хроника" subtitle="Кадровые события: кто, что, когда" />
            <ChronicleFeed
              entries={chronicleQ.data?.items ?? []}
              actors={chronicleQ.data?.actors ?? {}}
              emptyText="Кадровых событий пока нет"
            />
          </Card>
        ))}

      {actionKind && (
        <HrActionModal
          workspaceId={workspaceId}
          userId={userId}
          kind={actionKind}
          employment={e}
          onClose={() => setActionKind(null)}
        />
      )}

      {docOpen && (
        <SubmitDocumentModal
          workspaceId={workspaceId}
          open
          subjectUserId={card.user.id}
          subjectName={fullName}
          onClose={() => setDocOpen(false)}
        />
      )}
    </>
  );
}
