'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api } from '@/lib/api';
import {
  workspaceKey,
  workspaceMembersKey,
  workspaceStaffKey,
  workspaceInvitationsKey,
} from '@/lib/queries';
import { invalidateEntities, type Principal } from '@/lib/entities';
import { EntitySelector } from '@/components/EntitySelector';
import { PersonChip, StaffPersonCard, type StaffCardData } from '../../../circles/PersonCard';
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

const TABS: Array<{ key: Tab; label: string; manage?: boolean }> = [
  { key: 'people', label: 'Сотрудники' },
  { key: 'positions', label: 'Должности' },
  { key: 'departments', label: 'Отделы' },
  { key: 'branches', label: 'Филиалы' },
  { key: 'invites', label: 'Приглашения', manage: true },
];

const errMsg = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

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
      setError(errMsg(e, 'Не удалось выйти'));
    }
  };

  if (!isReady || wsQ.isLoading || !ws) return <p className="label-md">Загрузка…</p>;

  const dir = staffQ.data ?? { departments: [], positions: [], branches: [] };
  const members = membersQ.data ?? [];
  const visibleTabs = TABS.filter((t) => !t.manage || canStaff);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-5)' }}>
        <h1 className="title-lg">Сотрудники</h1>
        <span className="label-md" style={{ fontSize: '0.85rem' }}>{ws.membersCount} чел.</span>
      </div>

      {/* Вкладки — разделение цветом фона, без линий (DESIGN.md) */}
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', marginBottom: 'var(--spacing-6)' }}>
        {visibleTabs.map((t, i) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setError(''); }}
            className="label-md"
            style={{
              padding: '0.45rem 1rem',
              borderRadius: 'var(--radius-md)',
              border: 'none',
              cursor: 'pointer',
              transform: `rotate(${i % 2 ? 0.4 : -0.4}deg)`,
              background: tab === t.key ? 'var(--secondary-container)' : 'var(--surface-container-low)',
              color: tab === t.key ? 'var(--on-secondary-container)' : 'var(--on-surface-variant)',
              boxShadow: tab === t.key ? '2px 3px 0 rgba(56,57,45,0.12)' : 'none',
              fontWeight: tab === t.key ? 700 : 500,
            }}
          >
            {t.label}
            {t.key === 'invites' && (invitesQ.data?.length ?? 0) > 0 ? ` · ${invitesQ.data!.length}` : ''}
          </button>
        ))}
      </div>

      {error && (
        <p className="label-md" style={{ color: 'var(--primary)', marginBottom: 'var(--spacing-4)' }}>{error}</p>
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

      {/* Выход (не владелец) */}
      {myRole && myRole !== 'owner' && (
        <div style={{ marginTop: 'var(--spacing-10)' }}>
          <button onClick={leave} className="btn-secondary" style={{ padding: '0.5rem 1.25rem', color: 'var(--primary)' }}>
            Выйти из организации
          </button>
        </div>
      )}
    </div>
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

  // Бейдж карты = Должности; филиалы — отдельные чипы (роль организации на карте не видна).
  const positionsOf = (m: WorkspaceMember) =>
    [...new Set(m.assignments.map((a) => a.positionName))];
  const branchesOf = (m: WorkspaceMember) =>
    [...new Set(m.assignments.map((a) => a.branchName).filter((b): b is string => !!b))];

  // Страховка от устаревшего кэша (member без card после обновления контракта).
  const cardOf = (m: WorkspaceMember): StaffCardData => {
    if (m.card) return m.card;
    const [fn, ln] = splitName(m.userName);
    return {
      phone: '', firstName: fn, lastName: ln, avatar: m.userAvatar,
      dateOfBirth: null, bio: null, city: null, email: null, maritalStatus: null,
      socialLinks: null, age: null, showOnlineStatus: false,
    };
  };

  const managed = managedId ? members.find((m) => m.userId === managedId) ?? null : null;

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
      onError(errMsg(e, 'Не удалось открыть чат'));
    }
  };

  const renderGrid = (list: WorkspaceMember[]) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--spacing-6)', alignItems: 'start' }}>
      {list.map((m) => (
        <StaffPersonCard
          key={m.id}
          userId={m.userId}
          card={cardOf(m)}
          positions={positionsOf(m)}
          branches={branchesOf(m)}
          onWrite={m.userId !== meId ? () => writeTo(m) : undefined}
          onManage={canStaff || canManage ? () => setManagedId(m.userId) : undefined}
        />
      ))}
    </div>
  );

  return (
    <div>
      {/* Фильтры */}
      <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', marginBottom: 'var(--spacing-5)' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по имени…" className="input" style={{ width: 180 }} />
        <select value={fDep} onChange={(e) => setFDep(e.target.value)} className="input" style={{ width: 160 }}>
          <option value="">Все отделы</option>
          {dir.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select value={fPos} onChange={(e) => setFPos(e.target.value)} className="input" style={{ width: 170 }}>
          <option value="">Все должности</option>
          {dir.positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={fBr} onChange={(e) => setFBr(e.target.value)} className="input" style={{ width: 170 }}>
          <option value="">Все филиалы</option>
          {dir.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select value={fRole} onChange={(e) => setFRole(e.target.value)} className="input" style={{ width: 150 }}>
          <option value="">Все роли</option>
          {(['owner', 'admin', 'manager', 'staff', 'trainee'] as const).map((r) => (
            <option key={r} value={r}>{roleLabel(r)}</option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 'var(--spacing-10)', color: 'var(--on-surface-variant)' }}>
          <p className="label-md">Никого не найдено</p>
        </div>
      ) : (
        renderGrid(filtered)
      )}

      {/* Подрядчики (Коллаб-модель) — отдельной секцией, только управляющим */}
      {canManage && contractors.length > 0 && (
        <div style={{ marginTop: 'var(--spacing-8)' }}>
          <h2 className="title-md" style={{ marginBottom: 'var(--spacing-2)' }}>Подрядчики</h2>
          <p className="label-md" style={{ fontSize: '0.78rem', opacity: 0.65, marginBottom: 'var(--spacing-4)' }}>
            Внешние исполнители: видят только свои задачи. Назначаются сервисами (Тайный гость, UGC), не вручную.
          </p>
          {renderGrid(contractors)}
        </div>
      )}

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
          onError={onError}
          refreshStaff={refreshStaff}
        />
      )}
    </div>
  );
}

