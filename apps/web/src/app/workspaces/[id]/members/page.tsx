'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api, apiErrorMessage } from '@/lib/api';
import {
  workspaceKey,
  workspaceMembersKey,
  workspaceStaffKey,
  workspaceInvitationsKey,
} from '@/lib/queries';
import { invalidateEntities, type Principal } from '@/lib/entities';
import { EntitySelector } from '@/components/EntitySelector';
import {
  Alert, BentoGrid, Button, Card, CardHeader, Chip, ConfirmDialog, Divider, EmptyState, Field,
  Icon, IconButton, Input, LoadingBlock, Modal, PageHeader, SearchField, Select, StatTile, SegmentedControl,
  type TabItem,
} from '@/components/ui';
import { PersonChip, StaffPersonCard, type StaffCardData } from '../../../circles/PersonCard';
import { SubmitDocumentModal } from '../documents/SubmitDocumentModal';
import { PersonAvatar } from '../../../messenger/messenger-ui';
import {
  WORKSPACE_ROLES,
  ADMIN_ASSIGNABLE_WORKSPACE_ROLES,
  OWNER_ASSIGNABLE_WORKSPACE_ROLES,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceInvitation,
  type WorkspaceRole,
  type StaffDirectory,
  type StaffAssignment,
} from '@superapp/shared';

const roleLabel = (r: string): string => WORKSPACE_ROLES[r as WorkspaceRole]?.name ?? r;

/** «Санжар Намыс» → ['Санжар', 'Намыс'] — PersonChip ждёт имя и фамилию раздельно. */
const splitName = (full: string): [string, string | null] => {
  const parts = (full || '?').trim().split(/\s+/);
  return [parts[0] ?? '?', parts.slice(1).join(' ') || null];
};

type Tab = 'people' | 'positions' | 'departments' | 'branches' | 'invites';

/**
 * Сервис «Сотрудники» (B2B): одна страница с вкладками — ростер L-карточками (как
 * «Моё окружение»), справочники Должности/Отделы/Филиалы, наём (всегда в Стажёра,
 * форма 1в1 как добавление в Окружение: номер → имя с инициалом → отправить).
 * Чтение — вся команда; справочники/назначения/наём — Менеджер+; роли/увольнение — Админ+.
 */
export default function WorkspaceStaffPage() {
  const { isReady, user } = useRequireAuth();
  const router = useRouter();
  const { id: workspaceId } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const [tab, setTab] = useState<Tab>('people');
  const [error, setError] = useState('');
  const [leaving, setLeaving] = useState(false);

  const wsQ = useQuery({
    queryKey: workspaceKey(workspaceId),
    queryFn: async () => (await api.get(`/workspaces/${workspaceId}`)).data.data as Workspace,
    enabled: isReady,
  });
  const ws = wsQ.data;
  const myRole = ws?.myRole;
  const canManage = myRole === 'owner' || myRole === 'admin';
  const canStaff = canManage || myRole === 'manager';

  const membersQ = useQuery({
    queryKey: workspaceMembersKey(workspaceId),
    queryFn: async () =>
      (await api.get(`/workspaces/${workspaceId}/members`)).data.data as WorkspaceMember[],
    enabled: isReady,
  });
  const staffQ = useQuery({
    queryKey: workspaceStaffKey(workspaceId),
    queryFn: async () =>
      (await api.get(`/workspaces/${workspaceId}/staff`)).data.data as StaffDirectory,
    enabled: isReady,
  });
  const invitesQ = useQuery({
    queryKey: workspaceInvitationsKey(workspaceId),
    queryFn: async () =>
      (await api.get(`/workspaces/${workspaceId}/invitations`)).data.data as WorkspaceInvitation[],
    enabled: isReady && canStaff,
  });

  // Любая мутация справочников/назначений → точечная инвалидация + кэш EntitySelector.
  const refreshStaff = () => {
    qc.invalidateQueries({ queryKey: workspaceStaffKey(workspaceId) });
    qc.invalidateQueries({ queryKey: workspaceMembersKey(workspaceId) });
    invalidateEntities('department');
    invalidateEntities('position');
    invalidateEntities('branch');
  };

  const leave = async () => {
    try {
      await api.post(`/workspaces/${workspaceId}/leave`);
      router.push('/dashboard');
    } catch (e) {
      setLeaving(false);
      setError(apiErrorMessage(e));
    }
  };

  if (!isReady || wsQ.isLoading || !ws) return <LoadingBlock />;

  const dir = staffQ.data ?? { departments: [], positions: [], branches: [] };
  const members = membersQ.data ?? [];

  const tabs: TabItem<Tab>[] = [
    { key: 'people', label: 'Сотрудники', icon: 'people', count: members.length },
    { key: 'positions', label: 'Должности', icon: 'position', count: dir.positions.length },
    { key: 'departments', label: 'Отделы', icon: 'department', count: dir.departments.length },
    { key: 'branches', label: 'Филиалы', icon: 'branch', count: dir.branches.length },
    ...(canStaff
      ? [{ key: 'invites' as Tab, label: 'Приглашения', icon: 'userAdd' as const, count: invitesQ.data?.length ?? 0 }]
      : []),
  ];

  return (
    <>
      <PageHeader
        breadcrumb={ws.name}
        title="Сотрудники"
        description="Ростер, справочники должностей и отделов, наём по номеру"
        chip={<Chip tone="accent" icon="people">{ws.membersCount} чел.</Chip>}
        // Матовая, а не призрачная: кнопка стоит на ФОНЕ СТРАНИЦЫ, а призрачная
        // там остаётся без подложки и выпадает из системы (правило из календаря).
        actions={
          myRole && myRole !== 'owner' ? (
            <Button variant="matte" tone="danger" icon="signOut" onClick={() => setLeaving(true)}>
              Выйти из организации
            </Button>
          ) : undefined
        }
      />

      <div style={{ marginBottom: 'var(--gap-grid)' }}>
        <SegmentedControl aria-label="Разделы сервиса" items={tabs} value={tab} onChange={(k) => { setTab(k); setError(''); }} />
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--gap-grid)' }}>
          <Alert tone="danger" onClose={() => setError('')}>{error}</Alert>
        </div>
      )}

      {tab === 'people' && (
        <PeopleTab
          workspaceId={workspaceId}
          members={members}
          dir={dir}
          meId={user?.id}
          myRole={myRole}
          canManage={canManage}
          canStaff={canStaff}
          ownerId={ws.ownerId}
          onError={setError}
          refreshStaff={refreshStaff}
        />
      )}
      {tab === 'positions' && (
        <PositionsTab workspaceId={workspaceId} dir={dir} canStaff={canStaff} onError={setError} refresh={refreshStaff} />
      )}
      {tab === 'departments' && (
        <DepartmentsTab workspaceId={workspaceId} dir={dir} canStaff={canStaff} onError={setError} refresh={refreshStaff} />
      )}
      {tab === 'branches' && (
        <BranchesTab workspaceId={workspaceId} dir={dir} canStaff={canStaff} onError={setError} refresh={refreshStaff} />
      )}
      {tab === 'invites' && canStaff && (
        <InvitesTab
          workspaceId={workspaceId}
          dir={dir}
          invites={invitesQ.data ?? []}
          onError={setError}
        />
      )}

      <ConfirmDialog
        open={leaving}
        onClose={() => setLeaving(false)}
        onConfirm={leave}
        title="Выйти из организации?"
        message="Ваши назначения снимутся, доступ к рабочим данным закроется. Вернуться можно только по новому приглашению."
        confirmLabel="Выйти"
        danger
      />
    </>
  );
}

