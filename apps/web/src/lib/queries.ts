// ============================================================
// Shared React Query keys + fetchers (arch-review block 9).
//
// The messenger established the pattern (query cache + targeted invalidation);
// this module makes the SAME keys reusable across pages, so contacts/circles
// fetched on /circles are reused on /calendar and /tasks instead of each page
// re-downloading them — and a mutation invalidates ONE key instead of the old
// "refetch absolutely everything" storm.
// ============================================================

import { infiniteQueryOptions } from '@tanstack/react-query';
import { apiGet } from './api';
import type {
  Contact,
  CursorPage,
  OffsetPage,
  Currency,
  CurrencyHolder,
  DriveSpaceRef,
  Circle,
  CircleWithMembers,
  ContactBlockRecord,
  FinBookOverviewDto,
  FinDebtDto,
  FinMonthReportDto,
  FinPeopleReportRowDto,
  FinPersonDto,
  FinRecurringRuleDto,
  FinShareDto,
  FinSharedBookDto,
  FinTransactionDto,
  FinTrendPointDto,
  IncomingInvitation,
  OutgoingInvitation,
  ProcessDefinitionDto,
  ProcessDefinitionDetailDto,
  ProcessInstanceDto,
  ProcessInstanceDetailDto,
  ProcessInstanceStatusDto,
  ProcessNodeTypeDto,
  ProcessInboxItem,
  ProcessReportDto,
  ProcessCredentialDto,
  OfficeHistoryPageDto,
  OfficeRoomDto,
  ChatterPageDto,
  Task,
  TaskFilter,
  TaskStats,
  Workspace,
  WorkspaceInvitation,
} from '@superapp/shared';

// ---- Keys (stable, shared between pages) ----
export const contactsKey = ['contacts'] as const;
export const circlesKey = ['circles'] as const;
export const circleDetailKey = (id: string) => ['circles', 'detail', id] as const;
export const incomingInvitationsKey = ['contacts', 'invitations', 'incoming'] as const;
// Исходящие приглашения живут в ДВУХ областях (активные / история) — у каждой свой
// курсор и свой кэш. Корневой ключ нужен для инвалидации обеих разом: отправка,
// отмена и повтор меняют состав и там, и там.
export const outgoingInvitationsRootKey = ['contacts', 'invitations', 'outgoing'] as const;
export const outgoingInvitationsKey = (scope: InvitationScope = 'pending') =>
  ['contacts', 'invitations', 'outgoing', scope] as const;
export const blocksKey = ['contacts', 'blocks'] as const;
// Окружение ПОСТРАНИЧНО (курсор) — ключ ОТДЕЛЬНЫЙ от contactsKey намеренно:
// contactsKey держит плоский Contact[], и его читают пикеры задач, календаря и
// магазина. Положить туда InfiniteData значило бы молча сломать их всех.
// Ключ вложен под ['contacts'], поэтому инвалидация contactsKey накрывает и его.
export const contactsPagesKey = ['contacts', 'pages'] as const;
export const currencyBadgeKey = ['wallet', 'currency-badge'] as const;
// Мессенджер: кэш чатов/сообщений ОБЩИЙ между /messenger и контекстными чатами
// (деталька задачи, комната офиса) — рассинхрон литералов молча разорвал бы кэш,
// поэтому ключи живут только здесь
export const messengerChatsKey = ['messenger', 'chats'] as const;
export const messengerChatDetailKey = (chatId: string) => ['messenger', 'detail', chatId] as const;
export const messengerMessagesKey = (chatId: string) => ['messenger', 'messages', chatId] as const;
// Организации (B2B): список кормит И переключатель контекста в топбаре (AppShell),
// И панель на дашборде. Ключ ОБЩИЙ и живёт здесь: пока панель держала свой запрос
// мимо кэша, созданная организация (принятый найм, возврат из архива) не появлялась
// в переключателе до перезагрузки — обозреватель шелла смонтирован постоянно и сам
// не перезапрашивает. Мутации панели инвалидируют этот префикс.
export const workspacesKey = ['workspaces'] as const;
export const workspacesArchivedKey = ['workspaces', 'archived'] as const;
export const workspacesIncomingInvitationsKey = ['workspaces', 'invitations', 'incoming'] as const;
// Сервис «Сотрудники» (B2B)
export const workspaceKey = (id: string) => ['workspaces', id] as const;
export const workspaceMembersKey = (id: string) => ['workspaces', id, 'members'] as const;
export const workspaceStaffKey = (id: string) => ['workspaces', id, 'staff'] as const;
export const workspaceInvitationsKey = (id: string) => ['workspaces', id, 'invitations'] as const;
// Сервис «Процессы» (B2B)
export const processesKey = (wsId: string) => ['workspaces', wsId, 'processes'] as const;
export const processKey = (wsId: string, defId: string) =>
  ['workspaces', wsId, 'processes', defId] as const;
