'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { api, apiErrorMessage } from '@/lib/api';
import {
  callsStatusKey,
  fetchOfficeHistory,
  fetchOfficeRooms,
  officeHistoryKey,
  officeRoomsKey,
  workspaceKey,
  workspaceMembersKey,
} from '@/lib/queries';
import { getCallsStatus } from '@/lib/calls-api';
import { EntitySelector } from '@/components/EntitySelector';
import type { EntityOption, Principal } from '@/lib/entities';
import { PersonAvatar } from '@/app/messenger/messenger-ui';
import { PersonChip } from '@/app/circles/PersonCard';
import {
  OFFICE_LIMITS,
  WORKSPACE_ROLE_RANK,
  type OfficeRoomDto,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceRole,
} from '@superapp/shared';

/**
 * «Виртуальный офис» — видеовстречи организации (v1 — аналог Google Meet).
 * Список: «Идут сейчас» (живой созвон, стек аватаров) + активные встречи;
 * «Новая встреча» создаёт и сразу открывает комнату. Поллинг списка — до
 * live-присутствия Discord-фазы.
 */
export default function OfficePage() {
  const { isReady, user } = useRequireAuth();
  const { id: wsId } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [inviteFor, setInviteFor] = useState<OfficeRoomDto | null>(null);
  const [error, setError] = useState('');

  const wsQ = useQuery({
    queryKey: workspaceKey(wsId),
    queryFn: async () => (await api.get(`/workspaces/${wsId}`)).data.data as Workspace,
    enabled: isReady,
  });
  const myRole = wsQ.data?.myRole as WorkspaceRole | undefined;
  const myRank = WORKSPACE_ROLE_RANK[myRole ?? 'trainee'] ?? 0;
  const isContractor = myRole === 'contractor';

  const statusQ = useQuery({ queryKey: callsStatusKey, queryFn: getCallsStatus, enabled: isReady, staleTime: 60_000 });
  const callsEnabled = statusQ.data?.enabled ?? true;

  const roomsQ = useQuery({
    queryKey: officeRoomsKey(wsId),
    queryFn: () => fetchOfficeRooms(wsId),
    enabled: isReady && !!myRole && !isContractor,
    // Частый пульс нужен только пока есть живые встречи (счётчики/аватары);
    // пустой список опрашиваем впятеро реже — паттерн страницы инстанса процессов.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((r) => r.live) ? OFFICE_LIMITS.listPollMs : 30_000,
  });
  const rooms = useMemo(() => roomsQ.data ?? [], [roomsQ.data]);
  const liveRooms = rooms.filter((r) => r.live);
  const idleRooms = rooms.filter((r) => !r.live);

  // История завершённых встреч (cursor-пагинация; без поллинга — обновляется
  // префиксной инвалидацией officeRoomsKey после «Завершить»)
  const historyQ = useInfiniteQuery({
    queryKey: officeHistoryKey(wsId),
    queryFn: ({ pageParam }) => fetchOfficeHistory(wsId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isReady && !!myRole && !isContractor,
  });
  const history = historyQ.data?.pages.flatMap((p) => p.items) ?? [];

  const createMut = useMutation({
    mutationFn: async () =>
      (await api.post(`/workspaces/${wsId}/office/rooms`, {})).data.data as OfficeRoomDto,
    onSuccess: (room) => {
      void queryClient.invalidateQueries({ queryKey: officeRoomsKey(wsId) });
      router.push(`/workspaces/${wsId}/office/${room.id}`);
    },
    onError: (e) => setError(apiErrorMessage(e)),
  });

  const endMut = useMutation({
    mutationFn: (roomId: string) => api.post(`/workspaces/${wsId}/office/rooms/${roomId}/end`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: officeRoomsKey(wsId) }),
    onError: (e) => setError(apiErrorMessage(e)),
  });

  if (!isReady || wsQ.isLoading) return <p className="label-md">Загрузка…</p>;
  if (!myRole || isContractor) {
    return <p className="label-md">Нет доступа к Виртуальному офису этой организации.</p>;
  }

  const canManage = (room: OfficeRoomDto) =>
    room.myRole === 'host' || myRank >= WORKSPACE_ROLE_RANK.manager;

  return (
    <div>
      {/* Шапка сервиса */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-8)', flexWrap: 'wrap' }}>
        <div>
          <h1 className="display-md" style={{ fontSize: '1.9rem' }}>🎥 Виртуальный офис</h1>
          <p className="label-md">Видеовстречи и собрания — устойчивы даже на слабом интернете</p>
        </div>
        <button
          className="btn-primary"
          disabled={createMut.isPending || !callsEnabled}
          onClick={() => createMut.mutate()}
          style={{ padding: '0.65rem 1.6rem', fontSize: '0.95rem' }}
        >
          {createMut.isPending ? 'Создание…' : '+ Новая встреча'}
        </button>
      </div>

      {!callsEnabled && (
        <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-5)', fontSize: '0.875rem', color: 'var(--primary)' }}>
          Звонки не подключены: поднимите LiveKit (docker compose --profile calls up -d) и задайте LIVEKIT_* в apps/api/.env
        </div>
      )}
      {error && (
        <div className="wash-primary" style={{ padding: 'var(--spacing-3) var(--spacing-4)', marginBottom: 'var(--spacing-5)', fontSize: '0.875rem', color: 'var(--primary)' }}>
          {error}
        </div>
      )}

      {/* Идут сейчас */}
      {liveRooms.length > 0 && (
        <>
          <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-4)' }}>Идут сейчас</h2>
          <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-5)', marginBottom: 'var(--spacing-10)' }}>
            {liveRooms.map((room, i) => (
              <div key={room.id} className="card-elevated" style={{ transform: `rotate(${i % 2 === 0 ? '-0.4' : '0.4'}deg)` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-3)' }}>
                  <div className="title-md" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{room.name}</div>
                  <span style={{ flexShrink: 0, fontSize: '0.72rem', fontWeight: 700, color: 'var(--primary)', background: 'var(--primary-container)', padding: '0.15rem 0.6rem', borderRadius: '0.6rem 0.4rem 0.55rem 0.45rem' }}>
                    ● в эфире
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-4)' }}>
                  <div style={{ display: 'flex' }}>
                    {(room.live?.participants ?? []).slice(0, 5).map((p, idx) => (
                      <div key={p.id} style={{ marginLeft: idx === 0 ? 0 : -10 }}>
                        <PersonAvatar userId={p.id} name={`${p.firstName} ${p.lastName ?? ''}`.trim()} avatar={p.avatar} size="sm" />
                      </div>
                    ))}
                  </div>
                  <span className="label-md" style={{ fontSize: '0.85rem' }}>
                    {room.live?.participantCount ?? 0} в звонке
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                  <Link href={`/workspaces/${wsId}/office/${room.id}`} className="btn-primary" style={{ padding: '0.45rem 1.3rem', fontSize: '0.85rem', textDecoration: 'none' }}>
                    Присоединиться
                  </Link>
                  <button className="btn-secondary" style={{ padding: '0.45rem 1rem', fontSize: '0.85rem' }} onClick={() => setInviteFor(room)}>
                    Пригласить
                  </button>
                  {canManage(room) && (
                    <button
                      onClick={() => { if (confirm('Завершить встречу для всех?')) endMut.mutate(room.id); }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontSize: '0.8rem', fontWeight: 600 }}
                    >
                      Завершить
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Активные встречи (ссылки живут) */}
      <h2 className="title-lg" style={{ marginBottom: 'var(--spacing-4)' }}>Встречи</h2>
      {roomsQ.isLoading && <p className="label-md">Загрузка…</p>}
      {!roomsQ.isLoading && idleRooms.length === 0 && liveRooms.length === 0 && (
        <div className="card" style={{ padding: 'var(--spacing-8)', textAlign: 'center' }}>
          <div style={{ fontSize: '2.2rem', marginBottom: 'var(--spacing-3)' }}>🎥</div>
          <p className="title-md" style={{ marginBottom: 'var(--spacing-2)' }}>Пока нет встреч</p>
          <p className="label-md">Создайте первую — ссылка сразу заработает для всех сотрудников</p>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
        {idleRooms.map((room) => (
          <div key={room.id} className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-3)', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div className="title-md" style={{ marginBottom: '0.2rem' }}>{room.name}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                {room.createdBy && (
                  <PersonChip size="S" userId={room.createdBy.id} firstName={room.createdBy.firstName} avatar={room.createdBy.avatar} />
                )}
                <span className="label-sm" style={{ opacity: 0.7 }}>
                  {new Date(room.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 'var(--spacing-2)', alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
              <Link href={`/workspaces/${wsId}/office/${room.id}`} className="btn-secondary" style={{ padding: '0.4rem 1.1rem', fontSize: '0.82rem', textDecoration: 'none' }}>
                Открыть
              </Link>
              <button className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.82rem' }} onClick={() => setInviteFor(room)}>
                Пригласить
              </button>
              {canManage(room) && (
                <button
                  onClick={() => { if (confirm('Завершить встречу? Ссылка перестанет работать.')) endMut.mutate(room.id); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontSize: '0.78rem', fontWeight: 600 }}
                >
                  Завершить
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* История: завершённые встречи — вход в чат встречи (дом будущих транскрипций/протоколов) */}
      {history.length > 0 && (
        <>
          <h2 className="title-lg" style={{ margin: 'var(--spacing-10) 0 var(--spacing-4)' }}>История</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)' }}>
            {history.map((room) => (
              <div
                key={room.id}
                className="card"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-3)', flexWrap: 'wrap', opacity: 0.92 }}
              >
                <div style={{ minWidth: 0 }}>
                  <div className="title-md" style={{ fontSize: '0.95rem', marginBottom: '0.15rem' }}>{room.name}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
                    {room.createdBy && (
                      <PersonChip size="S" userId={room.createdBy.id} firstName={room.createdBy.firstName} avatar={room.createdBy.avatar} />
                    )}
                    <span className="label-sm" style={{ opacity: 0.7 }}>
                      Завершена{room.endedAt ? ` ${new Date(room.endedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
                    </span>
                  </div>
                </div>
                <Link
                  href={`/workspaces/${wsId}/office/${room.id}`}
                  className="btn-secondary"
                  style={{ padding: '0.35rem 1rem', fontSize: '0.8rem', textDecoration: 'none', flexShrink: 0 }}
                >
                  Чат и история
                </Link>
              </div>
            ))}
          </div>
          {historyQ.hasNextPage && (
            <button
              className="btn-secondary"
              style={{ marginTop: 'var(--spacing-3)', padding: '0.4rem 1.2rem', fontSize: '0.82rem' }}
              disabled={historyQ.isFetchingNextPage}
              onClick={() => void historyQ.fetchNextPage()}
            >
              {historyQ.isFetchingNextPage ? 'Загрузка…' : 'Показать ещё'}
            </button>
          )}
        </>
      )}

      {inviteFor && (
        <InviteModal
          wsId={wsId}
          room={inviteFor}
          currentUserId={user?.id ?? ''}
          onClose={() => setInviteFor(null)}
        />
      )}
    </div>
  );
}

/** Приглашение сотрудников: EntitySelector по членам организации (options-паттерн Процессов) */
function InviteModal({
  wsId,
  room,
  currentUserId,
  onClose,
}: {
  wsId: string;
  room: OfficeRoomDto;
  currentUserId: string;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Principal[]>([]);
  const [error, setError] = useState('');
  const membersQ = useQuery({
    queryKey: workspaceMembersKey(wsId),
    queryFn: async () => (await api.get(`/workspaces/${wsId}/members`)).data.data as WorkspaceMember[],
    staleTime: 60_000,
  });
  const memberOptions: EntityOption[] = useMemo(
    () =>
      (membersQ.data ?? [])
        .filter((m) => m.userId !== currentUserId)
        .map((m) => {
          const [fn, ...rest] = (m.userName || '?').split(' ');
          return {
            type: 'user',
            id: m.userId,
            title: m.userName,
            firstName: m.card?.firstName ?? fn,
            lastName: m.card?.lastName ?? (rest.join(' ') || null),
          } as EntityOption;
        }),
    [membersQ.data, currentUserId],
  );

  const inviteMut = useMutation({
    mutationFn: () =>
      api.post(`/workspaces/${wsId}/office/rooms/${room.id}/invite`, {
        userIds: selected.map((p) => p.id),
      }),
    onSuccess: onClose,
    onError: (e) => setError(apiErrorMessage(e)),
  });

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(56,57,45,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 'var(--spacing-4)' }}
    >
      <div className="card-elevated" style={{ width: '26rem', maxWidth: '100%', background: 'var(--surface)' }} onClick={(e) => e.stopPropagation()}>
        <div className="title-lg" style={{ fontSize: '1.05rem', marginBottom: 'var(--spacing-1)' }}>Пригласить на встречу</div>
        <p className="label-md" style={{ marginBottom: 'var(--spacing-4)' }}>«{room.name}» — коллеги получат уведомление со ссылкой</p>
        <EntitySelector
          value={selected}
          onChange={setSelected}
          options={memberOptions}
          placeholder="Выберите сотрудников…"
        />
        {error && <p style={{ color: 'var(--primary)', fontSize: '0.8rem', marginTop: 'var(--spacing-2)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-5)' }}>
          <button
            className="btn-primary"
            disabled={selected.length === 0 || inviteMut.isPending}
            onClick={() => inviteMut.mutate()}
            style={{ padding: '0.5rem 1.4rem', fontSize: '0.85rem' }}
          >
            {inviteMut.isPending ? 'Отправка…' : 'Пригласить'}
          </button>
          <button className="btn-secondary" style={{ padding: '0.5rem 1.1rem', fontSize: '0.85rem' }} onClick={onClose}>
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}