// ============================================================
// Вкладка «Сотрудники»: фильтры + L-грид (как «Моё окружение») +
// клик по карточке → окно управления
// ============================================================

function PeopleTab({
  workspaceId, members, dir, meId, myRole, canManage, canStaff, ownerId, onError, refreshStaff,
}: {
  workspaceId: string;
  members: WorkspaceMember[];
  dir: StaffDirectory;
  meId?: string;
  myRole?: WorkspaceRole;
  canManage: boolean;
  canStaff: boolean;
  ownerId: string;
  onError: (m: string) => void;
  refreshStaff: () => void;
}) {
  const router = useRouter();
  const [fDep, setFDep] = useState('');
  const [fPos, setFPos] = useState('');
  const [fBr, setFBr] = useState('');
  const [fRole, setFRole] = useState('');
  const [q, setQ] = useState('');
  const [managedId, setManagedId] = useState<string | null>(null);

  const team = members.filter((m) => m.role !== 'contractor');
  const contractors = members.filter((m) => m.role === 'contractor');

  const filtered = team.filter((m) => {
    if (fDep && !m.assignments.some((a) => a.departmentId === fDep)) return false;
    if (fPos && !m.assignments.some((a) => a.positionId === fPos)) return false;
    if (fBr && !m.assignments.some((a) => a.branchId === fBr)) return false;
    if (fRole && m.role !== fRole) return false;
    if (q && !m.userName.toLowerCase().includes(q.trim().toLowerCase())) return false;
    return true;
  });

  const hasFilter = !!(fDep || fPos || fBr || fRole || q);
  const clearFilters = () => { setFDep(''); setFPos(''); setFBr(''); setFRole(''); setQ(''); };

  // Пропсы карточек считаются ОДИН раз на список и переживают кейстроки поиска:
  // StaffPersonCard обёрнут в memo, и именно стабильность этих объектов позволяет
  // ему НЕ перерисовываться на каждый ввод в фильтрах (раньше сотня карточек со
  // скинами пересобиралась на каждую букву).
  const cardProps = useMemo(() => {
    const map = new Map<string, { card: StaffCardData; positions: string[]; branches: string[] }>();
    for (const m of members) {
      // Страховка от устаревшего кэша (member без card после обновления контракта).
      let card: StaffCardData;
      if (m.card) {
        card = m.card;
      } else {
        const [fn, ln] = splitName(m.userName);
        card = {
          phone: '', firstName: fn, lastName: ln, avatar: m.userAvatar,
          dateOfBirth: null, bio: null, city: null, email: null, maritalStatus: null,
          socialLinks: null, age: null, showOnlineStatus: false,
        };
      }
      map.set(m.userId, {
        card,
        // Бейдж карты = Должности; филиалы — отдельные чипы (роль организации на карте не видна).
        positions: [...new Set(m.assignments.map((a) => a.positionName))],
        branches: [...new Set(m.assignments.map((a) => a.branchName).filter((b): b is string => !!b))],
      });
    }
    return map;
  }, [members]);

  const managed = managedId ? members.find((m) => m.userId === managedId) ?? null : null;
  const [documentFor, setDocumentFor] = useState<WorkspaceMember | null>(null);

  // «Написать» — DM через «рабочий пропуск» (заголовок организации), затем в чат.
  const writeTo = async (m: WorkspaceMember) => {
    try {
      const r = await api.post(
        '/messenger/chats/dm',
        { userId: m.userId },
        { headers: { 'X-Workspace-Id': workspaceId } },
      );
      router.push(`/messenger?chat=${r.data.data.id}`);
    } catch (e) {
      onError(apiErrorMessage(e));
    }
  };
  // Стабильные обработчики поверх ref: сами колбэки не пересоздаются между
  // рендерами (иначе memo карточек не работал бы), а зовут всегда свежий writeTo.
  const writeToRef = useRef(writeTo);
  writeToRef.current = writeTo;
  const actions = useMemo(() => {
    const map = new Map<string, { onWrite?: () => void; onManage?: () => void }>();
    for (const m of members) {
      map.set(m.userId, {
        onWrite: m.userId !== meId ? () => void writeToRef.current(m) : undefined,
        onManage: canStaff || canManage ? () => setManagedId(m.userId) : undefined,
      });
    }
    return map;
  }, [members, meId, canStaff, canManage]);

  const renderGrid = (list: WorkspaceMember[]) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--gap-grid)', alignItems: 'start' }}>
      {list.map((m) => (
        <StaffPersonCard
          key={m.id}
          userId={m.userId}
          card={cardProps.get(m.userId)!.card}
          positions={cardProps.get(m.userId)!.positions}
          branches={cardProps.get(m.userId)!.branches}
          onWrite={actions.get(m.userId)?.onWrite}
          onManage={actions.get(m.userId)?.onManage}
        />
      ))}
    </div>
  );

  return (
    <>
      <BentoGrid>
        {/* ---------- Фильтры ---------- */}
        <Card span={12} small>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <SearchField
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onClear={() => setQ('')}
              placeholder="Поиск по имени…"
              width={200}
              aria-label="Поиск по имени"
            />
            <Select
              aria-label="Отдел"
              value={fDep}
              onChange={setFDep}
              width={170}
              options={[{ value: '', label: 'Все отделы', icon: 'department' }, ...dir.departments.map((d) => ({ value: d.id, label: d.name }))]}
            />
            <Select
              aria-label="Должность"
              value={fPos}
              onChange={setFPos}
              width={180}
              options={[{ value: '', label: 'Все должности', icon: 'position' }, ...dir.positions.map((p) => ({ value: p.id, label: p.name }))]}
            />
            <Select
              aria-label="Филиал"
              value={fBr}
              onChange={setFBr}
              width={180}
              options={[{ value: '', label: 'Все филиалы', icon: 'branch' }, ...dir.branches.map((b) => ({ value: b.id, label: b.name }))]}
            />
            <Select
              aria-label="Роль"
              value={fRole}
              onChange={setFRole}
              width={160}
              options={[
                { value: '', label: 'Все роли', icon: 'user' },
                ...(['owner', 'admin', 'manager', 'staff', 'trainee'] as const).map((r) => ({ value: r, label: roleLabel(r) })),
              ]}
            />
            {hasFilter && (
              <Button variant="ghost" size="sm" icon="close" onClick={clearFilters}>Сбросить</Button>
            )}
          </div>
        </Card>

        {/* ---------- Ростер ---------- */}
        <Card span={12}>
          <CardHeader
            title="Команда"
            subtitle={hasFilter ? `Найдено: ${filtered.length} из ${team.length}` : `${team.length} чел.`}
          />
          {filtered.length === 0 ? (
            <EmptyState
              icon="people"
              title={hasFilter ? 'Никого не найдено' : 'В команде пока никого'}
              description={hasFilter ? 'Смягчите фильтры или сбросьте их.' : 'Наймите первого сотрудника на вкладке «Приглашения».'}
              action={hasFilter ? <Button variant="matte" icon="close" onClick={clearFilters}>Сбросить фильтры</Button> : undefined}
            />
          ) : (
            renderGrid(filtered)
          )}
        </Card>

        {/* ---------- Подрядчики (Коллаб-модель) — только управляющим ---------- */}
        {canManage && contractors.length > 0 && (
          <Card span={12}>
            <CardHeader
              title="Подрядчики"
              subtitle="Внешние исполнители: видят только свои задачи. Назначаются сервисами (Тайный гость, UGC), не вручную"
            />
            {renderGrid(contractors)}
          </Card>
        )}
      </BentoGrid>

      {/* Окно управления сотрудником */}
      {managed && (canStaff || canManage) && (
        <MemberModal
          workspaceId={workspaceId}
          member={managed}
          dir={dir}
          meId={meId}
          myRole={myRole}
          canManage={canManage}
          canStaff={canStaff}
          isOwnerRow={managed.userId === ownerId}
          onClose={() => setManagedId(null)}
          refreshStaff={refreshStaff}
          onSendDocument={() => {
            setManagedId(null);
            setDocumentFor(managed);
          }}
        />
      )}

      {/* Документ НА сотрудника — из его же карточки: кадровик оформляет приказ
          там, где смотрит человека, а не ищет его заново в реестре документов. */}
      {documentFor && (
        <SubmitDocumentModal
          workspaceId={workspaceId}
          open
          subjectUserId={documentFor.userId}
          subjectName={documentFor.userName}
          onClose={() => setDocumentFor(null)}
        />
      )}
    </>
  );
}