// Профиль в ключе: у кадрового маршрута палитра урезана до 7 нод, у общего —
// полная, и это РАЗНЫЕ ответы; общий ключ отдавал бы кадровику чужой список.
export const processNodeTypesKey = (wsId: string, surface?: string | null) =>
  ['workspaces', wsId, 'processes', 'node-types', surface ?? 'general'] as const;
export const processInstancesKey = (wsId: string) =>
  ['workspaces', wsId, 'processes', 'instances'] as const;
export const processInstanceKey = (wsId: string, instId: string) =>
  ['workspaces', wsId, 'processes', 'instances', instId] as const;
export const processInstanceStatusKey = (wsId: string, instId: string) =>
  ['workspaces', wsId, 'processes', 'instances', instId, 'status'] as const;
export const processInboxKey = (wsId: string) =>
  ['workspaces', wsId, 'processes', 'inbox'] as const;
export const processReportKey = (wsId: string, defId: string) =>
  ['workspaces', wsId, 'processes', defId, 'report'] as const;
export const processCredentialsKey = (wsId: string) =>
  ['workspaces', wsId, 'processes', 'credentials'] as const;
// Скины карточки (профиль → «Скины карточки»)
export const cardSkinsWalletKey = ['card-skins', 'wallet'] as const;
export const cardSkinsCatalogKey = ['card-skins', 'catalog'] as const;
export const cardSkinsInventoryKey = ['card-skins', 'inventory'] as const;
export const cardSkinsEquipKey = ['card-skins', 'equip'] as const;
// Кошелёк (профиль → «Кошелёк» и кошелёк организации)
export const walletOverviewKey = ['wallet', 'overview'] as const;
export const walletHistoryKey = ['wallet', 'history'] as const;
export const walletCurrencyKey = ['wallet', 'currency'] as const;
export const walletHoldersKey = ['wallet', 'holders'] as const;
// Карты-реквизиты для выплат (без CVV)
export const walletCardsKey = ['wallet', 'cards'] as const;
export const companyWalletKey = (wsId: string) => ['workspaces', wsId, 'wallet'] as const;
// Реквизиты организации (анкета + карточка компании)
export const workspaceRequisitesKey = (wsId: string) => ['workspaces', wsId, 'requisites'] as const;
export const companyHoldersKey = (wsId: string) => ['workspaces', wsId, 'wallet', 'holders'] as const;
// Магазин (My Wish & Shop)
export const shopMineKey = ['shop', 'mine'] as const;
export const shopAccessibleKey = ['shop', 'accessible'] as const;
export const shopOfKey = (ownerId: string) => ['shop', 'of', ownerId] as const;
export const shopListingsKey = (showcaseId: string) => ['shop', 'listings', showcaseId] as const;
// Files engine (core/files)
export const filesUsageKey = ['files', 'usage'] as const;
export const fileUrlKey = (id: string, variant?: string) =>
  ['files', 'url', id, variant ?? 'original'] as const;
export const fileMetaKey = (id: string) => ['files', 'meta', id] as const;
export const taskAttachmentsKey = (taskId: string) => ['tasks', 'attachments', taskId] as const;
// OmniDrive («Диск»). Всё под корнем ['drive'] — одна инвалидация префикса после
// мутации обновляет и листинг, и обзор, и корзину, и ленту «Фото».
const driveScope = (ref: DriveSpaceRef) => ref.workspaceId ?? ref.spaceId ?? 'own';
export const driveRootKey = ['drive'] as const;
export const driveOverviewKey = (ref: DriveSpaceRef) => ['drive', 'overview', driveScope(ref)] as const;
export const driveListKey = (ref: DriveSpaceRef, parentId: string | null, sort: string, dir: string) =>
  ['drive', 'list', driveScope(ref), parentId ?? 'root', sort, dir] as const;
