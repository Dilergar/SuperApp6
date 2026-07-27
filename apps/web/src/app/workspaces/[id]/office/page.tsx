'use client';

import { useMemo, useState } from 'react';
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
  Alert, AvatarStack, BentoGrid, Button, Card, CardHeader, Chip, ConfirmDialog, Divider,
  EmptyState, LoadingBlock, Modal, PageHeader,
} from '@/components/ui';
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
  const [endFor, setEndFor] = useState<OfficeRoomDto | null>(null);
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
    onSuccess: () => {
      setEndFor(null);
      void queryClient.invalidateQueries({ queryKey: officeRoomsKey(wsId) });
    },
    onError: (e) => { setEndFor(null); setError(apiErrorMessage(e)); },
  });

  if (!isReady || wsQ.isLoading) return <LoadingBlock />;

  if (!myRole || isContractor) {
    return (
      <>
        <PageHeader breadcrumb={wsQ.data?.name ?? 'Организация'} title="Виртуальный офис" />
        <BentoGrid>
          <Card span={12}>
            <EmptyState
              icon="lock"
              title="Нет доступа к Виртуальному офису"
              description="Встречи организации открыты её команде."
            />
          </Card>
        </BentoGrid>
      </>
    );
  }

  const canManage = (room: OfficeRoomDto) =>
    room.myRole === 'host' || myRank >= WORKSPACE_ROLE_RANK.manager;

  const meetingWhen = (iso: string) =>
    new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <>
      <PageHeader
        breadcrumb={wsQ.data?.name ?? 'Организация'}
        title="Виртуальный офис"
        description="Видеовстречи и собрания — устойчивы даже на слабом интернете"
        actions={
          <Button
            variant="primary"
            tone="success"
            icon="video"
            loading={createMut.isPending}
            disabled={!callsEnabled}
            onClick={() => createMut.mutate()}
          >
            Новая встреча
          </Button>
        }
      />

      {!callsEnabled && (
        <div style={{ marginBottom: 'var(--gap-grid)' }}>
          <Alert tone="warning" title="Звонки не подключены">
            Поднимите LiveKit (docker compose --profile calls up -d) и задайте LIVEKIT_* в apps/api/.env
          </Alert>
        </div>
      )}
      {error && (
        <div style={{ marginBottom: 'var(--gap-grid)' }}>
          <Alert tone="danger" onClose={() => setError('')}>{error}</Alert>
        </div>
      )}

      <BentoGrid>
        {/* ---------- Идут сейчас ---------- */}
        {liveRooms.map((room) => (
          <Card key={room.id} span={6}>
            <CardHeader
              title={room.name}
              actions={<Chip tone="success" icon="record">в эфире</Chip>}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-4)' }}>
              <AvatarStack
                size={32}
                overflow={(room.live?.participantCount ?? 0) > 5 ? (room.live?.participantCount ?? 0) - 5 : undefined}
              >
                {(room.live?.participants ?? []).slice(0, 5).map((p) => (
                  <PersonAvatar
                    key={p.id}
                    userId={p.id}
                    name={`${p.firstName} ${p.lastName ?? ''}`.trim()}
                    avatar={p.avatar}
                    size="sm"
                  />
                ))}
              </AvatarStack>
              <span className="label-sm">{room.live?.participantCount ?? 0} в звонке</span>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <Button variant="primary" size="sm" icon="video" href={`/workspaces/${wsId}/office/${room.id}`}>
                Присоединиться
              </Button>
              <Button variant="matte" tone="accent" size="sm" icon="userAdd" onClick={() => setInviteFor(room)}>
                Пригласить
              </Button>
              {canManage(room) && (
                <Button variant="ghost" size="sm" tone="danger" icon="callEnd" onClick={() => setEndFor(room)}>
                  Завершить
                </Button>
              )}
            </div>
          </Card>
        ))}

        {/* ---------- Встречи (ссылки живут) ---------- */}
        <Card span={12}>
          <CardHeader
            title="Встречи"
            subtitle="Ссылка работает для всех сотрудников, пока встречу не завершили"
          />
          {roomsQ.isLoading ? (
            <LoadingBlock />
          ) : idleRooms.length === 0 && liveRooms.length === 0 ? (
            <EmptyState
              icon="video"
              title="Пока нет встреч"
              description="Создайте первую — ссылка сразу заработает для всех сотрудников."
              action={
                <Button variant="primary" tone="success" icon="video" disabled={!callsEnabled} onClick={() => createMut.mutate()}>
                  Новая встреча
                </Button>
              }
            />
          ) : (
            <div style={{ display: 'grid', gap: '0.375rem' }}>
              {idleRooms.map((room) => (
                <div
                  key={room.id}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-3)',
                    flexWrap: 'wrap', padding: '0.625rem 0.75rem', border: '1px solid var(--divider)',
                    borderRadius: 'var(--radius-md)',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div className="title-sm">{room.name}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
                      {room.createdBy && (
                        <PersonChip size="S" userId={room.createdBy.id} firstName={room.createdBy.firstName} avatar={room.createdBy.avatar} />
                      )}
                      <span className="label-sm">{meetingWhen(room.createdAt)}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flex: 'none', flexWrap: 'wrap' }}>
                    <Button variant="outline" size="sm" icon="external" href={`/workspaces/${wsId}/office/${room.id}`}>
                      Открыть
                    </Button>
                    <Button variant="matte" tone="accent" size="sm" icon="userAdd" onClick={() => setInviteFor(room)}>
                      Пригласить
                    </Button>
                    {canManage(room) && (
                      <Button variant="ghost" size="sm" tone="danger" icon="close" onClick={() => setEndFor(room)}>
                        Завершить
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* ---------- История: завершённые встречи (дом протоколов) ---------- */}
        {history.length > 0 && (
          <Card span={12}>
            <CardHeader title="История" subtitle="Чат завершённой встречи остаётся — там же будут протоколы" />
            <div className="density-compact" style={{ display: 'grid', gap: '0.375rem' }}>
              {history.map((room) => (
                <div
                  key={room.id}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-3)',
                    flexWrap: 'wrap', padding: '0.5rem 0.75rem', border: '1px solid var(--divider)',
                    borderRadius: 'var(--radius-md)',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div className="title-sm">{room.name}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.125rem' }}>
                      {room.createdBy && (
                        <PersonChip size="S" userId={room.createdBy.id} firstName={room.createdBy.firstName} avatar={room.createdBy.avatar} />
                      )}
                      <span className="label-sm">
                        Завершена{room.endedAt ? ` ${meetingWhen(room.endedAt)}` : ''}
                      </span>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" icon="messenger" href={`/workspaces/${wsId}/office/${room.id}`}>
                    Чат и история
                  </Button>
                </div>
              ))}
            </div>
            {historyQ.hasNextPage && (
              <>
                <Divider />
                <div style={{ textAlign: 'center' }}>
                  <Button
                    variant="matte"
                    size="sm"
                    loading={historyQ.isFetchingNextPage}
                    onClick={() => void historyQ.fetchNextPage()}
                  >
                    Показать ещё
                  </Button>
                </div>
              </>
            )}
          </Card>
        )}
      </BentoGrid>

      {inviteFor && (
        <InviteModal
          wsId={wsId}
          room={inviteFor}
          currentUserId={user?.id ?? ''}
          onClose={() => setInviteFor(null)}
        />
      )}

      <ConfirmDialog
        open={!!endFor}
        onClose={() => setEndFor(null)}
        onConfirm={() => { if (endFor) endMut.mutate(endFor.id); }}
        title={endFor ? `Завершить «${endFor.name}»?` : 'Завершить встречу?'}
        message={
          endFor?.live
            ? 'Звонок закончится для всех участников, ссылка перестанет работать. Чат встречи останется.'
            : 'Ссылка перестанет работать. Чат встречи останется.'
        }
        confirmLabel="Завершить"
        danger
        loading={endMut.isPending}
      />
    </>
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
    <Modal
      open
      onClose={onClose}
      title="Пригласить на встречу"
      subtitle={`«${room.name}» — коллеги получат уведомление со ссылкой`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button
            variant="primary"
            tone="success"
            icon="send"
            disabled={selected.length === 0}
            loading={inviteMut.isPending}
            onClick={() => inviteMut.mutate()}
          >
            Пригласить
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--spacing-3)' }}>
        {error && <Alert tone="danger" onClose={() => setError('')}>{error}</Alert>}
        <EntitySelector
          value={selected}
          onChange={setSelected}
          options={memberOptions}
          placeholder="Выберите сотрудников…"
        />
      </div>
    </Modal>
  );
}