/** Окно управления сотрудником: роль + должности + увольнение. */
function MemberModal({
  workspaceId, member, dir, meId, myRole, canManage, canStaff, isOwnerRow, onClose, refreshStaff,
  onSendDocument,
}: {
  workspaceId: string;
  member: WorkspaceMember;
  dir: StaffDirectory;
  meId?: string;
  myRole?: WorkspaceRole;
  canManage: boolean;
  canStaff: boolean;
  isOwnerRow: boolean;
  onClose: () => void;
  refreshStaff: () => void;
  /** «Оформить документ» — открывает подачу с этим сотрудником как стороной */
  onSendDocument: () => void;
}) {
  const qc = useQueryClient();
  const [newRole, setNewRole] = useState<WorkspaceRole>(member.role);
  const [pickPos, setPickPos] = useState<Principal[]>([]);
  const [pickBranch, setPickBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const [firing, setFiring] = useState(false);

  const isSelf = member.userId === meId;
  const isContractor = member.role === 'contractor';
  // Лестница: админа назначает/трогает только владелец; подрядчику роль/должности не меняются.
  const assignable: readonly WorkspaceRole[] =
    myRole === 'owner' ? OWNER_ASSIGNABLE_WORKSPACE_ROLES : ADMIN_ASSIGNABLE_WORKSPACE_ROLES;
  const canChangeRole =
    canManage && !isContractor && !isOwnerRow && !isSelf && (myRole === 'owner' || member.role !== 'admin');
  const canFire =
    canManage && !isOwnerRow && !isSelf && (myRole === 'owner' || member.role !== 'admin');

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setLocalError('');
    try {
      await fn();
      refreshStaff();
    } catch (e) {
      setLocalError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const changeRole = () =>
    run(async () => {
      await api.patch(`/workspaces/${workspaceId}/members/${member.userId}`, { role: newRole });
    });

  const assign = () =>
    run(async () => {
      if (!pickPos[0]) return;
      await api.post(`/workspaces/${workspaceId}/staff/members/${member.userId}/assignments`, {
        positionId: pickPos[0].id,
        branchId: pickBranch || null,
      });
      setPickPos([]);
      setPickBranch('');
    });

  const unassign = (a: StaffAssignment) =>
    run(async () => {
      await api.delete(`/workspaces/${workspaceId}/staff/assignments/${a.id}`);
    });

  const fire = async () => {
    setBusy(true);
    setLocalError('');
    try {
      await api.delete(`/workspaces/${workspaceId}/members/${member.userId}`);
      qc.invalidateQueries({ queryKey: workspaceKey(workspaceId) });
      refreshStaff();
      onClose();
    } catch (e) {
      setFiring(false);
      setLocalError(apiErrorMessage(e));
      setBusy(false);
    }
  };

  const [fn, ln] = splitName(member.userName);

  return (
    <Modal
      open
      onClose={onClose}
      title={<PersonChip size="M" userId={member.userId} firstName={fn} lastName={ln} avatar={member.userAvatar} role={roleLabel(member.role)} />}
      size="md"
      footer={
        <>
          {canFire && (
            <Button variant="primary" tone="danger" icon="signOut" disabled={busy} onClick={() => setFiring(true)}>
              Уволить
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>Готово</Button>
        </>
      }
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {localError && <Alert tone="danger" onClose={() => setLocalError('')}>{localError}</Alert>}

        {isContractor ? (
          <Alert tone="neutral" icon="info" title="Подрядчик">
            Доступ только к своим задачам. Роль и должности не назначаются — ими управляет выдавший сервис.
          </Alert>
        ) : (
          <>
            {/* Роль */}
            {canChangeRole && (
              <Field label="Роль в организации">
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Select
                    aria-label="Роль в организации"
                    value={newRole}
                    onChange={(v) => setNewRole(v as WorkspaceRole)}
                    width={190}
                    options={assignable.map((r) => ({ value: r, label: roleLabel(r) }))}
                  />
                  <Button
                    variant="matte"
                    tone="accent"
                    size="sm"
                    icon="check"
                    disabled={newRole === member.role}
                    loading={busy}
                    onClick={changeRole}
                  >
                    Сменить
                  </Button>
                </div>
              </Field>
            )}
            {canManage && !canChangeRole && !isSelf && !isOwnerRow && member.role === 'admin' && (
              <Alert tone="neutral" icon="lock">Роль Админа меняет только Владелец</Alert>
            )}

            {/* Должности */}
            <div>
              <div className="label-caps" style={{ marginBottom: 'var(--spacing-2)' }}>Должности</div>
              {member.assignments.length === 0 ? (
                <p className="label-sm" style={{ margin: '0 0 var(--spacing-3)' }}>Должностей пока нет</p>
              ) : (
                <div className="ui-stack" style={{ gap: '0.375rem', marginBottom: 'var(--spacing-3)' }}>
                  {member.assignments.map((a) => (
                    <div
                      key={a.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
                        border: '1px solid var(--divider)', borderRadius: 'var(--radius-md)', padding: '0.4375rem 0.625rem',
                      }}
                    >
                      <Icon name="position" size={16} style={{ color: 'var(--muted)' }} />
                      <span className="title-sm" style={{ flex: 1, minWidth: 0 }}>
                        {a.positionName}
                        {a.departmentName ? <span className="label-sm"> · {a.departmentName}</span> : null}
                      </span>
                      {a.branchName && <Chip size="sm" icon="branch">{a.branchName}</Chip>}
                      {canStaff && (
                        <IconButton icon="close" label="Снять назначение" size={26} iconSize={13} disabled={busy} onClick={() => unassign(a)} />
                      )}
                    </div>
                  ))}
                </div>
              )}
              {canStaff && (
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 200, flex: 1 }}>
                    <EntitySelector
                      value={pickPos}
                      onChange={setPickPos}
                      types={['position']}
                      multi={false}
                      placeholder="Должность из справочника…"
                      context={{ workspaceId }}
                    />
                  </div>
                  <Select
                    aria-label="Филиал"
                    value={pickBranch}
                    onChange={setPickBranch}
                    width={170}
                    options={[{ value: '', label: 'Без филиала' }, ...dir.branches.map((b) => ({ value: b.id, label: b.name, icon: 'branch' as const }))]}
                  />
                  <Button variant="primary" tone="success" size="sm" icon="add" disabled={!pickPos[0]} loading={busy} onClick={assign}>
                    Назначить
                  </Button>
                </div>
              )}
            </div>

            {/* Реквизиты для договоров и выплат: приезжают с ростером ТОЛЬКО
                управляющим (второй, нередактируемый уровень «Видимости в
                Компаниях») либо когда сотрудник сам открыл поле коллегам. */}
            {member.requisites && <MemberRequisitesBlock req={member.requisites} />}

            {/* Документы сотрудника: оформить приказ и посмотреть, что уже есть.
                Кадровик работает с человеком там, где на него смотрит. */}
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
              <Button variant="matte" size="sm" icon="file" onClick={onSendDocument}>
                Оформить документ
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon="list"
                href={`/workspaces/${workspaceId}/documents?subject=${member.userId}`}
              >
                Его документы
              </Button>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={firing}
        onClose={() => setFiring(false)}
        onConfirm={fire}
        title={`Уволить «${member.userName}»?`}
        message="Назначения снимутся, доступ к рабочим данным закроется. Задачи и переписка сохранятся."
        confirmLabel="Уволить"
        danger
        loading={busy}
      />
    </Modal>
  );
}

/** Реквизитный блок сотрудника (договоры, трудоустройство, выплаты) */
function MemberRequisitesBlock({ req }: { req: NonNullable<WorkspaceMember['requisites']> }) {
  const rows: Array<{ label: string; value: string | null }> = [
    { label: 'ИИН', value: req.iin },
    {
      label: 'Дата рождения',
      value: req.dateOfBirth ? new Date(req.dateOfBirth).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : null,
    },
    { label: 'Адрес проживания', value: req.residentialAddress },
    {
      label: 'Удостоверение',
      value: req.idDocNumber
        ? `№ ${req.idDocNumber}${req.idDocIssuedBy ? `, ${req.idDocIssuedBy}` : ''}${req.idDocIssuedAt ? `, от ${new Date(req.idDocIssuedAt).toLocaleDateString('ru-RU')}` : ''}`
        : null,
    },
    {
      label: 'Карта для выплат',
      value: req.paymentCard
        ? `${req.paymentCard.pan.replace(/(\d{4})(?=\d)/g, '$1 ')} · ${req.paymentCard.holderName}${req.paymentCard.iban ? ` · ${req.paymentCard.iban}` : ''}`
        : null,
    },
  ].filter((r) => !!r.value);
  if (!rows.length) return null;
  return (
    <div>
      <div className="label-caps" style={{ marginBottom: 'var(--spacing-2)' }}>Реквизиты</div>
      <div className="ui-stack" style={{ gap: '0.25rem' }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: 'flex', gap: 'var(--spacing-3)', fontSize: '0.85rem', lineHeight: 1.6 }}>
            <span style={{ color: 'var(--on-surface-variant)', minWidth: 140 }}>{r.label}</span>
            <span style={{ fontWeight: 500 }}>{r.value}</span>
          </div>
        ))}
      </div>
      <p className="label-sm" style={{ margin: 'var(--spacing-2) 0 0', opacity: 0.6 }}>
        Данные для договоров и выплат. Сотрудник видит их в своей анкете; коллегам они не показываются.
      </p>
    </div>
  );
}