export const driveNodeKey = (id: string) => ['drive', 'node', id] as const;
export const driveSharesKey = (id: string) => ['drive', 'shares', id] as const;
export const driveVersionsKey = (id: string) => ['drive', 'versions', id] as const;
export const driveTrashKey = (ref: DriveSpaceRef) => ['drive', 'trash', driveScope(ref)] as const;
export const driveStarredKey = ['drive', 'starred'] as const;

// ---- Гостевые ссылки (core/share-links) ----
// Ключ общий для ЛЮБОГО потребителя движка: блок управления ссылками один и тот же
// и на Диске, и на документе, и на будущих счетах.
export const shareLinksKey = (refType: string, refId: string) => ['share-links', refType, refId] as const;
// Отдельный корень, а не ['share-links','visits',…]: refType — свободная строка движка,
// и сервис с типом «visits» однажды схлопнул бы два разных запроса в один префикс.
export const shareLinkVisitsKey = (linkId: string) => ['share-link-visits', linkId] as const;
/** Раздел «Мои ссылки»: свой корень — инвалидация списка объекта его не трогает */
export const myShareLinksKey = (status: string) => ['my-share-links', status] as const;
/** Префикс скоупа «Мои ссылки» / «Ссылки организации» — по нему инвалидируется всё после отзыва */
export const myShareLinksScopeKey = ['share-links', 'mine'] as const;
export const workspaceShareLinksScopeKey = (wsId: string) => ['share-links', 'workspace', wsId] as const;
/** Своим корнем, а не веткой ['my-share-links','stats']: фильтр — тоже строка в том же месте */
export const myShareStatsKey = () => ['my-share-stats'] as const;
export const driveRecentKey = ['drive', 'recent'] as const;
export const drivePhotoBucketsKey = (ref: DriveSpaceRef) => ['drive', 'photos', 'buckets', driveScope(ref)] as const;
export const drivePhotosKey = (ref: DriveSpaceRef, month?: string) =>
  ['drive', 'photos', 'page', driveScope(ref), month ?? 'all'] as const;
// Голосовой движок (core/voice) + Диктофон
export const voiceStatusKey = ['voice', 'status'] as const;
export const voiceTranscriptKey = (fileId: string) => ['voice', 'transcript', fileId] as const;
export const recorderRecordingsKey = ['recorder', 'recordings'] as const;
// Движок документов (core/docs): статус кэшируется надолго — от него зависит только
// показ кнопок «Открыть/Редактировать» у офисных вложений.
export const docsStatusKey = ['docs', 'status'] as const;
export const documentKey = (id: string) => ['docs', 'document', id] as const;
export const documentVersionsKey = (id: string) => ['docs', 'versions', id] as const;
// Движок звонков (core/calls) + сервис «Виртуальный офис» (B2B)
export const callsStatusKey = ['calls', 'status'] as const;
export const officeRoomsKey = (wsId: string) => ['workspaces', wsId, 'office'] as const;
export const officeRoomKey = (wsId: string, roomId: string) =>
  ['workspaces', wsId, 'office', roomId] as const;
// Вложен под officeRoomsKey — invalidate списка префиксно обновляет и историю
export const officeHistoryKey = (wsId: string) =>
  ['workspaces', wsId, 'office', 'history'] as const;

// ---- Согласования (core/approvals), для человека — «Ждут решения» ----
// Всё под корнем ['approvals']: одна инвалидация префикса после решения обновляет
// и стопку, и счётчик бейджа, и «мои заявки», и открытую карточку заявки.
export const approvalsRootKey = ['approvals'] as const;

/**
 * Чей вопрос задаём движку решений.
 *
 * `{}` (или не передан) — СКВОЗНОЙ вид: всё, что ждёт человека, из всех его
 * организаций и личного. Так работают верхние иконки топбара: они висят над любой
 * страницей, и приказ на подпись не должен «исчезать» из-за того, что человек
 * сейчас смотрит другой контекст.
 *
 * `{personal:true}` — только личные заявки: витрины ВНУТРИ личного контекста
 * (плитка Главной). У человека с пятью компаниями иначе копится каша.
 *
 * `{workspaceId}` — только эта организация. Сильнее `personal`.
 */
export type ApprovalScope = { workspaceId?: string; personal?: boolean };

/** Скоуп → часть ключа кэша. Три состояния должны давать ТРИ разных ключа */
export const approvalScopeKey = (scope?: ApprovalScope): string =>
  scope?.workspaceId ?? (scope?.personal ? 'personal' : 'all');

