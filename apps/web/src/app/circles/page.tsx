'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, Button, Card, Chip, EmptyState, GlyphField, IconButton, Input,
  PageHeader, SearchField, SegmentedControl, useConfirm,
} from '@/components/ui';
import { useRequireAuth } from '@/lib/hooks/useRequireAuth';
import { apiDelete, apiGet, apiPost } from '@/lib/api';
import {
  contactsKey,
  contactsPagesKey,
  circlesKey,
  circleDetailKey,
  incomingInvitationsKey,
  outgoingInvitationsKey,
  outgoingInvitationsRootKey,
  blocksKey,
  currencyBadgeKey,
  fetchContactsPage,
  fetchCircles,
  fetchCircleDetail,
  fetchIncomingInvitations,
  fetchOutgoingInvitations,
  fetchBlocks,
  fetchCurrencyBadge,
} from '@/lib/queries';
import { invalidateEntities } from '@/lib/entities';
import { usePersonSkins } from '@/lib/person-skins';
import { PersonCard, PersonChip } from './PersonCard';
import { PersonAvatar } from '../messenger/messenger-ui';
import { DEFAULT_CIRCLE_PRESETS } from '@superapp/shared';
import type {
  Circle,
  UserLookupDto,
  CircleWithMembers,
  ContactBlockRecord,
  IncomingInvitation,
  OutgoingInvitation,
} from '@superapp/shared';
import {
  GROUP_COLORS,
  PHONE_LOOKUP_MIN_LENGTH,
  filterContacts,
  pluralPeople,
  runAction,
  samePhone,
  sortContacts,
  sortGroups,
  type ContactSort,
} from './circles-lib';
import {
  CollapseHeader,
  ColorPalette,
  ContactsGridSkeleton,
  GRID_STYLE,
  GroupSelectField,
  GroupVisibilityEditor,
  InvitationCard,
  RolePicker,
} from './circles-ui';
import { AcceptInvitationModal, GroupEditModal } from './circles-modals';

type InvitationTab = 'active' | 'history';