// ============================================================
// Справочники: Должности / Отделы / Филиалы
// ============================================================

function PositionsTab({
  workspaceId, dir, canStaff, onError, refresh,
}: {
  workspaceId: string; dir: StaffDirectory; canStaff: boolean;
  onError: (m: string) => void; refresh: () => void;
}) {
  const [name, setName] = useState('');
  const [depId, setDepId] = useState('');
  const [desc, setDesc] = useState('');
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  const create = useMutation({
    mutationFn: async () =>
      api.post(`/workspaces/${workspaceId}/staff/positions`, {
        name: name.trim(),
        departmentId: depId || null,
        description: desc.trim() || null,
      }),
    onSuccess: () => { setName(''); setDepId(''); setDesc(''); onError(''); refresh(); },
    onError: (e) => onError(apiErrorMessage(e)),
  });
  const del = useMutation({
    mutationFn: async (id: string) => api.delete(`/workspaces/${workspaceId}/staff/positions/${id}`),
    onSuccess: () => { setRemoving(null); onError(''); refresh(); },
    onError: (e) => { setRemoving(null); onError(apiErrorMessage(e)); },
  });

  return (
    <>
      <BentoGrid>
        {canStaff && (
          <Card span={12} small>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ width: 240 }}>
                <Input label="Название" value={name} onChange={(e) => setName(e.target.value)} placeholder="Официант, Бухгалтер…" maxLength={100} />
              </div>
              <Select
                label="Отдел"
                value={depId}
                onChange={setDepId}
                width={200}
                options={[{ value: '', label: 'Без отдела' }, ...dir.departments.map((d) => ({ value: d.id, label: d.name, icon: 'department' as const }))]}
              />
              <div style={{ flex: 1, minWidth: 200 }}>
                <Input label="Описание" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Необязательно" maxLength={500} />
              </div>
              <Button variant="primary" tone="success" icon="add" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
                Создать
              </Button>
            </div>
          </Card>
        )}

        <Card span={12}>
          <CardHeader title="Должности" subtitle="Отдел сотрудника — производный от его должности (модель штатного расписания)" />
          {dir.positions.length === 0 ? (
            <EmptyState
              icon="position"
              title="Должностей пока нет"
              description={canStaff ? 'Создайте первую: например «Официант» или «Бухгалтер».' : 'Справочник заполняют управляющие.'}
            />
          ) : (
            <div className="ui-stack" style={{ gap: '0.375rem' }}>
              {dir.positions.map((p) => (
                <DirectoryRow
                  key={p.id}
                  icon="position"
                  title={p.name}
                  subtitle={`${p.departmentName ? `${p.departmentName} · ` : ''}${p.holdersCount ?? 0} чел.${p.description ? ` · ${p.description}` : ''}`}
                  onRemove={canStaff ? () => setRemoving({ id: p.id, name: p.name }) : undefined}
                />
              ))}
            </div>
          )}
        </Card>
      </BentoGrid>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => { if (removing) del.mutate(removing.id); }}
        title={removing ? `Удалить должность «${removing.name}»?` : 'Удалить должность?'}
        message="Если на должности есть люди — удалить не получится, сначала снимите назначения."
        confirmLabel="Удалить"
        danger
        loading={del.isPending}
      />
    </>
  );
}