/** Скоуп → query-параметры ручек движка (разбор скоупа живёт на сервере) */
export const approvalScopeParams = (scope?: ApprovalScope): { workspaceId?: string; scope?: 'personal' } =>
  scope?.workspaceId ? { workspaceId: scope.workspaceId } : scope?.personal ? { scope: 'personal' } : {};

export const approvalInboxKey = (scope?: ApprovalScope, sourceKey?: string) =>
  ['approvals', 'inbox', approvalScopeKey(scope), sourceKey ?? 'all'] as const;
/** Счётчик бейджа — свой ключ: он поллится, а список нет */
export const approvalCountKey = (scope?: ApprovalScope) =>
  ['approvals', 'count', approvalScopeKey(scope)] as const;
export const approvalKey = (id: string) => ['approvals', 'detail', id] as const;
export const myApprovalsKey = (scope?: ApprovalScope, archived?: boolean) =>
  ['approvals', 'mine', approvalScopeKey(scope), archived ? 'archived' : 'active'] as const;

// ---- Fetchers ----

/**
 * Всё окружение одним массивом. Нужен ПИКЕРАМ (задачи, календарь, магазин): им
 * нечего листать — они ищут по полному списку. Экрану «Моё окружение» вместо
 * этого нужен `fetchContactsPage` (первый экран не должен ждать N round-trip).
 */
