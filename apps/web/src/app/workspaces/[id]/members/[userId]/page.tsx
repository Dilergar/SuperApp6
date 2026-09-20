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
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { useRoleLabel } from '../members-lib';
import { useQuery } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiGet } from '@/lib/api';
import { fetchHrMemberCard, fetchPersonalFileZip, saveHrBlob } from '@/lib/hr-api';
import { fetchOrgLine } from '@/lib/org-api';
import { dmy } from '@/lib/dates';

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
  
  ORG_LIMITS,
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

import { toastApiError } from '@/lib/api-errors';
type Tab = 'overview' | 'employment' | 'requisites' | 'documents' | 'chronicle';

export default function MemberCardPage() {
  const t = useTranslations('staff');
  const tc = useTranslations('common');
  const tdoc = useTranslations('documents');
  const roleLabel = useRoleLabel();
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
        title={t('card.loadFailed')}
        description={t('card.loadFailedHint')}
        action={<Button variant="matte" href={`/workspaces/${workspaceId}/members`} icon="arrowLeft">{t('card.toEmployees')}</Button>}
      />
    );
  }

  const card = cardQ.data;
  const e = card.employment;
  const fullName = `${card.user.firstName} ${card.user.lastName ?? ''}`.trim();
  const hasLive = !!e && e.status !== 'terminated';
  const member = membersQ.data ?? null;

  const tabs: TabItem<Tab>[] = [
    { key: 'overview', label: t('card.tabOverview'), icon: 'dashboard' },
    ...(card.canSeeEmployment ? [{ key: 'employment' as Tab, label: t('card.tabEmployment'), icon: 'file' as const }] : []),
    { key: 'requisites', label: t('requisites.title'), icon: 'card' },
    { key: 'documents', label: t('card.tabDocuments'), icon: 'list', count: card.documentsCount || undefined },
    ...(card.canSeeEmployment ? [{ key: 'chronicle' as Tab, label: t('card.tabChronicle'), icon: 'journal' as const }] : []),
  ];

  return (
    <>
      <PageHeader
        breadcrumb={t('breadcrumb')}
        title={fullName}
        description={card.assignments.map((a) => a.positionName).join(', ') || t('card.noPosition')}
        chip={
          card.role ? (
            <Chip tone="accent" icon="staff">{roleLabel(card.role)}</Chip>
          ) : (
            <Chip tone="neutral" icon="signOut">{t('card.notInOrg')}</Chip>
          )
        }
        actions={
          card.canManage && card.role ? (
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
              {!hasLive && (
                <Button variant="primary" icon="userAdd" onClick={() => setActionKind('hire')}>{t('card.draftHire')}</Button>
              )}
              {hasLive && (
                <>
                  <Button variant="matte" icon="refresh" onClick={() => setActionKind('transfer')}>{t('card.transfer')}</Button>
                  <Button variant="matte" icon="coins" onClick={() => setActionKind('salary_change')}>{t('card.salary')}</Button>
                  <Button variant="matte" icon="sun" onClick={() => setActionKind('leave')}>{t('card.leave')}</Button>
                  {/* Здесь — увольнение ПО ТК (приказ, ЕСУТД, расчёт). Исключение из
                      организации живёт в ростере и называется иначе: одна подпись на
                      два разных последствия путала. */}
                  <Button variant="matte" tone="danger" icon="signOut" onClick={() => setActionKind('dismissal')}>{t('card.draftDismissal')}</Button>
                </>
              )}
            </div>
          ) : undefined
        }
      />

      {card.mismatch.mismatch && (
        <div style={{ marginBottom: 'var(--gap-grid)' }}>
          <Alert tone="warning">
            {t.rich('card.mismatch', {
              b: (chunks) => <b>{chunks}</b>,
              fact: card.mismatch.factPositionName ?? tc('labels.dash'),
              factBranch: card.mismatch.factBranchName ? t('card.branchSuffix', { name: card.mismatch.factBranchName }) : '',
              legal: card.mismatch.legalPositionName ?? tc('labels.dash'),
              legalBranch: card.mismatch.legalBranchName ? t('card.branchSuffix', { name: card.mismatch.legalBranchName }) : '',
            })}
          </Alert>
        </div>
      )}

      <div style={{ marginBottom: 'var(--gap-grid)' }}>
        <SegmentedControl aria-label={t('card.tabsAria')} items={tabs} value={tab} onChange={setTab} />
      </div>

      {tab === 'overview' && (
        <BentoGrid>
          {/* Сетка бенто — 12 колонок: карточка без span занимает ОДНУ; три блока по 4 + действия во всю ширину */}
          <Card span={4}>
            <CardHeader title={t('card.person')} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
              <PersonChip
                size="M"
                userId={card.user.id}
                firstName={card.user.firstName}
                lastName={card.user.lastName}
                avatar={card.user.avatar}
                role={card.assignments[0]?.positionName ?? null}
              />
              {card.user.phone && <div className="meta">{t('card.phone', { value: card.user.phone })}</div>}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Button variant="matte" size="sm" icon="file" onClick={() => setTab('documents')}>
                  {t('card.documentsCount', { n: card.documentsCount })}
                </Button>
                {card.canManage && (
                  <Button variant="matte" size="sm" icon="filePlus" onClick={() => setDocOpen(true)}>{t('member.draftDocument')}</Button>
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
                        saveHrBlob(blob, t('card.personalFileName', { name: fullName }));
                      } catch (err) {
                        toastApiError(err);
                      } finally {
                        setZipBusy(false);
                      }
                    }}
                  >
                    {zipBusy ? t('card.zipBusy') : t('card.personalFileZip')}
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
            <CardHeader title={t('card.factTitle')} subtitle={t('card.factSubtitle')} />
            {card.assignments.length === 0 ? (
              <EmptyState icon="position" title={t('card.noAssignments')} description={t('card.noAssignmentsHint')} />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
                {card.assignments.map((a) => {
                  const isPrimary = lineQ.data?.assignments.find((x) => x.assignmentId === a.id)?.isPrimary ?? false;
                  return (
                    <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Chip tone="accent" icon="position">{a.positionName}</Chip>
                      {a.departmentName && <Chip tone="neutral" icon="department">{a.departmentName}</Chip>}
                      {a.branchName && <Chip tone="neutral" icon="branch">{a.branchName}</Chip>}
                      {isPrimary && <Chip tone="accent" icon="star">{t('member.primary')}</Chip>}
                      <Chip tone={a.status === 'certified' ? 'success' : 'waiting'}>{t(`assignmentStatus.${a.status}`)}</Chip>
                    </div>
                  );
                })}
              </div>
            )}
            {card.canSeeEmployment && e && (
              <div className="meta" style={{ marginTop: 'var(--spacing-3)' }}>
                {t('card.byContract', {
                  value: `${e.legalPositionName ?? tc('labels.dash')}${e.legalBranchName ? ` · ${e.legalBranchName}` : ''}`,
                })}
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
            <CardHeader title={t('card.contactsTitle')} subtitle={t('card.contactsSubtitle')} />
            <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
              <div className="ui-stack" style={{ gap: '0.25rem' }}>
                {card.user.phone && <div className="meta">{t('card.phone', { value: card.user.phone })}</div>}
                {member?.card?.email && <div className="meta">{t('card.email', { value: member.card.email })}</div>}
                {member?.card?.city && <div className="meta">{t('card.city', { value: member.card.city })}</div>}
                {member?.card?.bio && <div className="meta">{t('card.bio', { value: member.card.bio })}</div>}
              </div>
              {member?.requisites ? (
                <MemberRequisitesBlock req={member.requisites} title={t('requisites.forContracts')} />
              ) : (
                <EmptyState icon="lock" title={t('card.requisitesLocked')} description={t('card.requisitesLockedHint')} />
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
              title={t('card.documentsTitle')}
              subtitle={t('card.documentsSubtitle')}
              actions={
                <Button variant="ghost" size="sm" icon="list" href={`/workspaces/${workspaceId}/documents?subject=${userId}`}>
                  {t('card.inRegister')}
                </Button>
              }
            />
            {!documentsQ.data || documentsQ.data.items.length === 0 ? (
              <EmptyState icon="file" title={t('card.documentsEmpty')} description={t('card.documentsEmptyHint')} />
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
                    <Chip size="sm" tone="neutral">{tdoc(`status.${d.status}`)}</Chip>
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
            <CardHeader title={t('card.chronicleTitle')} subtitle={t('card.chronicleSubtitle')} />
            <ChronicleFeed entries={chronicleQ.data?.items ?? []} actors={chronicleQ.data?.actors ?? {}} emptyText={t('card.chronicleEmpty')} />
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
  const t = useTranslations('staff');
  if (isTopOfStructure(m, self)) {
    return <Chip tone="neutral" icon="crown">{t('card.topOfStructure')}</Chip>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {m.userIds.map((uid) => (
          <PersonFromLite key={uid} id={uid} people={people} role={m.positionName ?? t('card.orgOwner')} size="M" />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {m.viaDeputy && (
          <Chip size="sm" tone="waiting" icon="refresh">
            {m.deputyUntil ? t('card.deputisingUntil', { date: dmy(m.deputyUntil) }) : t('card.deputising')}
          </Chip>
        )}
        {m.reason === 'owner_fallback' && <Chip size="sm" tone="neutral" icon="info">{t('managerReason.owner_fallback')}</Chip>}
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
  const t = useTranslations('staff');
  const tc = useTranslations('common');
  const orgHref = `/workspaces/${workspaceId}/members/org?focus=user:${userId}`;
  return (
    <Card span={4}>
      <CardHeader
        title={t('card.placeTitle')}
        subtitle={t('card.placeSubtitle')}
        actions={<Button variant="ghost" size="sm" icon="department" href={orgHref}>{t('card.onChart')}</Button>}
      />
      {!inOrg ? (
        <EmptyState icon="signOut" title={t('card.notInOrg')} />
      ) : pending ? (
        <LoadingBlock />
      ) : failed || !line ? (
        // Без этой ветки карточка висела ВЕЧНЫМ скелетом: у запроса выключены
        // повторы, а `!line` после падения истинно — «загружается» навсегда.
        <EmptyState
          icon="warningCircle"
          title={t('card.placeFailed')}
          description={t('card.placeFailedHint')}
          action={<Button variant="matte" icon="refresh" onClick={onRetry}>{tc('actions.retry')}</Button>}
        />
      ) : line.assignments.length === 0 ? (
        <EmptyState icon="position" title={t('card.outsideStructure')} description={t('card.outsideStructureHint')} />
      ) : (
        <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
          <div>
            <div className="label-caps" style={{ marginBottom: 'var(--spacing-2)' }}>{t('card.myManager')}</div>
            <ManagerLine m={line.manager} people={line.people} self={userId} />
          </div>

          <div>
            <div className="label-caps" style={{ marginBottom: 'var(--spacing-2)' }}>{t('card.myTeam', { n: line.team.count })}</div>
            {line.team.count === 0 ? (
              <p className="label-sm" style={{ margin: 0 }}>{t('card.noSubordinates')}</p>
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
              <div className="label-caps" style={{ marginBottom: 'var(--spacing-2)' }}>{t('card.chainUp')}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {line.chain.map((s, i) => (
                  <span key={s.positionId} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {i > 0 && <span className="label-sm">→</span>}
                    <Chip size="sm" tone={s.userIds.length ? 'neutral' : 'warning'} icon="position">
                      {s.positionName}{s.userIds.length === 0 ? t('card.vacancySuffix') : ''}
                    </Chip>
                  </span>
                ))}
              </div>
            </div>
          )}

          {line.others.length > 0 && (
            <div>
              <div className="label-caps" style={{ marginBottom: 'var(--spacing-2)' }}>{t('card.also')}</div>
              <div className="ui-stack" style={{ gap: 'var(--spacing-2)' }}>
                {line.others.map((o) => {
                  const a = line.assignments.find((x) => x.assignmentId === o.assignmentId);
                  return (
                    <div key={o.assignmentId} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Chip size="sm" tone="neutral" icon="position">{a?.positionName ?? '…'} · {a?.branchName ?? ''}</Chip>
                      <span className="label-sm">→</span>
                      {o.manager.userIds.map((uid) => (
                        <PersonFromLite key={uid} id={uid} people={line.people} role={o.manager.positionName ?? t('card.owner')} size="XS" />
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