/** Строка справочника: значок + название + мета + удаление. */
function DirectoryRow({
  icon,
  title,
  subtitle,
  indent = 0,
  onRemove,
}: {
  icon: 'position' | 'department' | 'branch';
  title: string;
  subtitle?: string;
  indent?: number;
  onRemove?: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap',
        marginLeft: indent, padding: '0.5rem 0.75rem',
        border: '1px solid var(--divider)', borderRadius: 'var(--radius-md)',
      }}
    >
      <Icon name={icon} size={18} style={{ color: 'var(--muted)' }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="title-sm">{title}</span>
        {subtitle && <span className="label-sm" style={{ display: 'block', marginTop: '0.125rem' }}>{subtitle}</span>}
      </span>
      {onRemove && <IconButton icon="delete" label={`Удалить «${title}»`} size={30} onClick={onRemove} />}
    </div>
  );
}

function DepartmentsTab({
  workspaceId, dir, canStaff, onError, refresh,
}: {
  workspaceId: string; dir: StaffDirectory; canStaff: boolean;
  onError: (m: string) => void; refresh: () => void;
}) {
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  const create = useMutation({
    mutationFn: async () =>
      api.post(`/workspaces/${workspaceId}/staff/departments`, {
        name: name.trim(),
        parentId: parentId || null,
      }),
    onSuccess: () => { setName(''); setParentId(''); onError(''); refresh(); },
    onError: (e) => onError(apiErrorMessage(e)),
  });
  const del = useMutation({
    mutationFn: async (id: string) => api.delete(`/workspaces/${workspaceId}/staff/departments/${id}`),
    onSuccess: () => { setRemoving(null); onError(''); refresh(); },
    onError: (e) => { setRemoving(null); onError(apiErrorMessage(e)); },
  });

  // Дерево → плоский список с отступами (UI пока простой; канвас оргструктуры — позже).
  const ordered = useMemo(() => {
    const byParent = new Map<string | null, typeof dir.departments>();
    for (const d of dir.departments) {
      const k = d.parentId ?? null;
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k)!.push(d);
    }
    const out: Array<{ dep: (typeof dir.departments)[number]; depth: number }> = [];
    const walk = (parent: string | null, depth: number) => {
      for (const d of byParent.get(parent) ?? []) {
        out.push({ dep: d, depth });
        if (depth < 6) walk(d.id, depth + 1);
      }
    };
    walk(null, 0);
    // Отделы с «потерянным» родителем (на всякий) — в конец без отступа.
    const seen = new Set(out.map((x) => x.dep.id));
    for (const d of dir.departments) if (!seen.has(d.id)) out.push({ dep: d, depth: 0 });
    return out;
  }, [dir.departments]);

  return (
    <>
      <BentoGrid>
        {canStaff && (
          <Card span={12} small>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ width: 260 }}>
                <Input label="Название" value={name} onChange={(e) => setName(e.target.value)} placeholder="Финансовый отдел…" maxLength={100} />
              </div>
              <Select
                label="Родитель"
                value={parentId}
                onChange={setParentId}
                width={220}
                options={[{ value: '', label: 'Корневой отдел' }, ...dir.departments.map((d) => ({ value: d.id, label: `внутри: ${d.name}` }))]}
              />
              <Button variant="primary" tone="success" icon="add" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
                Создать
              </Button>
            </div>
          </Card>
        )}

        <Card span={12}>
          <CardHeader title="Отделы" subtitle="Дерево: грант на отдел достаёт и сотрудников подотделов" />
          {dir.departments.length === 0 ? (
            <EmptyState
              icon="department"
              title="Отделов пока нет"
              description={canStaff ? 'Например «Финансовый отдел» или «Кухня».' : 'Справочник заполняют управляющие.'}
            />
          ) : (
            <div className="ui-stack" style={{ gap: '0.375rem' }}>
              {ordered.map(({ dep, depth }) => (
                <DirectoryRow
                  key={dep.id}
                  icon="department"
                  indent={depth * 22}
                  title={dep.name}
                  subtitle={`${dep.membersCount ?? 0} чел. · ${dep.positionsCount ?? 0} должн.`}
                  onRemove={canStaff ? () => setRemoving({ id: dep.id, name: dep.name }) : undefined}
                />
              ))}
            </div>
          )}
        </Card>
      </BentoGrid>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => { if (removing) del.mutate(removing.id); }}
        title={removing ? `Удалить отдел «${removing.name}»?` : 'Удалить отдел?'}
        message="Должности отцепятся от отдела, подотделы поднимутся в корень."
        confirmLabel="Удалить"
        danger
        loading={del.isPending}
      />
    </>
  );
}

