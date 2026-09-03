'use client';

import { useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiErrorMessage, apiGet, apiPatch, apiPost } from '@/lib/api';
import { workspaceKey, hrRosterOverviewKey, orgScopeKey, workspaceMemberKey } from '@/lib/queries';
import { fetchHrRosterOverview } from '@/lib/hr-api';
import { fetchOrgScope } from '@/lib/org-api';
import { type Principal } from '@/lib/entities';
import { EntitySelector } from '@/components/EntitySelector';
import {
  Alert, BentoGrid, Button, Card, CardHeader, Chip, ConfirmDialog, EmptyState, Field,
  Icon, IconButton, LoadingBlock, Modal, SearchField, Select,
} from '@/components/ui';
import { PersonChip, StaffPersonCard } from '../../../circles/PersonCard';
import { SubmitDocumentModal } from '../documents/SubmitDocumentModal';
import {
  ADMIN_ASSIGNABLE_WORKSPACE_ROLES,
  OWNER_ASSIGNABLE_WORKSPACE_ROLES,
  type WorkspaceMember,
  type WorkspaceRole,
  type StaffDirectory,
  type StaffAssignment,
  type ContactUserCard,
  type ChatDetail,
} from '@superapp/shared';
import { MemberRequisitesBlock, MembersHeader, roleLabel, splitName, useLegacyMembersTabRedirect, useMembersBase } from './members-lib';

/**
 * Сервис «Сотрудники» (B2B), раздел «Люди»: ростер L-карточками (как «Моё
 * окружение»), фильтры, окно управления (роль + назначения + реквизиты +
 * увольнение). Остальные разделы — свои маршруты (второй уровень сайдбара):
 * Орг. структура · Объекты · Приглашения · Сроки.
 * Чтение — вся команда; назначения — Менеджер+ и руководители своих веток/объектов
 * (область считает СЕРВЕР — 403 приходит текстом); роли/увольнение — Админ+.
 */
export default function WorkspaceStaffPage() {
  const router = useRouter();
  const { id: workspaceId } = useParams<{ id: string }>();
  useLegacyMembersTabRedirect(workspaceId);
  const { isReady, user, ws, wsQ, myRole, canManage, canStaff, dir, members, refreshStaff } = useMembersBase(workspaceId);
  // Назначения правит не только Менеджер+: сервер пускает руководителя отдела и
  // управляющего объектом в их области. Роль этого не знает — область считает
  // сервер (`/org/my-scope`), поэтому ростер спрашивает её, а не гадает по роли.
  const scopeQ = useQuery({ queryKey: orgScopeKey(workspaceId), queryFn: () => fetchOrgScope(workspaceId), enabled: isReady, retry: false });
  const canAssign = canStaff || (scopeQ.data?.kind ?? 'none') !== 'none';
  const [error, setError] = useState('');
  const [leaving, setLeaving] = useState(false);

  const leave = async () => {
    try {
      await apiPost(`/workspaces/${workspaceId}/leave`);
      router.push('/dashboard');
    } catch (e) {
      setLeaving(false);
      setError(apiErrorMessage(e));
    }
  };

  if (!isReady || wsQ.isLoading || !ws) return <LoadingBlock />;

  return (
    <MembersHeader
      ws={ws}
      title="Сотрудники"
      description="Ростер организации: карточки людей, должности, объекты"
      error={error}
      onCloseError={() => setError('')}
      // Матовая, а не призрачная: кнопка стоит на ФОНЕ СТРАНИЦЫ, а призрачная
      // там остаётся без подложки и выпадает из системы (правило из календаря).
      actions={
        myRole && myRole !== 'owner' ? (
          <Button variant="matte" tone="danger" icon="signOut" onClick={() => setLeaving(true)}>
            Выйти из организации
          </Button>
        ) : undefined
      }
    >
      <PeopleSection
        workspaceId={workspaceId}
        members={members}
        dir={dir}
        meId={user?.id}
        myRole={myRole}
        canManage={canManage}
        canStaff={canStaff}
        canAssign={canAssign}
        ownerId={ws.ownerId}
        onError={setError}
        refreshStaff={refreshStaff}
      />

      <ConfirmDialog
        open={leaving}
        onClose={() => setLeaving(false)}
        onConfirm={leave}
        title="Выйти из организации?"
        message="Ваши назначения снимутся, доступ к рабочим данным закроется. Вернуться можно только по новому приглашению."
        confirmLabel="Выйти"
        danger
      />
    </MembersHeader>
  );
}