export async function fetchAllContacts(): Promise<Contact[]> {
  const acc: Contact[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchContactsPage(cursor);
    acc.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return acc;
}

/** Одна страница окружения — для useInfiniteQuery на «Моё окружение». */
export async function fetchContactsPage(cursor?: string): Promise<CursorPage<Contact>> {
  return apiGet<CursorPage<Contact>>('/contacts', { params: cursor ? { cursor } : undefined });
}

export async function fetchCircles(): Promise<Circle[]> {
  return apiGet<Circle[]>('/circles');
}

export async function fetchCircleDetail(id: string): Promise<CircleWithMembers> {
  return apiGet<CircleWithMembers>(`/circles/${id}`);
}

/**
 * Входящие приглашения. Курсор сервер отдаёт с самого начала, а клиент его ВЫБРАСЫВАЛ
 * (тип возврата был просто массивом) — то есть у человека с длинным хвостом
 * приглашений вторая страница не существовала в принципе.
 */
export async function fetchIncomingInvitations(
  cursor?: string,
): Promise<CursorPage<IncomingInvitation>> {
  return apiGet<CursorPage<IncomingInvitation>>('/contacts/invitations/incoming', {
    params: cursor ? { cursor } : undefined,
  });
}

/**
 * ЕДИНОЕ описание бесконечной ленты входящих приглашений — для ВСЕХ потребителей
 * ключа (страница «Моё окружение» и панель на Главной). Ключ у кэша один, а формы
 * данных у useQuery и useInfiniteQuery РАЗНЫЕ ({items,…} против {pages,…}):
 * пока Главная писала под этот ключ плоскую страницу обычным useQuery, переход
 * Главная → Окружение ронял /circles («Cannot read properties of undefined
 * (reading 'length')» — внутренности useInfiniteQuery читали .pages у плоской
 * формы). Правило: один ключ = ОДНА форма, и она объявлена здесь, рядом с ключом;
 * свой запрос по месту на этот ключ собирать нельзя.
 */
export const incomingInvitationsInfinite = () =>
  infiniteQueryOptions({
    queryKey: incomingInvitationsKey,
    queryFn: ({ pageParam }) => fetchIncomingInvitations(pageParam || undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

/**
 * Область исходящих приглашений. `history` отдаёт НЕ-pending строки (отклонённые,
 * отменённые, истёкшие) — без них «Отправить повторно» физически недостижимо:
 * повтор требует ровно такого статуса, а id брать было неоткуда.
 */
export type InvitationScope = 'pending' | 'history';

export async function fetchOutgoingInvitations(
  scope: InvitationScope = 'pending',
  cursor?: string,
): Promise<CursorPage<OutgoingInvitation>> {
  return apiGet<CursorPage<OutgoingInvitation>>('/contacts/invitations/outgoing', {
    params: { scope, ...(cursor ? { cursor } : {}) },
  });
}

export async function fetchBlocks(): Promise<ContactBlockRecord[]> {
  return apiGet<ContactBlockRecord[]>('/contacts/blocks');
}

// ---- Организации (B2B) ----

export async function fetchWorkspaces(): Promise<Workspace[]> {
  return apiGet<Workspace[]>('/workspaces');
}

export async function fetchWorkspacesArchived(): Promise<Workspace[]> {
  return apiGet<Workspace[]>('/workspaces/archived');
}

export async function fetchWorkspaceIncomingInvitations(): Promise<WorkspaceInvitation[]> {
  return apiGet<WorkspaceInvitation[]>('/workspaces/invitations/incoming');
}

// ---- Процессы (B2B) ----

export async function fetchProcesses(wsId: string): Promise<ProcessDefinitionDto[]> {
  return apiGet<ProcessDefinitionDto[]>(`/workspaces/${wsId}/processes`);
}

export async function fetchProcess(wsId: string, defId: string): Promise<ProcessDefinitionDetailDto> {
  return apiGet<ProcessDefinitionDetailDto>(`/workspaces/${wsId}/processes/${defId}`);
}

export async function fetchProcessNodeTypes(
  wsId: string,
  surface?: string | null,
): Promise<ProcessNodeTypeDto[]> {
  return apiGet<ProcessNodeTypeDto[]>(`/workspaces/${wsId}/processes/node-types`, {
    // Профиль режет палитру под предметную область: кадровик не видит ноды про
    // счета и AI-агентов — он и не должен решать, нужны ли они его приказу.
    params: surface && surface !== 'general' ? { surface } : undefined,
  });
}

export async function fetchProcessInstances(
  wsId: string,
  filter?: { definitionId?: string; status?: string },
): Promise<ProcessInstanceDto[]> {
  return apiGet<ProcessInstanceDto[]>(`/workspaces/${wsId}/processes/instances`, { params: filter });
}

export async function fetchProcessInstance(
  wsId: string,
  instId: string,
): Promise<ProcessInstanceDetailDto> {
  return apiGet<ProcessInstanceDetailDto>(`/workspaces/${wsId}/processes/instances/${instId}`);
}

/** Тонкий статус для поллинга (P7): без документа/анкеты — только статусы шагов. */
export async function fetchProcessInstanceStatus(
  wsId: string,
  instId: string,
): Promise<ProcessInstanceStatusDto> {
  return apiGet<ProcessInstanceStatusDto>(`/workspaces/${wsId}/processes/instances/${instId}/status`);
}

export async function fetchProcessInbox(wsId: string): Promise<ProcessInboxItem[]> {
  return apiGet<ProcessInboxItem[]>(`/workspaces/${wsId}/processes/inbox`);
}

export async function fetchProcessReport(wsId: string, defId: string): Promise<ProcessReportDto> {
  return apiGet<ProcessReportDto>(`/workspaces/${wsId}/processes/${defId}/report`);
}

export async function fetchProcessCredentials(wsId: string): Promise<ProcessCredentialDto[]> {
  return apiGet<ProcessCredentialDto[]>(`/workspaces/${wsId}/processes/credentials`);
}

// ---- Виртуальный офис (B2B) ----

export async function fetchOfficeRooms(wsId: string): Promise<OfficeRoomDto[]> {
  return apiGet<OfficeRoomDto[]>(`/workspaces/${wsId}/office`);
}

export async function fetchOfficeRoom(wsId: string, roomId: string): Promise<OfficeRoomDto> {
  return apiGet<OfficeRoomDto>(`/workspaces/${wsId}/office/rooms/${roomId}`);
}

export async function fetchOfficeHistory(wsId: string, cursor?: string): Promise<OfficeHistoryPageDto> {
  return apiGet<OfficeHistoryPageDto>(`/workspaces/${wsId}/office/history`, {
    params: cursor ? { cursor } : undefined,
  });
}

// ---- Задачи (B2C) ----
// Все ключи под корнем ['tasks'] — одна инвалидация queryClient.invalidateQueries
// ({queryKey: ['tasks']}) обновляет списки, деталь, счётчики и бейджи сайдбара разом.

export const taskStatsKey = ['tasks', 'stats'] as const;
export const tasksListKey = (filters: Record<string, unknown>) => ['tasks', 'list', filters] as const;
export const taskDetailKey = (id: string) => ['tasks', 'detail', id] as const;

/** Список задач: смарт-лист/статусы/приоритеты/роль/поиск/пагинация — всё умеет API. */
export async function fetchTasks(filters: Partial<TaskFilter>): Promise<OffsetPage<Task>> {
  const params: Record<string, string> = {};
  if (filters.smartList) params.smartList = filters.smartList;
  if (filters.role) params.role = filters.role;
  if (filters.status?.length) params.status = filters.status.join(',');
  if (filters.priority?.length) params.priority = filters.priority.join(',');
  if (filters.search) params.search = filters.search;
  if (filters.dueDateFrom) params.dueDateFrom = filters.dueDateFrom;
  if (filters.dueDateTo) params.dueDateTo = filters.dueDateTo;
  if (filters.page) params.page = String(filters.page);
  if (filters.limit) params.limit = String(filters.limit);
  return apiGet<OffsetPage<Task>>('/tasks', { params });
}

/** Счётчики смарт-листов (бейджи сайдбара + карточки «Обзора»). */
export async function fetchTaskStats(): Promise<TaskStats> {
  return apiGet<TaskStats>('/tasks/stats');
}

export async function fetchTask(id: string): Promise<Task> {
  return apiGet<Task>(`/tasks/${id}`);
}

// ---- Финансы (B2C) ----

export const financeOverviewKey = (bookId?: string | null) =>
  ['finance', 'overview', bookId ?? 'own'] as const;
export const financeTransactionsKey = (filter?: Record<string, string | undefined>) =>
  ['finance', 'transactions', filter ?? {}] as const;

export async function fetchFinanceOverview(bookId?: string | null): Promise<FinBookOverviewDto> {
  return apiGet<FinBookOverviewDto>('/finance', { params: bookId ? { bookId } : undefined });
}

export async function fetchFinanceTransactions(
  params: Record<string, string | undefined>,
): Promise<CursorPage<FinTransactionDto>> {
  return apiGet<CursorPage<FinTransactionDto>>('/finance/transactions', { params });
}

// Сервис «Документы» (B2B). Ключи с фильтрами: реестр перезапрашивается при смене
// фильтра, а список видов и шаблонов общий — его инвалидируют настройки сервиса.
export const docTypesKey = (wsId: string) => ['workspaces', wsId, 'documents', 'types'] as const;
export const docTemplatesKey = (wsId: string) => ['workspaces', wsId, 'documents', 'templates'] as const;
export const docTemplateGrantsKey = (wsId: string, tplId: string) =>
  ['workspaces', wsId, 'documents', 'templates', tplId, 'grants'] as const;
export const availableTemplatesKey = (wsId: string) =>
  ['workspaces', wsId, 'documents', 'available'] as const;
export const orgDocumentsKey = (wsId: string, filters?: Record<string, string | undefined>) =>
  ['workspaces', wsId, 'documents', 'list', JSON.stringify(filters ?? {})] as const;
/**
 * ПРЕФИКС всех списков реестра — им и надо инвалидировать после мутации.
 * `orgDocumentsKey(id)` для этого не годится: он несёт ещё и сериализованные фильтры
 * (`'{}'`), поэтому совпадает ровно с одним списком — без фильтров, — а вкладки
 * «Мои документы» и «Заявления» держат в ключе userId и молча оставались старыми.
 */
export const orgDocumentsPrefix = (wsId: string) => ['workspaces', wsId, 'documents', 'list'] as const;
export const orgDocumentKey = (wsId: string, docId: string) =>
  ['workspaces', wsId, 'documents', 'card', docId] as const;
/** Группы полей шаблона — статичны на процесс API, поэтому ключ без организации */
export const templateFieldGroupsKey = ['templates', 'field-groups'] as const;

// Сервис «Контрагенты» (B2B): справочник внешних сторон организации.
export const counterpartiesKey = (wsId: string, filters?: Record<string, string | undefined>) =>
  ['workspaces', wsId, 'counterparties', 'list', JSON.stringify(filters ?? {})] as const;
/** ПРЕФИКС списков — им инвалидируют мутации (ключ несёт сериализованные фильтры) */
export const counterpartiesPrefix = (wsId: string) => ['workspaces', wsId, 'counterparties', 'list'] as const;
export const counterpartyKey = (wsId: string, cpId: string) =>
  ['workspaces', wsId, 'counterparties', 'card', cpId] as const;

// Хроника (core/chatter): журнал организации + хроника одной записи
export const workspaceJournalKey = (wsId: string, category?: string | null) =>
  ['workspaces', wsId, 'journal', category ?? 'all'] as const;
export const chronicleKey = (refType: string, refId: string) =>
  ['chatter', refType, refId] as const;

export async function fetchWorkspaceJournal(
  wsId: string,
  params: { cursor?: string; category?: string },
): Promise<ChatterPageDto> {
  return apiGet<ChatterPageDto>(`/workspaces/${wsId}/journal`, { params });
}

export async function fetchChronicle(
  refType: string,
  refId: string,
  params: { cursor?: string } = {},
): Promise<ChatterPageDto> {
  return apiGet<ChatterPageDto>(`/chatter/${refType}/${refId}`, { params });
}

export const financeSharedBooksKey = ['finance', 'shared-with-me'] as const;
export const financeSharesKey = (bookId?: string | null) => ['finance', 'shares', bookId ?? 'own'] as const;

export async function fetchFinanceSharedBooks(): Promise<FinSharedBookDto[]> {
  return apiGet<FinSharedBookDto[]>('/finance/shared-with-me');
}

export async function fetchFinanceShares(bookId?: string | null): Promise<FinShareDto[]> {
  return apiGet<FinShareDto[]>('/finance/shares', { params: bookId ? { bookId } : undefined });
}

export const financeDebtsKey = (bookId?: string | null) => ['finance', 'debts', bookId ?? 'own'] as const;
export const financeRecurringKey = (bookId?: string | null) => ['finance', 'recurring', bookId ?? 'own'] as const;

export async function fetchFinanceDebts(bookId?: string | null): Promise<FinDebtDto[]> {
  return apiGet<FinDebtDto[]>('/finance/debts', { params: bookId ? { bookId } : undefined });
}

export async function fetchFinanceRecurring(bookId?: string | null): Promise<FinRecurringRuleDto[]> {
  return apiGet<FinRecurringRuleDto[]>('/finance/recurring', { params: bookId ? { bookId } : undefined });
}

/** Последние операции для страницы «Обзор» (отдельный ключ: useInfiniteQuery ленты хранит другую форму данных). */
export const financeRecentTxKey = (bookId?: string | null) =>
  ['finance', 'transactions', 'recent', bookId ?? 'own'] as const;

export const financePeopleKey = (bookId?: string | null) => ['finance', 'people', bookId ?? 'own'] as const;
export const financePeopleReportKey = (from: string, to: string, bookId?: string | null) =>
  ['finance', 'report', 'people', from, to, bookId ?? 'own'] as const;

export async function fetchFinancePeople(bookId?: string | null): Promise<FinPersonDto[]> {
  return apiGet<FinPersonDto[]>('/finance/people', { params: bookId ? { bookId } : undefined });
}

export async function fetchFinancePeopleReport(
  from: string,
  to: string,
  bookId?: string | null,
): Promise<FinPeopleReportRowDto[]> {
  return apiGet<FinPeopleReportRowDto[]>('/finance/reports/people', { params: { from, to, ...(bookId ? { bookId } : {}) } });
}

export const financeMonthReportKey = (period: string, bookId?: string | null) =>
  ['finance', 'report', 'month', period, bookId ?? 'own'] as const;
export const financeTrendKey = (months: number, bookId?: string | null) =>
  ['finance', 'report', 'trend', months, bookId ?? 'own'] as const;

export async function fetchFinanceMonthReport(period: string, bookId?: string | null): Promise<FinMonthReportDto> {
  return apiGet<FinMonthReportDto>('/finance/reports/month', { params: { period, ...(bookId ? { bookId } : {}) } });
}

export async function fetchFinanceTrend(months: number, bookId?: string | null): Promise<FinTrendPointDto[]> {
  return apiGet<FinTrendPointDto[]>('/finance/reports/trend', { params: { months, ...(bookId ? { bookId } : {}) } });
}

/** My currency icon + per-holder balances ("держит N 🪙" badges). Optional context. */
export async function fetchCurrencyBadge(): Promise<{ icon: string | null; holders: Record<string, number> }> {
  try {
    const [cur, holders] = await Promise.all([
      apiGet<Currency | null>('/wallet/currency'),
      apiGet<CurrencyHolder[]>('/wallet/currency/holders'),
    ]);
    const map: Record<string, number> = {};
    for (const h of holders) map[h.userId] = h.balance;
    return { icon: cur?.icon ?? null, holders: map };
  } catch {
    return { icon: null, holders: {} };
  }
}