function BranchesTab({
  workspaceId, dir, canStaff, onError, refresh,
}: {
  workspaceId: string; dir: StaffDirectory; canStaff: boolean;
  onError: (m: string) => void; refresh: () => void;
}) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  const create = useMutation({
    mutationFn: async () =>
      api.post(`/workspaces/${workspaceId}/staff/branches`, {
        name: name.trim(),
        address: address.trim() || null,
      }),
    onSuccess: () => { setName(''); setAddress(''); onError(''); refresh(); },
    onError: (e) => onError(apiErrorMessage(e)),
  });
  const del = useMutation({
    mutationFn: async (id: string) => api.delete(`/workspaces/${workspaceId}/staff/branches/${id}`),
    onSuccess: () => { setRemoving(null); onError(''); refresh(); },
    onError: (e) => { setRemoving(null); onError(apiErrorMessage(e)); },
  });

  return (
    <>
      <BentoGrid>
        {canStaff && (
          <Card span={12} small>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ width: 260 }}>
                <Input label="Название" value={name} onChange={(e) => setName(e.target.value)} placeholder="Алматинский филиал…" maxLength={100} />
              </div>
              <div style={{ flex: 1, minWidth: 220 }}>
                <Input label="Адрес" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Необязательно" maxLength={300} />
              </div>
              <Button variant="primary" tone="success" icon="add" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
                Создать
              </Button>
            </div>
          </Card>
        )}

        <Card span={12}>
          <CardHeader title="Филиалы" subtitle="Сотрудник может обслуживать несколько филиалов" />
          {dir.branches.length === 0 ? (
            <EmptyState
              icon="branch"
              title="Филиалов пока нет"
              description={canStaff ? 'Например «Алматинский филиал» или «Офис 1».' : 'Справочник заполняют управляющие.'}
            />
          ) : (
            <div className="ui-stack" style={{ gap: '0.375rem' }}>
              {dir.branches.map((b) => (
                <DirectoryRow
                  key={b.id}
                  icon="branch"
                  title={b.name}
                  subtitle={`${b.membersCount ?? 0} чел.${b.address ? ` · ${b.address}` : ''}`}
                  onRemove={canStaff ? () => setRemoving({ id: b.id, name: b.name }) : undefined}
                />
              ))}
            </div>
          )}
        </Card>
      </BentoGrid>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => { if (removing) del.mutate(removing.id); }}
        title={removing ? `Удалить филиал «${removing.name}»?` : 'Удалить филиал?'}
        message="Если к филиалу привязаны люди — удалить не получится, сначала переведите их."
        confirmLabel="Удалить"
        danger
        loading={del.isPending}
      />
    </>
  );
}