// ============================================================
// Ростер: фильтры + L-грид (как «Моё окружение») + клик по карточке → окно управления
// ============================================================

function PeopleSection({
  workspaceId, members, dir, meId, myRole, canManage, canStaff, canAssign, ownerId, onError, refreshStaff,
}: {
  workspaceId: string;
  members: WorkspaceMember[];
  dir: StaffDirectory;
  meId?: string;
  myRole?: WorkspaceRole;
  canManage: boolean;
  canStaff: boolean;
  /** Есть ли ХОТЬ КАКАЯ-ТО область правки назначений (роль manager+ или своя ветка/объект) */
  canAssign: boolean;
  ownerId: string;
  onError: (m: string) => void;
  refreshStaff: () => void;
}) {
  const router = useRouter();
  const [fDep, setFDep] = useState('');
  const [fPos, setFPos] = useState('');
  const [fBr, setFBr] = useState('');
  const [fRole, setFRole] = useState('');
  const [fHr, setFHr] = useState('');
  const [q, setQ] = useState('');
  const [managedId, setManagedId] = useState<string | null>(null);

  // КЭДО: кадровая сводка для фильтров «нет договора / расхождение» (Менеджер+)
  const hrOverviewQ = useQuery({
    queryKey: hrRosterOverviewKey(workspaceId),
    queryFn: () => fetchHrRosterOverview(workspaceId),
    enabled: canStaff,
    retry: false,
  });
  const hrByUser = hrOverviewQ.data?.byUser ?? {};

  const team = members.filter((m) => m.role !== 'contractor');
  const contractors = members.filter((m) => m.role === 'contractor');

  const filtered = team.filter((m) => {
    if (fDep && !m.assignments.some((a) => a.departmentId === fDep)) return false;
    if (fPos && !m.assignments.some((a) => a.positionId === fPos)) return false;
    if (fBr && !m.assignments.some((a) => a.branchId === fBr)) return false;
    if (fRole && m.role !== fRole) return false;
    if (fHr === 'no_contract' && hrByUser[m.userId]) return false;
    if (fHr === 'mismatch' && !hrByUser[m.userId]?.mismatch) return false;
    if (fHr === 'no_position' && m.assignments.length > 0) return false;
    if (q && !m.userName.toLowerCase().includes(q.trim().toLowerCase())) return false;
    return true;
  });

  const hasFilter = !!(fDep || fPos || fBr || fRole || fHr || q);
  const clearFilters = () => { setFDep(''); setFPos(''); setFBr(''); setFRole(''); setFHr(''); setQ(''); };

  // Пропсы карточек считаются ОДИН раз на список и переживают кейстроки поиска:
  // StaffPersonCard обёрнут в memo, и именно стабильность этих объектов позволяет
  // ему НЕ перерисовываться на каждый ввод в фильтрах.
  const cardProps = useMemo(() => {
    const map = new Map<string, { card: ContactUserCard; positions: string[]; branches: string[] }>();
    for (const m of members) {
      let card: ContactUserCard;
      if (m.card) {
        card = m.card;
      } else {
        const [fn, ln] = splitName(m.userName);
        card = {
          id: m.userId,
          phone: '', firstName: fn, lastName: ln, avatar: m.userAvatar,
          dateOfBirth: null, bio: null, city: null, email: null, maritalStatus: null,
          socialLinks: null, age: null, showOnlineStatus: false,
        };
      }
      // Основное место — первым: бейдж карты = должности по порядку значимости.
      const ordered = [...m.assignments].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
      map.set(m.userId, {
        card,
        positions: [...new Set(ordered.map((a) => a.positionName))],
        branches: [...new Set(ordered.map((a) => a.branchName).filter((b): b is string => !!b))],
      });
    }
    return map;
  }, [members]);

  const managed = managedId ? members.find((m) => m.userId === managedId) ?? null : null;
  const [documentFor, setDocumentFor] = useState<WorkspaceMember | null>(null);

  // «Написать» — DM через «рабочий пропуск» (заголовок организации), затем в чат.
  const writeTo = async (m: WorkspaceMember) => {
    try {
      const chat = await apiPost<ChatDetail>('/messenger/chats/dm', { userId: m.userId }, { headers: { 'X-Workspace-Id': workspaceId } });
      router.push(`/messenger?chat=${chat.id}`);
    } catch (e) {
      onError(apiErrorMessage(e));
    }
  };
  const writeToRef = useRef(writeTo);
  writeToRef.current = writeTo;
  const actions = useMemo(() => {
    const map = new Map<string, { onWrite?: () => void; onManage?: () => void }>();
    for (const m of members) {
      map.set(m.userId, {
        onWrite: m.userId !== meId ? () => void writeToRef.current(m) : undefined,
        onManage: canAssign || canManage ? () => setManagedId(m.userId) : undefined,
      });
    }
    return map;
  }, [members, meId, canAssign, canManage]);

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
          cardHref={`/workspaces/${workspaceId}/members/${m.userId}`}
        />
      ))}
    </div>
  );

  return (
    <>
      <BentoGrid>
        <Card span={12} small>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <SearchField value={q} onChange={(e) => setQ(e.target.value)} onClear={() => setQ('')} placeholder="Поиск по имени…" width={200} aria-label="Поиск по имени" />
            <Select aria-label="Отдел" value={fDep} onChange={setFDep} width={170}
              options={[{ value: '', label: 'Все отделы', icon: 'department' }, ...dir.departments.map((d) => ({ value: d.id, label: d.name }))]} />
            <Select aria-label="Должность" value={fPos} onChange={setFPos} width={180}
              options={[{ value: '', label: 'Все должности', icon: 'position' }, ...dir.positions.map((p) => ({ value: p.id, label: p.name }))]} />
            <Select aria-label="Объект" value={fBr} onChange={setFBr} width={180}
              options={[{ value: '', label: 'Все объекты', icon: 'branch' }, ...dir.branches.map((b) => ({ value: b.id, label: b.name }))]} />
            <Select aria-label="Роль" value={fRole} onChange={setFRole} width={160}
              options={[{ value: '', label: 'Все роли', icon: 'user' }, ...(['owner', 'admin', 'manager', 'staff', 'trainee'] as const).map((r) => ({ value: r, label: roleLabel(r) }))]} />
            {canStaff && (
              <Select aria-label="Кадры" value={fHr} onChange={setFHr} width={200}
                options={[
                  { value: '', label: 'Кадры: все', icon: 'file' },
                  { value: 'no_position', label: 'Без назначения (вне структуры)' },
                  { value: 'no_contract', label: 'Нет трудовой карточки' },
                  { value: 'mismatch', label: 'Расхождение факт/договор' },
                ]} />
            )}
            {hasFilter && <Button variant="ghost" size="sm" icon="close" onClick={clearFilters}>Сбросить</Button>}
          </div>
        </Card>

        <Card span={12}>
          <CardHeader title="Команда" subtitle={hasFilter ? `Найдено: ${filtered.length} из ${team.length}` : `${team.length} чел.`} />
          {filtered.length === 0 ? (
            <EmptyState
              icon="people"
              title={hasFilter ? 'Никого не найдено' : 'В команде пока никого'}
              description={hasFilter ? 'Смягчите фильтры или сбросьте их.' : 'Наймите первого сотрудника в разделе «Приглашения».'}
              action={hasFilter ? <Button variant="matte" icon="close" onClick={clearFilters}>Сбросить фильтры</Button> : undefined}
            />
          ) : (
            renderGrid(filtered)
          )}
        </Card>

        {canManage && contractors.length > 0 && (
          <Card span={12}>
            <CardHeader title="Подрядчики" subtitle="Внешние исполнители: видят только свои задачи. Назначаются сервисами (Тайный гость, UGC), не вручную" />
            {renderGrid(contractors)}
          </Card>
        )}
      </BentoGrid>

      {managed && (canAssign || canManage) && (
        <MemberModal
          workspaceId={workspaceId}
          member={managed}
          dir={dir}
          meId={meId}
          myRole={myRole}
          canManage={canManage}
          canStaff={canAssign}
          isOwnerRow={managed.userId === ownerId}
          onClose={() => setManagedId(null)}
          refreshStaff={refreshStaff}
          onSendDocument={() => { setManagedId(null); setDocumentFor(managed); }}
        />
      )}

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

/** Окно управления сотрудником: роль + должности (объект, основное место) + увольнение. */
function MemberModal({
  workspaceId, member, dir, meId, myRole, canManage, canStaff, isOwnerRow, onClose, refreshStaff, onSendDocument,
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
  onSendDocument: () => void;
}) {
  const qc = useQueryClient();
  // Реквизиты приезжают ПО ОДНОМУ человеку и только когда его открыли: в списке
  // их нет (расшифровка карт всей организации на каждый заход — слишком дорого
  // и слишком много данных «на всякий случай»).
  const detailsQ = useQuery({
    queryKey: workspaceMemberKey(workspaceId, member.userId),
    queryFn: async () => await apiGet<WorkspaceMember>(`/workspaces/${workspaceId}/members/${member.userId}`),
  });
  const requisites = detailsQ.data?.requisites;
  const [newRole, setNewRole] = useState<WorkspaceRole>(member.role);
  const [pickPos, setPickPos] = useState<Principal[]>([]);
  const [pickBranch, setPickBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const [firing, setFiring] = useState(false);

  const isSelf = member.userId === meId;
  const isContractor = member.role === 'contractor';
  const assignable: readonly WorkspaceRole[] = myRole === 'owner' ? OWNER_ASSIGNABLE_WORKSPACE_ROLES : ADMIN_ASSIGNABLE_WORKSPACE_ROLES;
  const canChangeRole = canManage && !isContractor && !isOwnerRow && !isSelf && (myRole === 'owner' || member.role !== 'admin');
  const canFire = canManage && !isOwnerRow && !isSelf && (myRole === 'owner' || member.role !== 'admin');
  const defaultBranch = dir.branches.find((b) => b.isDefault);

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

  const changeRole = () => run(async () => { await apiPatch(`/workspaces/${workspaceId}/members/${member.userId}`, { role: newRole }); });

  const assign = () =>
    run(async () => {
      if (!pickPos[0]) return;
      await apiPost(`/workspaces/${workspaceId}/staff/members/${member.userId}/assignments`, {
        positionId: pickPos[0].id,
        branchId: pickBranch || null,
      });
      setPickPos([]);
      setPickBranch('');
    });

  // «Сохранить» — закрывающая кнопка, которая ДОВОДИТ начатое: применяет все
  // невыполненные правки (роль, выбранную должность с объектом) и закрывает окно.
  const saveAll = async () => {
    setBusy(true);
    setLocalError('');
    try {
      if (canChangeRole && newRole !== member.role) {
        await apiPatch(`/workspaces/${workspaceId}/members/${member.userId}`, { role: newRole });
      }
      if (canStaff && pickPos[0]) {
        await apiPost(`/workspaces/${workspaceId}/staff/members/${member.userId}/assignments`, {
          positionId: pickPos[0].id,
          branchId: pickBranch || null,
        });
      }
      refreshStaff();
      onClose();
    } catch (e) {
      setLocalError(apiErrorMessage(e));
      setBusy(false);
    }
  };

  const unassign = (a: StaffAssignment) => run(async () => { await apiDelete(`/workspaces/${workspaceId}/staff/assignments/${a.id}`); });
  const makePrimary = (a: StaffAssignment) => run(async () => { await apiPatch(`/workspaces/${workspaceId}/staff/assignments/${a.id}`, { isPrimary: true }); });

  const fire = async () => {
    setBusy(true);
    setLocalError('');
    try {
      await apiDelete(`/workspaces/${workspaceId}/members/${member.userId}`);
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
  const assignments = [...member.assignments].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));

  return (
    <Modal
      open
      onClose={onClose}
      title={<PersonChip size="M" userId={member.userId} firstName={fn} lastName={ln} avatar={member.userAvatar} role={roleLabel(member.role)} />}
      size="md"
      footer={<Button variant="primary" tone="success" icon="save" loading={busy} onClick={() => void saveAll()}>Сохранить</Button>}
    >
      <div className="ui-stack" style={{ gap: 'var(--spacing-4)' }}>
        {localError && <Alert tone="danger" onClose={() => setLocalError('')}>{localError}</Alert>}

        {isContractor ? (
          <Alert tone="neutral" icon="info" title="Подрядчик">
            Доступ только к своим задачам. Роль и должности не назначаются — ими управляет выдавший сервис.
          </Alert>
        ) : (
          <>
            {canChangeRole && (
              <Field label="Роль в организации">
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Select aria-label="Роль в организации" value={newRole} onChange={(v) => setNewRole(v as WorkspaceRole)} width={190}
                    options={assignable.map((r) => ({ value: r, label: roleLabel(r) }))} />
                  <Button variant="matte" tone="accent" size="sm" icon="check" disabled={newRole === member.role} loading={busy} onClick={changeRole}>Сменить</Button>
                </div>
              </Field>
            )}
            {canManage && !canChangeRole && !isSelf && !isOwnerRow && member.role === 'admin' && (
              <Alert tone="neutral" icon="lock">Роль Админа меняет только Владелец</Alert>
            )}

            <div>
              <div className="label-caps" style={{ marginBottom: 'var(--spacing-2)' }}>Должности</div>
              {assignments.length === 0 ? (
                <p className="label-sm" style={{ margin: '0 0 var(--spacing-3)' }}>Должностей пока нет — человек вне структуры</p>
              ) : (
                <div className="ui-stack" style={{ gap: '0.375rem', marginBottom: 'var(--spacing-3)' }}>
                  {assignments.map((a) => (
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
                      <Chip size="sm" icon="branch">{a.branchName}</Chip>
                      {a.isPrimary ? (
                        <Chip size="sm" tone="accent" icon="star">Основное</Chip>
                      ) : canStaff ? (
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => makePrimary(a)}>Сделать основным</Button>
                      ) : null}
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
                    <EntitySelector value={pickPos} onChange={setPickPos} types={['position']} multi={false} placeholder="Должность из справочника…" context={{ workspaceId }} />
                  </div>
                  <Select
                    aria-label="Объект"
                    value={pickBranch}
                    onChange={setPickBranch}
                    width={190}
                    options={[
                      { value: '', label: defaultBranch ? `Основной: ${defaultBranch.name}` : 'Основной объект', icon: 'home' as const },
                      ...dir.branches.filter((b) => !b.isDefault).map((b) => ({ value: b.id, label: b.name, icon: 'branch' as const })),
                    ]}
                  />
                  <Button variant="primary" tone="success" size="sm" icon="add" disabled={!pickPos[0]} loading={busy} onClick={assign}>Назначить</Button>
                </div>
              )}
            </div>

            {requisites && <MemberRequisitesBlock req={requisites} />}

            <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
              <Button variant="matte" size="sm" icon="file" onClick={onSendDocument}>Оформить документ</Button>
              <Button variant="ghost" size="sm" icon="list" href={`/workspaces/${workspaceId}/documents?subject=${member.userId}`}>Его документы</Button>
              <Button variant="ghost" size="sm" icon="department" href={`/workspaces/${workspaceId}/members/org?focus=user:${member.userId}`}>В структуре</Button>
            </div>

            {/* Опасное — отдельным блоком, а не сплошной красной кнопкой вплотную к
                «Сохранить»: два разных «Уволить» (исключение из организации здесь и
                кадровое увольнение по ТК в карточке) стояли под одной подписью. */}
            {canFire && (
              <div style={{ borderTop: '1px solid var(--divider)', paddingTop: 'var(--spacing-3)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
                <div className="label-caps">Уход из организации</div>
                <p className="label-sm" style={{ margin: 0 }}>
                  Исключение закрывает доступ к рабочим данным. Трудовой договор этим не прекращается —
                  для увольнения по ТК откройте карточку сотрудника.
                </p>
                <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                  <Button variant="matte" tone="danger" size="sm" icon="signOut" disabled={busy} onClick={() => setFiring(true)}>
                    Исключить из организации
                  </Button>
                  <Button variant="ghost" size="sm" icon="file" href={`/workspaces/${workspaceId}/members/${member.userId}`}>
                    Оформить увольнение по ТК
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={firing}
        onClose={() => setFiring(false)}
        onConfirm={fire}
        title={`Исключить «${member.userName}» из организации?`}
        message="Назначения снимутся, доступ к рабочим данным закроется. Задачи и переписка сохранятся, трудовой договор — тоже: его прекращают кадровым действием в карточке сотрудника."
        confirmLabel="Исключить"
        danger
        loading={busy}
      />
    </Modal>
  );
}
