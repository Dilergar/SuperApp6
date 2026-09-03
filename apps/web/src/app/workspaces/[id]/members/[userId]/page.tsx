'use client';

// ============================================================
// «Личный рабочий профиль» — карточка сотрудника: основная страница видна всей
// организации, чувствительное — вкладками по СУЩЕСТВУЮЩИМ гейтам:
//   Обзор (все) · Трудовые данные (canSeeEmployment: сюда переехал оклад) ·
//   Реквизиты (что приехало с ростером по «Видимости в Компаниях») ·
//   Документы (видимость вида решает реестр) · Хроника (hr_member).
// Обзор получает «Место в структуре» из /org/people/:userId/line: должности
// (основное помечено), руководитель, команда, цепочка вверх, «также: …».
// Чужие сервисы дают ВИДЖЕТЫ-ЧИПЫ со счётчиком и переходом к источнику.
// ============================================================

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiGet, apiErrorMessage } from '@/lib/api';
import { fetchHrMemberCard, fetchPersonalFileZip, saveHrBlob } from '@/lib/hr-api';
import { fetchOrgLine } from '@/lib/org-api';
import { dmy } from '@/lib/dates';
import { toastError } from '@/lib/toast';
import { hrMemberKey, orgLineKey, workspaceMemberKey } from '@/lib/queries';
import {
  Alert,
  AvatarStack,
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
import { PersonAvatar } from '@/app/messenger/messenger-ui';
import { ChronicleFeed } from '@/components/chatter/ChronicleFeed';
import { SubmitDocumentModal } from '../../documents/SubmitDocumentModal';
import {
  DOC_STATUS_LABELS,
  ORG_LIMITS,
  WORKSPACE_ROLES,
  type ChatterPageDto,
  type HrActionKind,
  type OffsetPage,
  type OrgLineDto,
  type OrgManagerDto,
  type OrgPersonLite,
  type OrgDocumentDto,
  type WorkspaceMember,
  type WorkspaceRole,
} from '@superapp/shared';
import { ActionsCard, EmploymentCard, HrActionModal } from './member-hr-ui';
import { MemberRequisitesBlock } from '../members-lib';
import { isTopOfStructure } from '../org/org-lib';

type Tab = 'overview' | 'employment' | 'requisites' | 'documents' | 'chronicle';

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

  // «Место в структуре» — единственный вход «кто мой руководитель / моя команда».
  const lineQ = useQuery({
    queryKey: orgLineKey(workspaceId, userId),
    queryFn: () => fetchOrgLine(workspaceId, userId),
    enabled: isReady && !!cardQ.data?.role,
    retry: false,
  });

  // Реквизиты/контакты — по «Видимости в Компаниях» (второй, нередактируемый
  // уровень для manager+; коллегам — только включённое человеком). Тянем ОДНОГО
  // человека: раньше ради одной карточки грузился весь ростер организации.
  const membersQ = useQuery({
    queryKey: workspaceMemberKey(workspaceId, userId),
    queryFn: async () => await apiGet<WorkspaceMember>(`/workspaces/${workspaceId}/members/${userId}`),
    enabled: isReady && tab === 'requisites',
  });

  const chronicleQ = useQuery({
    queryKey: [...hrMemberKey(workspaceId, userId), 'chronicle'],
    queryFn: () => apiGet<ChatterPageDto>(`/chatter/hr_member/${workspaceId}:${userId}`),
    enabled: isReady && tab === 'chronicle' && (cardQ.data?.canSeeEmployment ?? false),
  });

  const documentsQ = useQuery({
    queryKey: [...hrMemberKey(workspaceId, userId), 'documents'],
    queryFn: () => apiGet<OffsetPage<OrgDocumentDto>>(`/workspaces/${workspaceId}/documents`, { params: { subjectUserId: userId, limit: 30 } }),
    enabled: isReady && tab === 'documents',
  });

  if (!isReady || cardQ.isPending) return <LoadingBlock />;
  if (cardQ.isError || !cardQ.data) {
    return (
      <EmptyState
        icon="warningCircle"
        title="Карточка не загрузилась"
        description="Человек не в организации либо нет доступа."
        action={<Button variant="matte" href={`/workspaces/${workspaceId}/members`} icon="arrowLeft">К сотрудникам</Button>}
      />
    );
  }

  const card = cardQ.data;
  const e = card.employment;
  const fullName = `${card.user.firstName} ${card.user.lastName ?? ''}`.trim();
  const hasLive = !!e && e.status !== 'terminated';
  const member = membersQ.data ?? null;

  const tabs: TabItem<Tab>[] = [
    { key: 'overview', label: 'Обзор', icon: 'dashboard' },
    ...(card.canSeeEmployment ? [{ key: 'employment' as Tab, label: 'Трудовые данные', icon: 'file' as const }] : []),
    { key: 'requisites', label: 'Реквизиты', icon: 'card' },
    { key: 'documents', label: 'Документы', icon: 'list', count: card.documentsCount || undefined },
    ...(card.canSeeEmployment ? [{ key: 'chronicle' as Tab, label: 'Хроника', icon: 'journal' as const }] : []),
  ];

  return (
    <>
      <PageHeader
        breadcrumb="Сотрудники"
        title={fullName}
        description={card.assignments.map((a) => a.positionName).join(', ') || 'Без должности'}
        chip={
          card.role ? (
            <Chip tone="accent" icon="staff">{WORKSPACE_ROLES[card.role as WorkspaceRole]?.name ?? card.role}</Chip>
          ) : (
            <Chip tone="neutral" icon="signOut">Не в организации</Chip>
          )
        }
        actions={
          card.canManage && card.role ? (
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
              {!hasLive && (
                <Button variant="primary" icon="userAdd" onClick={() => setActionKind('hire')}>Оформить приём</Button>
              )}
              {hasLive && (
                <>
                  <Button variant="matte" icon="refresh" onClick={() => setActionKind('transfer')}>Перевести</Button>
                  <Button variant="matte" icon="coins" onClick={() => setActionKind('salary_change')}>Оклад</Button>
                  <Button variant="matte" icon="sun" onClick={() => setActionKind('leave')}>Отпуск</Button>
                  {/* Здесь — увольнение ПО ТК (приказ, ЕСУТД, расчёт). Исключение из
                      организации живёт в ростере и называется иначе: одна подпись на
                      два разных последствия путала. */}
                  <Button variant="matte" tone="danger" icon="signOut" onClick={() => setActionKind('dismissal')}>Оформить увольнение</Button>
                </>
              )}
            </div>
          ) : undefined
        }
      />

      {card.mismatch.mismatch && (
        <div style={{ marginBottom: 'var(--gap-grid)' }}>
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
          {/* Сетка бенто — 12 колонок: карточка без span занимает ОДНУ; три блока по 4 + действия во всю ширину */}
          <Card span={4}>
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
                <Button variant="matte" size="sm" icon="file" onClick={() => setTab('documents')}>
                  Документы · {card.documentsCount}
                </Button>
                {card.canManage && (
                  <Button variant="matte" size="sm" icon="filePlus" onClick={() => setDocOpen(true)}>Оформить документ</Button>
                )}
                {card.canManage && (
                  <Button
                    variant="matte"
                    size="sm"
                    icon="download"
                    disabled={zipBusy}
                    onClick={async () => {
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

          <PlaceInStructureCard
            workspaceId={workspaceId}
            userId={userId}
            line={lineQ.data ?? null}
            pending={lineQ.isPending && !!card.role}
            failed={lineQ.isError}
            onRetry={() => void lineQ.refetch()}
            inOrg={!!card.role}
          />

          <Card span={4}>
            <CardHeader title="Как работает (факт)" subtitle="Назначения из «Сотрудников»; основное место помечено" />
            {card.assignments.length === 0 ? (
              <EmptyState icon="position" title="Назначений нет" description="Человек вне структуры — назначьте должность в ростере." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
                {card.assignments.map((a) => {
                  const isPrimary = lineQ.data?.assignments.find((x) => x.assignmentId === a.id)?.isPrimary ?? false;
                  return (
                    <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Chip tone="accent" icon="position">{a.positionName}</Chip>
                      {a.departmentName && <Chip tone="neutral" icon="department">{a.departmentName}</Chip>}
                      {a.branchName && <Chip tone="neutral" icon="branch">{a.branchName}</Chip>}
                      {isPrimary && <Chip tone="accent" icon="star">Основное</Chip>}
                      <Chip tone={a.status === 'certified' ? 'success' : 'waiting'}>{a.status === 'certified' ? 'Аттестован' : 'Стажируется'}</Chip>
                    </div>
                  );
                })}
              </div>
            )}
            {card.canSeeEmployment && e && (
              <div className="meta" style={{ marginTop: 'var(--spacing-3)' }}>
                По договору: {e.legalPositionName ?? '—'}
                {e.legalBranchName ? ` · ${e.legalBranchName}` : ''}
              </div>
            )}
          </Card>

          <div style={{ gridColumn: 'span 12' }}>
            <ActionsCard workspaceId={workspaceId} card={card} meId={user?.id} />
          </div>
        </BentoGrid>
      )}

      {tab === 'employment' && <EmploymentCard workspaceId={workspaceId} userId={userId} card={card} />}

      {tab === 'requisites' &&
        (membersQ.isPending ? (
          <LoadingBlock />
        ) : (
          <Card>
            <CardHeader title="Контакты и реквизиты" subtitle="Что открыто вам по «Видимости в Компаниях»; управляющим — комплект для договоров и выплат" />
            <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
              <div className="ui-stack" style={{ gap: '0.25rem' }}>
                {card.user.phone && <div className="meta">Телефон: {card.user.phone}</div>}
                {member?.card?.email && <div className="meta">E-mail: {member.card.email}</div>}
                {member?.card?.city && <div className="meta">Город: {member.card.city}</div>}
                {member?.card?.bio && <div className="meta">О себе: {member.card.bio}</div>}
              </div>
              {member?.requisites ? (
                <MemberRequisitesBlock req={member.requisites} title="Для договоров и выплат" />
              ) : (
                <EmptyState icon="lock" title="Реквизиты закрыты" description="Их видят управляющие и те, кому человек открыл поля сам." />
              )}
            </div>
          </Card>
        ))}

      {tab === 'documents' &&
        (documentsQ.isPending ? (
          <LoadingBlock />
        ) : (
          <Card>
            <CardHeader
              title="Документы о человеке"
              subtitle="Видимость решает вид документа; полный реестр — в Документообороте"
              actions={
                <Button variant="ghost" size="sm" icon="list" href={`/workspaces/${workspaceId}/documents?subject=${userId}`}>
                  В реестре
                </Button>
              }
            />
            {!documentsQ.data || documentsQ.data.items.length === 0 ? (
              <EmptyState icon="file" title="Документов не видно" description="Либо их нет, либо вид документа закрыт для вас." />
            ) : (
              <div className="ui-stack" style={{ gap: '0.375rem' }}>
                {documentsQ.data.items.map((d) => (
                  <a
                    key={d.id}
                    href={`/workspaces/${workspaceId}/documents/${d.id}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap',
                      padding: '0.5rem 0.75rem', border: '1px solid var(--divider)', borderRadius: 'var(--radius-md)',
                      color: 'inherit', textDecoration: 'none',
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="title-sm">{d.title}</span>
                      <span className="label-sm" style={{ display: 'block' }}>{d.docTypeName}{d.number ? ` · № ${d.number}` : ''}</span>
                    </span>
                    <Chip size="sm" tone="neutral">{DOC_STATUS_LABELS[d.status] ?? d.status}</Chip>
                  </a>
                ))}
              </div>
            )}
          </Card>
        ))}

      {tab === 'chronicle' &&
        (chronicleQ.isPending ? (
          <LoadingBlock />
        ) : (
          <Card>
            <CardHeader title="Хроника" subtitle="Кадровые события: кто, что, когда" />
            <ChronicleFeed entries={chronicleQ.data?.items ?? []} actors={chronicleQ.data?.actors ?? {}} emptyText="Кадровых событий пока нет" />
          </Card>
        ))}

      {actionKind && (
        <HrActionModal workspaceId={workspaceId} userId={userId} kind={actionKind} employment={e} onClose={() => setActionKind(null)} />
      )}

      {docOpen && (
        <SubmitDocumentModal workspaceId={workspaceId} open subjectUserId={card.user.id} subjectName={fullName} onClose={() => setDocOpen(false)} />
      )}
    </>
  );
}

/** Чип человека из батча `people` ответа (лайт-профиль → PersonChip). */
function PersonFromLite({ id, people, role, size = 'S' }: { id: string; people: Record<string, OrgPersonLite>; role?: string | null; size?: 'S' | 'M' | 'XS' }) {
  const p = people[id];
  return <PersonChip size={size} userId={id} firstName={p?.firstName ?? '…'} lastName={p?.lastName ?? null} avatar={p?.avatar ?? null} role={role ?? null} />;
}

function ManagerLine({ m, people, self }: { m: OrgManagerDto; people: Record<string, OrgPersonLite>; self: string }) {
  if (isTopOfStructure(m, self)) {
    return <Chip tone="neutral" icon="crown">Вершина структуры — руководителя нет</Chip>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {m.userIds.map((uid) => (
          <PersonFromLite key={uid} id={uid} people={people} role={m.positionName ?? 'Владелец организации'} size="M" />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {m.viaDeputy && (
          <Chip size="sm" tone="waiting" icon="refresh">{m.deputyUntil ? `замещает до ${dmy(m.deputyUntil)}` : 'замещает'}</Chip>
        )}
        {m.reason === 'owner_fallback' && <Chip size="sm" tone="neutral" icon="info">руководитель не найден → владелец организации</Chip>}
      </div>
    </div>
  );
}

/** «Место в структуре»: должности, мой руководитель, моя команда, цепочка, «также» */
function PlaceInStructureCard({
  workspaceId, userId, line, pending, failed, onRetry, inOrg,
}: {
  workspaceId: string;
  userId: string;
  line: OrgLineDto | null;
  pending: boolean;
  /** Запрос упал (в т.ч. 404 «человек не в организации» на несвежем снимке) */
  failed: boolean;
  onRetry: () => void;
  inOrg: boolean;
}) {
  const orgHref = `/workspaces/${workspaceId}/members/org?focus=user:${userId}`;
  return (
    <Card span={4}>
      <CardHeader
        title="Место в структуре"
        subtitle="По факту назначений: руководитель, команда, цепочка"
        actions={<Button variant="ghost" size="sm" icon="department" href={orgHref}>На схеме</Button>}
      />
      {!inOrg ? (
        <EmptyState icon="signOut" title="Не в организации" />
      ) : pending ? (
        <LoadingBlock />
      ) : failed || !line ? (
        // Без этой ветки карточка висела ВЕЧНЫМ скелетом: у запроса выключены
        // повторы, а `!line` после падения истинно — «загружается» навсегда.
        <EmptyState
          icon="warningCircle"
          title="Место в структуре не загрузилось"
          description="Данные оргструктуры недоступны — попробуйте ещё раз."
          action={<Button variant="matte" icon="refresh" onClick={onRetry}>Повторить</Button>}
        />
      ) : line.assignments.length === 0 ? (
        <EmptyState icon="position" title="Вне структуры" description="Назначений нет — руководитель не определён." />
      ) : (
        <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
          <div>
            <div className="label-caps" style={{ marginBottom: 'var(--spacing-2)' }}>Мой руководитель</div>
            <ManagerLine m={line.manager} people={line.people} self={userId} />
          </div>

          <div>
            <div className="label-caps" style={{ marginBottom: 'var(--spacing-2)' }}>Моя команда · {line.team.count}</div>
            {line.team.count === 0 ? (
              <p className="label-sm" style={{ margin: 0 }}>Подчинённых нет</p>
            ) : (
              <a href={orgHref} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-2)', color: 'inherit', textDecoration: 'none' }}>
                <AvatarStack
                  size={28}
                  overflow={Math.max(0, line.team.count - Math.min(line.team.userIds.length, ORG_LIMITS.teamPreview))}
                >
                  {line.team.userIds.slice(0, ORG_LIMITS.teamPreview).map((uid) => (
                    <PersonAvatar key={uid} userId={uid} name={line.people[uid]?.firstName ?? '·'} avatar={line.people[uid]?.avatar ?? null} size="sm" />
                  ))}
                </AvatarStack>
              </a>
            )}
          </div>

          {line.chain.length > 1 && (
            <div>
              <div className="label-caps" style={{ marginBottom: 'var(--spacing-2)' }}>Цепочка вверх</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {line.chain.map((s, i) => (
                  <span key={s.positionId} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {i > 0 && <span className="label-sm">→</span>}
                    <Chip size="sm" tone={s.userIds.length ? 'neutral' : 'warning'} icon="position">
                      {s.positionName}{s.userIds.length === 0 ? ' · вакансия' : ''}
                    </Chip>
                  </span>
                ))}
              </div>
            </div>
          )}

          {line.others.length > 0 && (
            <div>
              <div className="label-caps" style={{ marginBottom: 'var(--spacing-2)' }}>Также</div>
              <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
                {line.others.map((o) => {
                  const a = line.assignments.find((x) => x.assignmentId === o.assignmentId);
                  return (
                    <div key={o.assignmentId} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Chip size="sm" tone="neutral" icon="position">{a?.positionName ?? '…'} · {a?.branchName ?? ''}</Chip>
                      <span className="label-sm">→</span>
                      {o.manager.userIds.map((uid) => (
                        <PersonFromLite key={uid} id={uid} people={line.people} role={o.manager.positionName ?? 'Владелец'} size="XS" />
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