// ============================================================
// Вкладка «Приглашения»: форма 1в1 как «Добавить в окружение» (b2c) —
// номер → поиск человека (имя с инициалом) → блоки-чипы Должность/Филиалы → отправить.
// Наём всегда в Стажёра (роль не выбирается). Филиалов можно несколько.
// ============================================================

interface LookupResult {
  id: string;
  firstName: string;
  lastName: string | null;
  phone: string;
}

/**
 * Блок выбора чипами — та же форма, что RolePicker в «Моё окружение»:
 * подпись сверху, матовые чипы кита в flex-wrap. single = одно значение,
 * multi = несколько (филиалы).
 */
function ChipPickerBlock({
  label, icon, options, selected, onToggle, emptyHint,
}: {
  label: string;
  icon: 'position' | 'branch';
  options: Array<{ id: string; label: string }>;
  selected: string[];
  onToggle: (id: string) => void;
  emptyHint: string;
}) {
  return (
    <Field label={label}>
      {options.length === 0 ? (
        <p className="label-sm" style={{ margin: 0 }}>{emptyHint}</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
          {options.map((o) => (
            <Chip
              key={o.id}
              size="sm"
              tone="accent"
              icon={icon}
              selected={selected.includes(o.id)}
              onClick={() => onToggle(o.id)}
            >
              {o.label}
            </Chip>
          ))}
        </div>
      )}
    </Field>
  );
}