/** Окно управления сотрудником: роль + должности + увольнение. */
function MemberModal({
  workspaceId, member, dir, meId, myRole, canManage, canStaff, isOwnerRow, onClose, onError, refreshStaff,
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
  onError: (m: string) => void;
  refreshStaff: () => void;
}) {
  const qc = useQueryClient();
  const [newRole, setNewRole] = useState<WorkspaceRole>(member.role);
  const [pickPos, setPickPos] = useState<Principal[]>([]);
  const [pickBranch, setPickBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');

  const isSelf = member.userId === meId;
  const isContractor = member.role === 'contractor';
  // Лестница: админа назначает/трогает только владелец; подрядчику роль/должности не меняются.
  const assignable: readonly WorkspaceRole[] =
    myRole === 'owner' ? OWNER_ASSIGNABLE_WORKSPACE_ROLES : ADMIN_ASSIGNABLE_WORKSPACE_ROLES;
  const canChangeRole =
    canManage && !isContractor && !isOwnerRow && !isSelf && (myRole === 'owner' || member.role !== 'admin');
  const canFire =
    canManage && !isOwnerRow && !isSelf && (myRole === 'owner' || member.role !== 'admin');

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setLocalError('');
    try {
      await fn();
      refreshStaff();
    } catch (e) {
      setLocalError(errMsg(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  const changeRole = () =>
    run(async () => {
      await api.patch(`/workspaces/${workspaceId}/members/${member.userId}`, { role: newRole });
    }, 'Не удалось сменить роль');

  const assign = () =>
    run(async () => {
      if (!pickPos[0]) return;
      await api.post(`/workspaces/${workspaceId}/staff/members/${member.userId}/assignments`, {
        positionId: pickPos[0].id,
        branchId: pickBranch || null,
      });
      setPickPos([]);
      setPickBranch('');
    }, 'Не удалось назначить должность');

  const unassign = (a: StaffAssignment) =>
    run(async () => {
      await api.delete(`/workspaces/${workspaceId}/staff/assignments/${a.id}`);
    }, 'Не удалось снять назначение');

  const fire = async () => {
    if (!confirm(`Уволить «${member.userName}»?`)) return;
    setBusy(true);
    setLocalError('');
    try {
      await api.delete(`/workspaces/${workspaceId}/members/${member.userId}`);
      qc.invalidateQueries({ queryKey: workspaceKey(workspaceId) });
      refreshStaff();
      onClose();
    } catch (e) {
      setLocalError(errMsg(e, 'Не удалось уволить'));
      setBusy(false);
    }
  };

  const [fn, ln] = splitName(member.userName);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(56,57,45,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--spacing-4)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card-elevated"
        style={{ width: 'min(560px, 100%)', maxHeight: '85vh', overflowY: 'auto', padding: 'var(--spacing-6)', background: 'var(--surface)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-5)' }}>
          <PersonChip
            size="M"
            userId={member.userId}
            firstName={fn}
            lastName={ln}
            avatar={member.userAvatar}
            role={roleLabel(member.role)}
          />
          <button onClick={onClose} title="Закрыть" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: 'var(--on-surface-variant)', lineHeight: 1 }}>×</button>
        </div>

        {localError && (
          <p className="label-md" style={{ color: 'var(--primary)', marginBottom: 'var(--spacing-4)' }}>{localError}</p>
        )}

        {isContractor ? (
          <p className="label-md" style={{ fontSize: '0.85rem', opacity: 0.7, marginBottom: 'var(--spacing-5)' }}>
            Подрядчик: доступ только к своим задачам. Роль и должности не назначаются — ими управляет выдавший сервис.
          </p>
        ) : (
          <>
            {/* Роль */}
            {canChangeRole && (
              <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexWrap: 'wrap', marginBottom: 'var(--spacing-5)' }}>
                <span className="label-md" style={{ fontSize: '0.8rem', width: 90 }}>Роль</span>
                <select value={newRole} onChange={(e) => setNewRole(e.target.value as WorkspaceRole)} className="input" style={{ width: 170 }}>
                  {assignable.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
                </select>
                <button onClick={changeRole} disabled={busy || newRole === member.role} className="btn-secondary" style={{ padding: '0.35rem 0.9rem', fontSize: '0.8rem' }}>
                  Сменить
                </button>
              </div>
            )}
            {canManage && !canChangeRole && !isSelf && !isOwnerRow && member.role === 'admin' && (
              <p className="label-md" style={{ fontSize: '0.75rem', opacity: 0.6, marginBottom: 'var(--spacing-4)' }}>
                Роль Админа меняет только Владелец
              </p>
            )}

            {/* Должности */}
            <div style={{ display: 'grid', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-5)' }}>
              <span className="label-md" style={{ fontSize: '0.8rem' }}>Должности</span>
              {member.assignments.length === 0 && (
                <span className="label-md" style={{ fontSize: '0.8rem', opacity: 0.55 }}>Должностей пока нет</span>
              )}
              {member.assignments.map((a) => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap', background: 'var(--surface-container-low)', borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.6rem' }}>
                  <span className="label-md" style={{ fontSize: '0.85rem', fontWeight: 600, flex: 1, minWidth: 0 }}>
                    💼 {a.positionName}
                    {a.departmentName ? ` · ${a.departmentName}` : ''}
                    {a.branchName ? ` · 📍 ${a.branchName}` : ''}
                  </span>
                  {canStaff && (
                    <button onClick={() => unassign(a)} disabled={busy} title="Снять назначение" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--on-surface-variant)' }}>×</button>
                  )}
                </div>
              ))}
              {canStaff && (
                <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
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
                  <select value={pickBranch} onChange={(e) => setPickBranch(e.target.value)} className="input" style={{ width: 160 }}>
                    <option value="">Без филиала</option>
                    {dir.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                  <button onClick={assign} disabled={busy || !pickPos[0]} className="btn-primary" style={{ padding: '0.45rem 1rem', fontSize: '0.8rem' }}>
                    Назначить
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* Увольнение */}
        {canFire && (
          <button onClick={fire} disabled={busy} className="btn-secondary" style={{ padding: '0.35rem 0.9rem', fontSize: '0.8rem', color: 'var(--primary)' }}>
            Уволить
          </button>
        )}
      </div>
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

  const create = useMutation({
    mutationFn: async () =>
      api.post(`/workspaces/${workspaceId}/staff/positions`, {
        name: name.trim(),
        departmentId: depId || null,
        description: desc.trim() || null,
      }),
    onSuccess: () => { setName(''); setDepId(''); setDesc(''); onError(''); refresh(); },
    onError: (e) => onError(errMsg(e, 'Не удалось создать должность')),
  });
  const del = useMutation({
    mutationFn: async (id: string) => api.delete(`/workspaces/${workspaceId}/staff/positions/${id}`),
    onSuccess: () => { onError(''); refresh(); },
    onError: (e) => onError(errMsg(e, 'Не удалось удалить должность')),
  });

  return (
    <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
      {canStaff && (
        <div className="card" style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название (Официант, Бухгалтер…)" maxLength={100} className="input" style={{ width: 230 }} />
          <select value={depId} onChange={(e) => setDepId(e.target.value)} className="input" style={{ width: 180 }}>
            <option value="">Без отдела</option>
            {dir.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Описание (необязательно)" maxLength={500} className="input" style={{ flex: 1, minWidth: 180 }} />
          <button onClick={() => name.trim() && create.mutate()} disabled={create.isPending || !name.trim()} className="btn-primary" style={{ padding: '0.5rem 1.1rem' }}>
            Создать
          </button>
        </div>
      )}
      {dir.positions.map((p) => (
        <div key={p.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
          <div>
            <span className="title-md" style={{ fontSize: '0.95rem' }}>💼 {p.name}</span>
            <p className="label-md" style={{ fontSize: '0.78rem', opacity: 0.7 }}>
              {p.departmentName ? `${p.departmentName} · ` : ''}{p.holdersCount ?? 0} чел.{p.description ? ` · ${p.description}` : ''}
            </p>
          </div>
          {canStaff && (
            <button onClick={() => del.mutate(p.id)} disabled={del.isPending} className="btn-secondary" style={{ padding: '0.35rem 0.9rem', fontSize: '0.8rem' }}>
              Удалить
            </button>
          )}
        </div>
      ))}
      {dir.positions.length === 0 && (
        <p className="label-md" style={{ opacity: 0.6 }}>
          Должностей пока нет{canStaff ? ' — создайте первую: например «Официант» или «Бухгалтер»' : ''}
        </p>
      )}
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

  const create = useMutation({
    mutationFn: async () =>
      api.post(`/workspaces/${workspaceId}/staff/departments`, {
        name: name.trim(),
        parentId: parentId || null,
      }),
    onSuccess: () => { setName(''); setParentId(''); onError(''); refresh(); },
    onError: (e) => onError(errMsg(e, 'Не удалось создать отдел')),
  });
  const del = useMutation({
    mutationFn: async (id: string) => api.delete(`/workspaces/${workspaceId}/staff/departments/${id}`),
    onSuccess: () => { onError(''); refresh(); },
    onError: (e) => onError(errMsg(e, 'Не удалось удалить отдел')),
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
    <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
      {canStaff && (
        <div className="card" style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название (Финансовый отдел…)" maxLength={100} className="input" style={{ width: 240 }} />
          <select value={parentId} onChange={(e) => setParentId(e.target.value)} className="input" style={{ width: 200 }}>
            <option value="">Корневой отдел</option>
            {dir.departments.map((d) => <option key={d.id} value={d.id}>внутри: {d.name}</option>)}
          </select>
          <button onClick={() => name.trim() && create.mutate()} disabled={create.isPending || !name.trim()} className="btn-primary" style={{ padding: '0.5rem 1.1rem' }}>
            Создать
          </button>
        </div>
      )}
      {ordered.map(({ dep, depth }) => (
        <div key={dep.id} className="card" style={{ marginLeft: depth * 22, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
          <div>
            <span className="title-md" style={{ fontSize: '0.95rem' }}>🏛️ {dep.name}</span>
            <p className="label-md" style={{ fontSize: '0.78rem', opacity: 0.7 }}>
              {dep.membersCount ?? 0} чел. · {dep.positionsCount ?? 0} должн.
            </p>
          </div>
          {canStaff && (
            <button onClick={() => del.mutate(dep.id)} disabled={del.isPending} className="btn-secondary" style={{ padding: '0.35rem 0.9rem', fontSize: '0.8rem' }}>
              Удалить
            </button>
          )}
        </div>
      ))}
      {dir.departments.length === 0 && (
        <p className="label-md" style={{ opacity: 0.6 }}>
          Отделов пока нет{canStaff ? ' — например «Финансовый отдел» или «Кухня»' : ''}
        </p>
      )}
    </div>
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

  const create = useMutation({
    mutationFn: async () =>
      api.post(`/workspaces/${workspaceId}/staff/branches`, {
        name: name.trim(),
        address: address.trim() || null,
      }),
    onSuccess: () => { setName(''); setAddress(''); onError(''); refresh(); },
    onError: (e) => onError(errMsg(e, 'Не удалось создать филиал')),
  });
  const del = useMutation({
    mutationFn: async (id: string) => api.delete(`/workspaces/${workspaceId}/staff/branches/${id}`),
    onSuccess: () => { onError(''); refresh(); },
    onError: (e) => onError(errMsg(e, 'Не удалось удалить филиал')),
  });

  return (
    <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
      {canStaff && (
        <div className="card" style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название (Алматинский филиал…)" maxLength={100} className="input" style={{ width: 240 }} />
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Адрес (необязательно)" maxLength={300} className="input" style={{ flex: 1, minWidth: 200 }} />
          <button onClick={() => name.trim() && create.mutate()} disabled={create.isPending || !name.trim()} className="btn-primary" style={{ padding: '0.5rem 1.1rem' }}>
            Создать
          </button>
        </div>
      )}
      {dir.branches.map((b) => (
        <div key={b.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
          <div>
            <span className="title-md" style={{ fontSize: '0.95rem' }}>📍 {b.name}</span>
            <p className="label-md" style={{ fontSize: '0.78rem', opacity: 0.7 }}>
              {b.membersCount ?? 0} чел.{b.address ? ` · ${b.address}` : ''}
            </p>
          </div>
          {canStaff && (
            <button onClick={() => del.mutate(b.id)} disabled={del.isPending} className="btn-secondary" style={{ padding: '0.35rem 0.9rem', fontSize: '0.8rem' }}>
              Удалить
            </button>
          )}
        </div>
      ))}
      {dir.branches.length === 0 && (
        <p className="label-md" style={{ opacity: 0.6 }}>
          Филиалов пока нет{canStaff ? ' — например «Алматинский филиал» или «Офис 1»' : ''}
        </p>
      )}
    </div>
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
 * Блок выбора чипами — визуальный клон RolePicker из «Моё окружение» (серая карта,
 * label сверху, чипы flex-wrap). single = одно значение, multi = несколько (филиалы).
 */
function ChipPickerBlock({
  label, options, selected, onToggle, emptyHint,
}: {
  label: string;
  options: Array<{ id: string; label: string }>;
  selected: string[];
  onToggle: (id: string) => void;
  emptyHint: string;
}) {
  return (
    <div className="card" style={{ padding: 'var(--spacing-4)' }}>
      <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-3)' }}>{label}</label>
      {options.length === 0 ? (
        <p className="label-sm" style={{ opacity: 0.6 }}>{emptyHint}</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
          {options.map((o) => {
            const on = selected.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => onToggle(o.id)}
                style={{
                  padding: '0.3rem 0.7rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sketch)',
                  border: 'none', cursor: 'pointer', fontWeight: 500,
                  background: on ? 'var(--secondary-container)' : 'var(--surface-container-low)',
                  color: on ? 'var(--secondary)' : 'var(--on-surface-variant)',
                  transition: 'background 0.15s',
                }}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
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
          : errMsg(e, 'Не удалось отправить приглашение'),
      ),
  });
  const cancel = useMutation({
    mutationFn: async (invId: string) => api.post(`/workspaces/${workspaceId}/invitations/${invId}/cancel`),
    onSuccess: () => { onError(''); refresh(); },
    onError: (e) => onError(errMsg(e, 'Не удалось отменить')),
  });

  return (
    <div>
      <form
        onSubmit={(e) => { e.preventDefault(); invite.mutate(); }}
        className="card-elevated"
        style={{ marginBottom: 'var(--spacing-8)', padding: 'var(--spacing-6)' }}
      >
        <h3 className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>Пригласить сотрудника</h3>

        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Номер телефона</label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => handlePhoneLookup(e.target.value)}
            placeholder="+77001234567"
            className="input-sketch"
            autoFocus
          />
        </div>

        {lookupLoading && <p className="label-sm" style={{ marginBottom: 'var(--spacing-4)' }}>Поиск...</p>}
        {lookupDone && lookup && (
          <div className="wash-secondary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-6)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
            <PersonAvatar userId={lookup.id} name={lookup.firstName} size="sm" />
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{lookup.firstName} {lookup.lastName || ''}</div>
              <div className="label-sm">{lookup.phone}</div>
            </div>
          </div>
        )}
        {lookupDone && !lookup && (
          <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-6)', fontSize: '0.85rem', color: 'var(--on-surface-variant)' }}>
            Пользователь не найден — приглашение уйдёт на этот номер
          </div>
        )}

        {/* Должность (одна) + Филиалы (несколько) — чипами, как роли в «Окружении» */}
        <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
          <ChipPickerBlock
            label="Должность (необязательно)"
            options={dir.positions.map((p) => ({ id: p.id, label: p.departmentName ? `${p.name} · ${p.departmentName}` : p.name }))}
            selected={posId ? [posId] : []}
            onToggle={(id) => setPosId((cur) => (cur === id ? '' : id))}
            emptyHint="Создайте должности во вкладке «Должности»"
          />
          <ChipPickerBlock
            label="Филиалы (можно несколько)"
            options={dir.branches.map((b) => ({ id: b.id, label: b.name }))}
            selected={branchIds}
            onToggle={(id) => setBranchIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))}
            emptyHint="Создайте филиалы во вкладке «Филиалы»"
          />
        </div>

        <div style={{ marginBottom: 'var(--spacing-4)' }}>
          <label className="label-md" style={{ display: 'block', marginBottom: 'var(--spacing-2)' }}>Сообщение</label>
          <input type="text" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} placeholder="Привет! Приглашаем в команду..." className="input-sketch" />
        </div>

        <p className="label-sm" style={{ opacity: 0.65, marginBottom: 'var(--spacing-4)' }}>
          Каждый наём — в роли «Стажёр». Роль повышается вручную (позже — автоматически после обучения в Додзё).
        </p>

        <button
          type="submit"
          disabled={invite.isPending || phone.length < 12}
          className="btn-primary"
          style={{ fontSize: '0.9rem', opacity: invite.isPending || phone.length < 12 ? 0.6 : 1 }}
        >
          {invite.isPending ? 'Отправка...' : 'Отправить приглашение'}
        </button>
      </form>

      <h2 className="title-md" style={{ marginBottom: 'var(--spacing-3)' }}>Ожидают ответа</h2>
      <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
        {invites.map((inv) => (
          <div key={inv.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
            <div>
              <span className="title-md" style={{ fontSize: '0.95rem' }}>{inv.toPhone}</span>
              <p className="label-md" style={{ fontSize: '0.8rem' }}>
                Стажёр
                {inv.positionName ? ` · 💼 ${inv.positionName}` : ''}
                {inv.branchNames.length ? ` · 📍 ${inv.branchNames.join(', ')}` : ''}
              </p>
            </div>
            <button onClick={() => cancel.mutate(inv.id)} disabled={cancel.isPending} className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>
              Отменить
            </button>
          </div>
        ))}
        {invites.length === 0 && <p className="label-md" style={{ opacity: 0.6 }}>Нет ожидающих приглашений</p>}
      </div>
    </div>
  );
}