export default function CirclesPage() {
  const { isReady } = useRequireAuth();
  const queryClient = useQueryClient();
  const [confirm, confirmUI] = useConfirm();

  // ---- Поиск и сортировка грида ----
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ContactSort>('recent');

  // ---- Форма приглашения ----
  const [showInvite, setShowInvite] = useState(false);
  const [invPhone, setInvPhone] = useState('+7');
  const [invLookup, setInvLookup] = useState<UserLookupDto | null>(null);
  const [invLookupLoading, setInvLookupLoading] = useState(false);
  const [invLookupDone, setInvLookupDone] = useState(false);
  const [invTheyForMe, setInvTheyForMe] = useState('');
  const [invMeForThem, setInvMeForThem] = useState('');
  const [invMessage, setInvMessage] = useState('');
  const [invGroupIds, setInvGroupIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  // ---- Создание группы ----
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupIcon, setGroupIcon] = useState<string | null>(null);
  const [groupColor, setGroupColor] = useState<string>(GROUP_COLORS[0].value);
  const [creatingGroup, setCreatingGroup] = useState(false);

  // ---- Панели и окна ----
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<Circle | null>(null);
  const [acceptTarget, setAcceptTarget] = useState<IncomingInvitation | null>(null);
  const [showInvitations, setShowInvitations] = useState(true);
  const [invitationTab, setInvitationTab] = useState<InvitationTab>('active');
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [showBlocked, setShowBlocked] = useState(false);

  // ============================================================
  // ВАЖНО: серверная разметка этой страницы обязана оставаться КРОШЕЧНОЙ.
  //
  // Не оптимизация, а лечение вечного спиннера при прямом заходе на /circles.
  // Механика (проверена замерами, см. ниже):
  //   1. У сервиса есть `circles/loading.tsx`, то есть роут обёрнут в границу
  //      Suspense. React Fizz вкладывает содержимое такой границы прямо в поток
  //      ТОЛЬКО пока оно меньше порога прогрессивной нарезки (progressiveChunkSize,
  //      12800 байт). Переросло — граница уезжает отдельным куском:
  //      `<!--$?--><template id="B:0">` + fallback, а содержимое приезжает после
  //      и вставляется инструкцией `$RC`.
  //   2. `$RC` в React 19.2 НЕ раскрывает границу сразу: он помечает её
  //      `<!--$~-->` («в очереди») и планирует показ через requestAnimationFrame.
  //   3. Кадр может не наступить (вкладка в фоне, окно перекрыто, страница не
  //      рисуется) — и тогда граница НАВСЕГДА остаётся в fallback'е. Симптом
  //      подлый: ошибок в консоли нет, ни один запрос не падает, сервер отдал
  //      200 и ПОЛНЫЙ html. Ручной вызов `$RV($RB)` в консоли мгновенно
  //      показывает страницу — содержимое всё это время лежало рядом.
  //
  // Прежняя версия страницы не попадала в это случайно: она делала ранний
  // `return <p>Загрузка...</p>`, и серверный кусок был в полсотни байт. Мой
  // рерайт стал рисовать на сервере всю обвязку (шапка, панель приглашений,
  // чипы, скелетон грида) — только инлайновых переменных тона у кнопок и чипов
  // кита набегает ~250 байт на элемент, и порог перекрывается с запасом.
  //
  // Поэтому до гидратации отдаём только заголовок. Это честно и по смыслу:
  // авторизация лежит в localStorage, на сервере `isReady` всегда false, все
  // запросы выключены — показывать там нечего, любая обвязка была бы разметкой
  // ради разметки. Клиентский опыт не меняется: сразу после гидратации
  // рисуется полная страница с шапкой, чипами и скелетоном списка.
  //
  // Правило на будущее: всё, что добавляется в разметку ДО этой проверки,
  // увеличивает серверный кусок. Проверка одной командой —
  //   curl -s http://localhost:3000/circles | grep -c '$RC('
  // Ноль — граница вложена в поток (правильно), единица — уехала отдельно.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // ============================================================
  // Данные — React Query с ОБЩИМИ ключами (окружение и группы читают пикеры
  // других страниц). Мутация инвалидирует свой ключ, а не гоняет fetchAll.
  // ============================================================

  // Окружение постранично: первый экран больше не ждёт, пока цикл вычитает
  // ВСЕ страницы (на 300 контактах это было 3 round-trip до первой карточки).
  const contactsQ = useInfiniteQuery({
    queryKey: contactsPagesKey,
    queryFn: ({ pageParam }) => fetchContactsPage((pageParam as string | undefined) || undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isReady,
  });
  const contacts = useMemo(
    () => contactsQ.data?.pages.flatMap((p) => p.items) ?? [],
    [contactsQ.data],
  );

  const groupsQ = useQuery({ queryKey: circlesKey, queryFn: fetchCircles, enabled: isReady });
  // Входящие — той же курсорной лесенкой, что исходящие: раньше UI брал только первую
  // страницу, и приглашение №21 не существовало для человека в принципе.
  const incomingQ = useInfiniteQuery({
    queryKey: incomingInvitationsKey,
    queryFn: ({ pageParam }) => fetchIncomingInvitations((pageParam as string | undefined) || undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isReady,
  });
  const outgoingQ = useInfiniteQuery({
    queryKey: outgoingInvitationsKey('pending'),
    queryFn: ({ pageParam }) => fetchOutgoingInvitations('pending', (pageParam as string | undefined) || undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isReady,
  });
  // История подгружается ТОЛЬКО когда её открыли: это отдельная выборка по
  // не-pending строкам, и на первом экране она никому не нужна.
  const historyQ = useInfiniteQuery({
    queryKey: outgoingInvitationsKey('history'),
    queryFn: ({ pageParam }) => fetchOutgoingInvitations('history', (pageParam as string | undefined) || undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: isReady && showInvitations && invitationTab === 'history',
  });
  const blocksQ = useQuery({ queryKey: blocksKey, queryFn: fetchBlocks, enabled: isReady });
  const walletQ = useQuery({ queryKey: currencyBadgeKey, queryFn: fetchCurrencyBadge, enabled: isReady, staleTime: 60_000 });
  const groupDetailQ = useQuery({
    queryKey: circleDetailKey(activeGroup ?? 'none'),
    queryFn: () => fetchCircleDetail(activeGroup!),
    enabled: isReady && !!activeGroup,
  });

  const groups: Circle[] = useMemo(() => sortGroups(groupsQ.data ?? []), [groupsQ.data]);
  const incoming: IncomingInvitation[] = useMemo(
    () => incomingQ.data?.pages.flatMap((p) => p.items) ?? [],
    [incomingQ.data],
  );
  const outgoing: OutgoingInvitation[] = useMemo(
    () => outgoingQ.data?.pages.flatMap((p) => p.items) ?? [],
    [outgoingQ.data],
  );
  const history: OutgoingInvitation[] = useMemo(
    () => historyQ.data?.pages.flatMap((p) => p.items) ?? [],
    [historyQ.data],
  );
  const blocks: ContactBlockRecord[] = blocksQ.data ?? [];
  const myCoinIcon = walletQ.data?.icon ?? null;
  const coinsByUser = walletQ.data?.holders ?? {};

  // ============================================================
  // Что показываем в гриде
  // ============================================================

  // useMemo, а не тернарник на месте: литерал `[]` пересоздавался бы каждый
  // рендер и ронял бы memo ниже — вместе с ним стабильность обработчиков карточек.
  const baseList = useMemo(
    () => (activeGroup ? groupDetailQ.data?.members ?? [] : contacts),
    [activeGroup, groupDetailQ.data, contacts],
  );
  const displayed = useMemo(
    () => sortContacts(filterContacts(baseList, search), sort),
    [baseList, search, sort],
  );

  // Грид ждёт СВОЙ запрос: до гидратации авторизации запросы выключены, и в
  // этом состоянии `isPending` = true, а `isLoading` = false — по последнему
  // страница показала бы «Пока никого» вместо загрузки.
  const gridBusy = !isReady || (activeGroup ? groupDetailQ.isPending : contactsQ.isPending);
  const gridFailed = activeGroup ? groupDetailQ.isError : contactsQ.isError;
  const retryGrid = () => {
    if (activeGroup) void groupDetailQ.refetch();
    else void contactsQ.refetch();
  };

  // Скины резолвит движок скинов (батч + кэш). Presence страница больше НЕ
  // грузит: карточка L его не показывает — он виден только в развёрнутой XL,
  // и там карточка берёт его сама.
  const visibleUserIds = useMemo(() => displayed.map((c) => c.them.id), [displayed]);
  const skinByUser = usePersonSkins(visibleUserIds);

  // ============================================================
  // Инвалидация
  // ============================================================

  // ['contacts'] — префикс: накрывает и постраничный список, и плоский кэш
  // пикеров, и приглашения с блоками. Один вызов вместо пяти точечных.
  const refreshContacts = () => {
    queryClient.invalidateQueries({ queryKey: contactsKey });
    invalidateEntities('user'); // новый человек обязан появиться в пикерах без F5
  };
  const refreshGroups = () => {
    queryClient.invalidateQueries({ queryKey: circlesKey });
    invalidateEntities('circle');
  };

  // ============================================================
  // Поиск человека по номеру
  // ============================================================

  const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lookupAbort = useRef<AbortController | null>(null);

  const handlePhoneLookup = (phone: string) => {
    setInvPhone(phone);
    setInvLookup(null);
    setInvLookupDone(false);
    if (lookupTimer.current) clearTimeout(lookupTimer.current);
    // Улетевший запрос по СТАРОМУ номеру отменяем. Снятия таймера мало: ответ,
    // уже ушедший в сеть, приходил позже нового и перезаписывал превью чужим
    // человеком — на медленной сети форма показывала не того, кого ищут.
    lookupAbort.current?.abort();
    if (phone.length < PHONE_LOOKUP_MIN_LENGTH) {
      setInvLookupLoading(false);
      return;
    }
    setInvLookupLoading(true);
    lookupTimer.current = setTimeout(() => {
      const ctrl = new AbortController();
      lookupAbort.current = ctrl;
      void (async () => {
        try {
          const found = await apiGet<UserLookupDto | null>('/users/lookup', {
            params: { phone },
            signal: ctrl.signal,
          });
          if (ctrl.signal.aborted) return;
          setInvLookup(found);
          setInvLookupDone(true);
        } catch {
          if (ctrl.signal.aborted) return; // состояние уже принадлежит новому номеру
          setInvLookupDone(true);
        } finally {
          if (!ctrl.signal.aborted) setInvLookupLoading(false);
        }
      })();
    }, 500);
  };

  useEffect(() => () => {
    if (lookupTimer.current) clearTimeout(lookupTimer.current);
    lookupAbort.current?.abort();
  }, []);

  /** Человек уже в окружении — говорим сразу, не дожидаясь 400 от сервера. */
  const alreadyInEnvironment = useMemo(
    () => (invLookup ? contacts.find((c) => c.them.id === invLookup.id) ?? null : null),
    [invLookup, contacts],
  );
  /** Приглашение на этот номер уже висит — повторное отправить нельзя. */
  const alreadyInvited = useMemo(
    () => outgoing.find((inv) => samePhone(inv.toPhone, invPhone)) ?? null,
    [outgoing, invPhone],
  );
  const inviteBlocked = !!alreadyInEnvironment || !!alreadyInvited;

  const resetInviteForm = () => {
    setInvPhone('+7');
    setInvLookup(null);
    setInvLookupDone(false);
    setInvTheyForMe('');
    setInvMeForThem('');
    setInvMessage('');
    setInvGroupIds([]);
  };

  // ============================================================
  // Действия
  // ============================================================

  const handleSendInvitation = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    const ok = await runAction(async () => {
      const payload: Record<string, unknown> = { toPhone: invPhone };
      // invTheyForMe = роль, которую я даю ему; invMeForThem = роль, которую я
      // предлагаю ему дать мне.
      if (invTheyForMe.trim()) payload.proposedRoleForRecipient = invTheyForMe.trim();
      if (invMeForThem.trim()) payload.proposedRoleForSender = invMeForThem.trim();
      if (invMessage.trim()) payload.message = invMessage.trim();
      if (invGroupIds.length > 0) payload.autoAddToCircleIds = invGroupIds;
      await apiPost('/contacts/invitations', payload);
    }, 'Приглашение отправлено');
    setSending(false);
    if (ok) {
      setShowInvite(false);
      resetInviteForm();
      queryClient.invalidateQueries({ queryKey: outgoingInvitationsRootKey });
    }
  };

  const handleReject = (invId: string) =>
    runAction(async () => {
      await apiPost(`/contacts/invitations/${invId}/reject`);
      queryClient.invalidateQueries({ queryKey: incomingInvitationsKey });
    }, 'Приглашение отклонено');

  const handleCancel = (invId: string) =>
    runAction(async () => {
      await apiPost(`/contacts/invitations/${invId}/cancel`);
      queryClient.invalidateQueries({ queryKey: outgoingInvitationsRootKey });
    }, 'Приглашение отменено');

  const handleResend = async (invId: string) => {
    setResendingId(invId);
    await runAction(async () => {
      await apiPost(`/contacts/invitations/${invId}/resend`);
      queryClient.invalidateQueries({ queryKey: outgoingInvitationsRootKey });
    }, 'Приглашение отправлено повторно');
    setResendingId(null);
  };

  const blockNow = (userId: string) =>
    runAction(async () => {
      await apiPost('/contacts/blocks', { userId });
      queryClient.invalidateQueries({ queryKey: blocksKey });
      queryClient.invalidateQueries({ queryKey: outgoingInvitationsRootKey });
      refreshContacts(); // связь удалена, приглашения гаснут
      refreshGroups(); // membersCount
      if (activeGroup) queryClient.invalidateQueries({ queryKey: circleDetailKey(activeGroup) });
    }, 'Пользователь заблокирован');

  const handleBlock = (userId: string, name: string) => {
    confirm(
      {
        title: `Заблокировать ${name}?`,
        message: 'Связь будет удалена у обоих. Он(а) больше не сможет вам писать, приглашать и видеть ваши данные.',
        confirmLabel: 'Заблокировать',
        danger: true,
      },
      // async-обёртка, а не `() => blockNow(...)`: окно подтверждения ЖДЁТ
      // результат (держит индикатор и не даёт нажать дважды), а его контракт —
      // `Promise<void>`.
      async () => { await blockNow(userId); },
    );
  };

  // Разблокировка тоже спрашивает подтверждение: связь она НЕ восстанавливает
  // (для неё нужно новое приглашение), поэтому мгновенное срабатывание давало
  // не тот результат, которого ждёт человек.
  const handleUnblock = (userId: string, name: string) => {
    confirm(
      {
        title: `Разблокировать ${name}?`,
        message: 'Человек снова сможет отправить вам приглашение. Прежняя связь при этом НЕ восстановится — её нужно будет подтвердить заново.',
        confirmLabel: 'Разблокировать',
      },
      async () => {
        await runAction(async () => {
          await apiDelete(`/contacts/blocks/${userId}`);
          queryClient.invalidateQueries({ queryKey: blocksKey });
        }, 'Пользователь разблокирован');
      },
    );
  };

  const handleDeleteContact = (linkId: string) =>
    runAction(async () => {
      await apiDelete(`/contacts/${linkId}`);
      refreshContacts();
      refreshGroups(); // membersCount
      if (activeGroup) queryClient.invalidateQueries({ queryKey: circleDetailKey(activeGroup) });
    }, 'Связь удалена');

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = groupName.trim();
    if (!name) return;
    setCreatingGroup(true);
    const ok = await runAction(async () => {
      await apiPost('/circles', { name, color: groupColor, ...(groupIcon ? { icon: groupIcon } : {}) });
      refreshGroups();
    }, 'Группа создана');
    setCreatingGroup(false);
    if (ok) {
      setGroupName('');
      setGroupIcon(null);
      setShowCreateGroup(false);
    }
  };

  const handleDeleteGroup = (groupId: string) =>
    runAction(async () => {
      await apiDelete(`/circles/${groupId}`);
      if (activeGroup === groupId) setActiveGroup(null);
      refreshGroups();
    }, 'Группа удалена');

  const handleAddToGroup = (contactLinkId: string, groupId: string) =>
    runAction(async () => {
      await apiPost(`/circles/${groupId}/members`, { contactLinkId });
      refreshGroups(); // membersCount
      queryClient.invalidateQueries({ queryKey: contactsKey }); // myCircleIds на карточках
      queryClient.invalidateQueries({ queryKey: circleDetailKey(groupId) });
    });

  const handleRemoveFromGroup = (linkId: string) => {
    if (!activeGroup) return Promise.resolve(false);
    const groupId = activeGroup;
    return runAction(async () => {
      await apiDelete(`/circles/${groupId}/members/${linkId}`);
      refreshGroups();
      queryClient.invalidateQueries({ queryKey: contactsKey });
      queryClient.invalidateQueries({ queryKey: circleDetailKey(groupId) });
    });
  };

  // Стабильные обработчики карточек. PersonCard обёрнут в memo, и чтобы кейстрок
  // в форме приглашения не перерисовывал весь грид, колбэки каждой карточки
  // обязаны переживать рендер. Вызов идёт через ref — карточка всегда зовёт
  // СВЕЖИЙ обработчик (замыкание на activeGroup не протухает).
  const cardActionsRef = useRef({ handleDeleteContact, handleBlock, handleRemoveFromGroup, handleAddToGroup, confirm });
  cardActionsRef.current = { handleDeleteContact, handleBlock, handleRemoveFromGroup, handleAddToGroup, confirm };
  const cardHandlers = useMemo(() => {
    const map = new Map<string, {
      onDelete: () => void;
      onBlock: () => void;
      onRemoveFromFolder: () => void;
      onAddToFolder: (groupId: string) => void;
    }>();
    for (const c of displayed) {
      map.set(c.linkId, {
        onDelete: () => {
          cardActionsRef.current.confirm(
            { title: 'Удалить из окружения?', message: 'Действие двустороннее — связь исчезнет у обоих.', confirmLabel: 'Удалить', danger: true },
            async () => { await cardActionsRef.current.handleDeleteContact(c.linkId); },
          );
        },
        onBlock: () => void cardActionsRef.current.handleBlock(c.them.id, c.them.firstName),
        onRemoveFromFolder: () => void cardActionsRef.current.handleRemoveFromGroup(c.linkId),
        onAddToFolder: (groupId: string) => void cardActionsRef.current.handleAddToGroup(c.linkId, groupId),
      });
    }
    return map;
  }, [displayed]);

  const myCoinsBy = useMemo(() => {
    if (!myCoinIcon) return null;
    const map = new Map<string, { icon: string; balance: number }>();
    for (const c of displayed) map.set(c.them.id, { icon: myCoinIcon, balance: coinsByUser[c.them.id] ?? 0 });
    return map;
  }, [displayed, myCoinIcon, coinsByUser]);

  /** Сохранённую видимость группы кладём в оба кэша без перезапроса. */
  const handleGroupVisibilitySaved = (updated: Circle) => {
    queryClient.setQueryData<Circle[]>(circlesKey, (prev) =>
      prev ? prev.map((g) => (g.id === updated.id ? { ...g, ...updated } : g)) : prev,
    );
    queryClient.setQueryData<CircleWithMembers>(circleDetailKey(updated.id), (prev) =>
      prev ? { ...prev, ...updated } : prev,
    );
  };

  // ============================================================
  // Render
  // ============================================================

  // Ранний выход ДО тяжёлой разметки и ПОСЛЕ всех хуков (порядок хуков не
  // меняется, правило React соблюдено). Причина — в блоке про `mounted` выше.
  if (!mounted) {
    return (
      <div style={{ paddingBottom: 'var(--spacing-16)' }}>
        <PageHeader title="Моё окружение" description="Загружаем окружение…" />
      </div>
    );
  }

  const activeGroupObj = activeGroup ? groups.find((g) => g.id === activeGroup) ?? null : null;
  const activeInvitations = incoming.length + outgoing.length;
  const headerSubtitle = !isReady || contactsQ.isPending
    ? 'Загружаем окружение…'
    : contactsQ.hasNextPage
      ? `Загружено ${pluralPeople(contacts.length)}`
      : pluralPeople(contacts.length);

  return (
    <div style={{ paddingBottom: 'var(--spacing-16)' }}>
      <PageHeader
        title="Моё окружение"
        description={headerSubtitle}
        actions={
          // «Отмена» закрывает форму, а не разрушает данные — она призрачная,
          // красить её нельзя (DESIGN.md §1).
          showInvite ? (
            <Button variant="ghost" onClick={() => setShowInvite(false)}>Отмена</Button>
          ) : (
            <Button variant="primary" tone="success" icon="add" onClick={() => setShowInvite(true)}>
              Добавить
            </Button>
          )
        }
      />

      {/* ---------------- Форма приглашения ---------------- */}
      {showInvite && (
        <Card style={{ marginBottom: 'var(--spacing-8)' }}>
          <form onSubmit={handleSendInvitation}>
            <div className="title-md" style={{ marginBottom: 'var(--spacing-4)' }}>Добавить в окружение</div>

            <Input
              label="Номер телефона"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={invPhone}
              onChange={(e) => handlePhoneLookup(e.target.value)}
              placeholder="+77001234567"
              autoFocus
              wrapClassName="mb-4"
            />

            {invLookupLoading && (
              <p className="label-sm" role="status" style={{ marginBottom: 'var(--spacing-4)' }}>Ищем человека…</p>
            )}

            {invLookupDone && invLookup && !inviteBlocked && (
              <Alert tone="accent" className="mb-6">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-2)' }}>
                  {/* Аватар уже приехал в этом же ответе — минус запрос движка скинов на каждый ввод номера. */}
                  <PersonAvatar userId={invLookup.id} name={invLookup.firstName} avatar={invLookup.avatar} size="sm" />
                  {invLookup.firstName} {invLookup.lastName || ''} · {invLookup.phone}
                </span>
              </Alert>
            )}
            {invLookupDone && !invLookup && (
              <Alert tone="neutral" className="mb-6">
                Пользователь не найден — приглашение уйдёт на этот номер
              </Alert>
            )}

            {/* Отказ сервера здесь предсказуем — говорим о нём ДО отправки. */}
            {alreadyInEnvironment && (
              <Alert tone="warning" title="Этот человек уже в вашем окружении" className="mb-6">
                {alreadyInEnvironment.myRole
                  ? `Вы называете его(её) «${alreadyInEnvironment.myRole}». Приглашение отправлять не нужно.`
                  : 'Приглашение отправлять не нужно.'}
              </Alert>
            )}
            {!alreadyInEnvironment && alreadyInvited && (
              <Alert tone="warning" title="Приглашение на этот номер уже отправлено" className="mb-6">
                Оно ждёт ответа — найдите его в разделе «Приглашения».
              </Alert>
            )}

            <div className="grid md:grid-cols-2" style={{ gap: 'var(--spacing-4)', marginBottom: 'var(--spacing-4)' }}>
              <RolePicker
                label="Моя роль (как он(а) видит меня)"
                value={invMeForThem}
                onChange={setInvMeForThem}
              />
              <RolePicker
                label={invLookup ? `Роль: ${invLookup.firstName}` : 'Его(её) роль'}
                value={invTheyForMe}
                onChange={setInvTheyForMe}
              />
            </div>

            <div style={{ marginBottom: 'var(--spacing-4)' }}>
              <GroupSelectField
                label="Сразу добавить в мои группы"
                hint="Необязательно — человек попадёт в эти группы, когда примет приглашение."
                groups={groups}
                value={invGroupIds}
                onChange={setInvGroupIds}
              />
            </div>

            <Input
              label="Сообщение"
              value={invMessage}
              onChange={(e) => setInvMessage(e.target.value)}
              placeholder="Привет! Давай добавимся…"
              wrapClassName="mb-6"
            />

            <Button
              type="submit"
              variant="primary"
              tone="success"
              icon="send"
              disabled={invPhone.length < PHONE_LOOKUP_MIN_LENGTH || inviteBlocked}
              loading={sending}
            >
              Отправить приглашение
            </Button>
          </form>
        </Card>
      )}

      {/* ---------------- Приглашения ---------------- */}
      <div style={{ marginBottom: 'var(--spacing-6)' }}>
        <CollapseHeader
          open={showInvitations}
          onToggle={() => setShowInvitations((v) => !v)}
          title="Приглашения"
          count={activeInvitations}
        />

        {showInvitations && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-3)' }}>
            <SegmentedControl
              aria-label="Какие приглашения показывать"
              value={invitationTab}
              onChange={setInvitationTab}
              items={[
                { key: 'active', label: 'Активные', count: activeInvitations },
                { key: 'history', label: 'История' },
              ]}
            />

            {invitationTab === 'active' ? (
              <>
                {activeInvitations === 0 && !incomingQ.isPending && !outgoingQ.isPending && (
                  <p className="label-sm" style={{ padding: 'var(--spacing-2) 0' }}>Активных приглашений нет</p>
                )}
                {incoming.map((inv) => (
                  <InvitationCard
                    key={inv.id}
                    direction="incoming"
                    status={inv.status}
                    myRole={inv.proposedRoleForRecipient}
                    theirRole={inv.proposedRoleForSender}
                    theirName={inv.from?.firstName || '?'}
                    theirUserId={inv.fromUserId}
                    theirPhone={inv.toPhone}
                    message={inv.message}
                    expiresAt={inv.expiresAt}
                    onAccept={() => setAcceptTarget(inv)}
                    onReject={() => void handleReject(inv.id)}
                    onBlock={() => handleBlock(inv.fromUserId, inv.from?.firstName || 'этого пользователя')}
                  />
                ))}
                {incomingQ.hasNextPage && (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={incomingQ.isFetchingNextPage}
                    onClick={() => void incomingQ.fetchNextPage()}
                  >
                    Показать ещё входящие
                  </Button>
                )}
                {outgoing.map((inv) => (
                  <InvitationCard
                    key={inv.id}
                    direction="outgoing"
                    status={inv.status}
                    myRole={inv.proposedRoleForSender}
                    theirRole={inv.proposedRoleForRecipient}
                    theirName={inv.to?.firstName || inv.toPhone}
                    theirUserId={inv.toUserId}
                    theirPhone={inv.toPhone}
                    registered={!!inv.to}
                    message={inv.message}
                    expiresAt={inv.expiresAt}
                    onCancel={() => void handleCancel(inv.id)}
                  />
                ))}
                {outgoingQ.hasNextPage && (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={outgoingQ.isFetchingNextPage}
                    onClick={() => void outgoingQ.fetchNextPage()}
                  >
                    Показать ещё приглашения
                  </Button>
                )}
              </>
            ) : (
              <>
                {historyQ.isError && (
                  <Alert
                    tone="danger"
                    action={<Button size="sm" variant="outline" icon="replay" onClick={() => void historyQ.refetch()}>Повторить</Button>}
                  >
                    Не удалось загрузить историю приглашений
                  </Alert>
                )}
                {historyQ.isPending && !historyQ.isError && (
                  <p className="label-sm" role="status" style={{ padding: 'var(--spacing-2) 0' }}>Загружаем историю…</p>
                )}
                {historyQ.isSuccess && history.length === 0 && (
                  <p className="label-sm" style={{ padding: 'var(--spacing-2) 0' }}>
                    История пуста — отклонённых и отменённых приглашений пока не было
                  </p>
                )}
                {history.map((inv) => (
                  <InvitationCard
                    key={inv.id}
                    direction="outgoing"
                    status={inv.status}
                    myRole={inv.proposedRoleForSender}
                    theirRole={inv.proposedRoleForRecipient}
                    theirName={inv.to?.firstName || inv.toPhone}
                    theirUserId={inv.toUserId}
                    theirPhone={inv.toPhone}
                    registered={!!inv.to}
                    message={inv.message}
                    expiresAt={inv.expiresAt}
                    canResend={inv.canResend}
                    busy={resendingId === inv.id}
                    onResend={() => void handleResend(inv.id)}
                  />
                ))}
                {historyQ.hasNextPage && (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={historyQ.isFetchingNextPage}
                    onClick={() => void historyQ.fetchNextPage()}
                  >
                    Показать ещё
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ---------------- Заблокированные ---------------- */}
      {blocks.length > 0 && (
        <div style={{ marginBottom: 'var(--spacing-6)' }}>
          <CollapseHeader
            open={showBlocked}
            onToggle={() => setShowBlocked((v) => !v)}
            title="Заблокированные"
            count={blocks.length}
            countTone="neutral"
          />

          {showBlocked && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-2)', marginTop: 'var(--spacing-3)' }}>
              {blocks.map((b) => (
                <Card key={b.id} small>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-3)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <PersonChip size="S" userId={b.blockedUserId}
                        firstName={b.blockedFirstName || '?'} lastName={b.blockedLastName}
                        avatar={b.blockedAvatar} />
                      <div className="label-sm" style={{ marginTop: '0.2rem' }}>
                        {b.blockedPhone} · заблокирован {new Date(b.createdAt).toLocaleDateString('ru-RU')}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      style={{ flexShrink: 0 }}
                      onClick={() => handleUnblock(b.blockedUserId, b.blockedFirstName || 'этого пользователя')}
                    >
                      Разблокировать
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---------------- Чипы-фильтры групп ---------------- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-4)', flexWrap: 'wrap' }}>
        <Chip tone="accent" selected={activeGroup === null} onClick={() => setActiveGroup(null)}>
          Все
        </Chip>

        {groups.map((g) => (
          <Fragment key={g.id}>
            <Chip
              tone="accent"
              emoji={g.icon}
              selected={activeGroup === g.id}
              onClick={() => setActiveGroup(g.id)}
              onRemove={() => confirm(
                { title: `Удалить группу «${g.name}»?`, message: 'Люди останутся в окружении — исчезнет только сама группа и её настройки видимости.', confirmLabel: 'Удалить', danger: true },
                async () => { await handleDeleteGroup(g.id); },
              )}
              removeLabel={`Удалить группу «${g.name}»`}
              // Цвет группы — ДАННЫЕ (человек выбрал его сам), поэтому приходит
              // не тоном, а подменой переменных тона у выбранного чипа.
              style={activeGroup === g.id && g.color ? { '--tone-bg': g.color, '--tone-border': g.color } as React.CSSProperties : undefined}
            >
              {g.name}
              <span style={{ opacity: 0.6, fontWeight: 600 }}>{g.membersCount}</span>
            </Chip>
            {/* Карандаш появляется у ВЫБРАННОЙ группы: правка (имя, значок, цвет,
                порядок) — редкое действие, и держать её кнопку у каждого чипа
                значило бы утопить в ней сам фильтр. */}
            {activeGroup === g.id && (
              <IconButton
                icon="edit"
                label={`Настроить группу «${g.name}»`}
                size={32}
                round={false}
                variant="outline"
                onClick={() => setEditingGroup(g)}
              />
            )}
          </Fragment>
        ))}

        <Button size="sm" variant="outline" icon="add" onClick={() => setShowCreateGroup((v) => !v)}>
          Группа
        </Button>
      </div>

      {/* ---------------- Создание группы ---------------- */}
      {showCreateGroup && (
        <Card small style={{ marginBottom: 'var(--spacing-4)' }}>
          <form onSubmit={handleCreateGroup} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
            <div style={{ display: 'flex', gap: 'var(--spacing-3)', alignItems: 'flex-end' }}>
              <GlyphField value={groupIcon} onChange={setGroupIcon} suggest={groupName} size={38} />
              <Input
                label="Название группы"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="Семья, Родственники…"
                autoFocus
                wrapClassName="group-name-field"
              />
            </div>

            <ColorPalette value={groupColor} onChange={setGroupColor} />

            {/* Заготовки — из общего пакета (`DEFAULT_CIRCLE_PRESETS`): локальная
                копия успела разъехаться с ним и по составу, и по цветам, и не
                несла значков. */}
            <div role="group" aria-label="Готовые названия групп" style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap' }}>
              {DEFAULT_CIRCLE_PRESETS.map((t) => (
                <Chip
                  key={t.name}
                  size="sm"
                  emoji={t.icon}
                  onClick={() => { setGroupName(t.name); setGroupColor(t.color); setGroupIcon(t.icon); }}
                  style={{ '--tone-bg': t.color, '--tone-border': t.color } as React.CSSProperties}
                >
                  {t.name}
                </Chip>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 'var(--spacing-2)' }}>
              <Button type="submit" size="sm" variant="primary" tone="success" disabled={!groupName.trim()} loading={creatingGroup}>
                Создать
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setShowCreateGroup(false)}>Отмена</Button>
            </div>
          </form>
        </Card>
      )}

      {/* ---------------- Видимость выбранной группы ---------------- */}
      {activeGroupObj && (
        <GroupVisibilityEditor
          key={activeGroupObj.id}
          group={activeGroupObj}
          onSaved={handleGroupVisibilitySaved}
        />
      )}

      {/* ---------------- Поиск и сортировка ---------------- */}
      {(baseList.length > 0 || search.length > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-4)', flexWrap: 'wrap' }}>
          <SearchField
            aria-label="Поиск по окружению: имя, роль или номер"
            placeholder="Имя, роль, номер…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClear={() => setSearch('')}
            width={280}
          />
          <SegmentedControl
            aria-label="Порядок людей"
            value={sort}
            onChange={setSort}
            items={[
              { key: 'recent', label: 'Недавние' },
              { key: 'name', label: 'По имени' },
            ]}
          />
        </div>
      )}

      {/* ---------------- Люди ---------------- */}
      {gridFailed ? (
        <Alert
          tone="danger"
          title="Не удалось загрузить"
          action={<Button size="sm" variant="outline" icon="replay" onClick={retryGrid}>Повторить</Button>}
        >
          {activeGroup ? 'Состав группы не загрузился.' : 'Список окружения не загрузился.'} Проверьте связь и попробуйте ещё раз.
        </Alert>
      ) : gridBusy ? (
        <ContactsGridSkeleton />
      ) : displayed.length === 0 ? (
        <Card>
          {search ? (
            <EmptyState
              icon="search"
              title="Никого не нашли"
              description={
                contactsQ.hasNextPage && !activeGroup
                  ? 'Поиск идёт по уже загруженным людям — возможно, нужный человек ниже по списку.'
                  : 'Попробуйте другое имя, роль или номер.'
              }
              action={
                <div style={{ display: 'flex', gap: 'var(--spacing-2)', flexWrap: 'wrap', justifyContent: 'center' }}>
                  <Button size="sm" variant="outline" onClick={() => setSearch('')}>Очистить поиск</Button>
                  {contactsQ.hasNextPage && !activeGroup && (
                    <Button size="sm" variant="outline" loading={contactsQ.isFetchingNextPage} onClick={() => void contactsQ.fetchNextPage()}>
                      Загрузить ещё
                    </Button>
                  )}
                </div>
              }
            />
          ) : activeGroup ? (
            <EmptyState
              icon="people"
              title="В этой группе пока никого"
              description="Откройте карточку человека в окружении и добавьте его в эту группу."
            />
          ) : (
            <EmptyState
              icon="circle"
              title="Пока никого в окружении"
              description="Добавьте человека по номеру телефона — он подтвердит связь, и вы увидите друг друга."
              action={<Button variant="primary" tone="success" icon="add" onClick={() => setShowInvite(true)}>Добавить</Button>}
            />
          )}
        </Card>
      ) : (
        <>
          <div style={GRID_STYLE}>
            {displayed.map((c) => (
              <PersonCard
                key={c.linkId}
                contact={c}
                folders={groups}
                activeFolder={activeGroup}
                onDelete={cardHandlers.get(c.linkId)!.onDelete}
                onBlock={cardHandlers.get(c.linkId)!.onBlock}
                onRemoveFromFolder={cardHandlers.get(c.linkId)!.onRemoveFromFolder}
                onAddToFolder={cardHandlers.get(c.linkId)!.onAddToFolder}
                myCoins={myCoinsBy?.get(c.them.id) ?? null}
                skin={skinByUser[c.them.id] ?? undefined}
              />
            ))}
          </div>

          {/* Постранично только в общем списке: состав группы сервер отдаёт целиком. */}
          {!activeGroup && contactsQ.hasNextPage && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--spacing-6)' }}>
              <Button
                variant="outline"
                icon="caretDown"
                loading={contactsQ.isFetchingNextPage}
                onClick={() => void contactsQ.fetchNextPage()}
              >
                Показать ещё
              </Button>
            </div>
          )}
        </>
      )}

      {editingGroup && (
        <GroupEditModal
          group={editingGroup}
          groups={groups}
          onClose={() => setEditingGroup(null)}
          onSaved={refreshGroups}
        />
      )}

      {acceptTarget && (
        <AcceptInvitationModal
          invitation={acceptTarget}
          groups={groups}
          onClose={() => setAcceptTarget(null)}
          onDone={() => {
            queryClient.invalidateQueries({ queryKey: incomingInvitationsKey });
            refreshContacts();
            refreshGroups(); // membersCount, если человека сразу положили в группы
          }}
        />
      )}

      {confirmUI}
    </div>
  );
}