function InvitesTab({
  workspaceId, dir, invites, onError,
}: {
  workspaceId: string;
  dir: StaffDirectory;
  invites: WorkspaceInvitation[];
  onError: (m: string) => void;
}) {
  const qc = useQueryClient();
  const [phone, setPhone] = useState('+7');
  const [posId, setPosId] = useState('');
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [cancelling, setCancelling] = useState<WorkspaceInvitation | null>(null);

  // Поиск по номеру — тот же механизм, что в «Моё окружение» (debounce + /users/lookup).
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [lookupDone, setLookupDone] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePhoneLookup = (value: string) => {
    setPhone(value);
    setLookup(null);
    setLookupDone(false);
    if (lookupTimer.current) clearTimeout(lookupTimer.current);
    if (value.length >= 12) {
      setLookupLoading(true);
      lookupTimer.current = setTimeout(async () => {
        try {
          const { data } = await api.get(`/users/lookup?phone=${encodeURIComponent(value)}`);
          setLookup(data.data);
          setLookupDone(true);
        } catch {
          setLookupDone(true);
        } finally {
          setLookupLoading(false);
        }
      }, 500);
    }
  };

  useEffect(() => {
    return () => { if (lookupTimer.current) clearTimeout(lookupTimer.current); };
  }, []);

  const refresh = () => qc.invalidateQueries({ queryKey: workspaceInvitationsKey(workspaceId) });

  const invite = useMutation({
    mutationFn: async () => {
      if (!/^\+7\d{10}$/.test(phone)) throw new Error('bad-phone');
      return api.post(`/workspaces/${workspaceId}/invitations`, {
        phone,
        positionId: posId || undefined,
        branchIds: branchIds.length ? branchIds : undefined,
        message: message.trim() || undefined,
      });
    },
    onSuccess: () => {
      setPhone('+7'); setLookup(null); setLookupDone(false);
      setPosId(''); setBranchIds([]); setMessage('');
      onError('');
      refresh();
    },
    onError: (e) =>
      onError(
        (e as Error)?.message === 'bad-phone'
          ? 'Номер в формате +7XXXXXXXXXX'
          : apiErrorMessage(e),
      ),
  });
  const cancel = useMutation({
    mutationFn: async (invId: string) => api.post(`/workspaces/${workspaceId}/invitations/${invId}/cancel`),
    onSuccess: () => { setCancelling(null); onError(''); refresh(); },
    onError: (e) => { setCancelling(null); onError(apiErrorMessage(e)); },
  });

  return (
    <>
      <BentoGrid>
        <Card span={7}>
          <CardHeader
            title="Пригласить сотрудника"
            subtitle="Каждый наём — в роли «Стажёр». Роль повышается вручную (позже — после обучения в Додзё)"
          />
          <form onSubmit={(e) => { e.preventDefault(); invite.mutate(); }} className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
            <Input
              label="Номер телефона"
              type="tel"
              value={phone}
              onChange={(e) => handlePhoneLookup(e.target.value)}
              placeholder="+77001234567"
              icon="call"
              autoFocus
            />

            {lookupLoading && <p className="label-sm" style={{ margin: 0 }}>Поиск…</p>}
            {lookupDone && lookup && (
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)',
                  border: '1px solid var(--primary-border)', background: 'var(--primary-container)',
                  borderRadius: 'var(--radius-md)', padding: '0.5rem 0.75rem',
                }}
              >
                <PersonAvatar userId={lookup.id} name={lookup.firstName} size="sm" />
                <span>
                  <span className="title-sm">{lookup.firstName} {lookup.lastName || ''}</span>
                  <span className="label-sm" style={{ display: 'block' }}>{lookup.phone}</span>
                </span>
              </div>
            )}
            {lookupDone && !lookup && (
              <Alert tone="neutral" icon="info">Пользователь не найден — приглашение уйдёт на этот номер</Alert>
            )}

            {/* Должность (одна) + Филиалы (несколько) — чипами, как роли в «Окружении» */}
            <ChipPickerBlock
              label="Должность (необязательно)"
              icon="position"
              options={dir.positions.map((p) => ({ id: p.id, label: p.departmentName ? `${p.name} · ${p.departmentName}` : p.name }))}
              selected={posId ? [posId] : []}
              onToggle={(id) => setPosId((cur) => (cur === id ? '' : id))}
              emptyHint="Создайте должности во вкладке «Должности»"
            />
            <ChipPickerBlock
              label="Филиалы (можно несколько)"
              icon="branch"
              options={dir.branches.map((b) => ({ id: b.id, label: b.name }))}
              selected={branchIds}
              onToggle={(id) => setBranchIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))}
              emptyHint="Создайте филиалы во вкладке «Филиалы»"
            />

            <Input
              label="Сообщение"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={500}
              placeholder="Привет! Приглашаем в команду…"
            />

            <div>
              <Button
                type="submit"
                variant="primary"
                tone="success"
                icon="send"
                disabled={phone.length < 12}
                loading={invite.isPending}
              >
                Отправить приглашение
              </Button>
            </div>
          </form>
        </Card>

        <Card span={5}>
          <CardHeader title="Ожидают ответа" subtitle={invites.length ? `${invites.length} приглашений` : undefined} />
          {invites.length === 0 ? (
            <EmptyState icon="userAdd" title="Нет ожидающих приглашений" description="Отправленные наймы появятся здесь." />
          ) : (
            <div className="ui-stack" style={{ gap: '0.375rem' }}>
              {invites.map((inv) => (
                <div
                  key={inv.id}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-2)',
                    flexWrap: 'wrap', padding: '0.5rem 0.75rem', border: '1px solid var(--divider)',
                    borderRadius: 'var(--radius-md)',
                  }}
                >
                  <span style={{ minWidth: 0 }}>
                    <span className="title-sm">{inv.toPhone}</span>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.25rem' }}>
                      <Chip size="sm" tone="neutral" icon="graduation">Стажёр</Chip>
                      {inv.positionName && <Chip size="sm" icon="position">{inv.positionName}</Chip>}
                      {inv.branchNames.map((b) => <Chip key={b} size="sm" icon="branch">{b}</Chip>)}
                    </span>
                  </span>
                  <IconButton icon="close" label="Отменить приглашение" size={30} onClick={() => setCancelling(inv)} />
                </div>
              ))}
            </div>
          )}
        </Card>
      </BentoGrid>

      <ConfirmDialog
        open={!!cancelling}
        onClose={() => setCancelling(null)}
        onConfirm={() => { if (cancelling) cancel.mutate(cancelling.id); }}
        title="Отменить приглашение?"
        message={cancelling ? `Приглашение на ${cancelling.toPhone} перестанет действовать.` : ''}
        confirmLabel="Отменить приглашение"
        cancelLabel="Оставить"
        danger
        loading={cancel.isPending}
      />
    </>
  );
}
