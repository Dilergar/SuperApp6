// ============================================================
// Shared React Query keys + fetchers (arch-review block 9).
//
// The messenger established the pattern (query cache + targeted invalidation);
// this module makes the SAME keys reusable across pages, so contacts/circles
// fetched on /circles are reused on /calendar and /tasks instead of each page
// re-downloading them — and a mutation invalidates ONE key instead of the old
// "refetch absolutely everything" storm.
// ============================================================

import { api } from './api';
import type {
  Contact,
  Circle,
  CircleWithMembers,
  ContactBlockRecord,
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
} from '@superapp/shared';

// ---- Keys (stable, shared between pages) ----
export const contactsKey = ['contacts'] as const;
export const circlesKey = ['circles'] as const;
export const circleDetailKey = (id: string) => ['circles', 'detail', id] as const;
export const incomingInvitationsKey = ['contacts', 'invitations', 'incoming'] as const;
export const outgoingInvitationsKey = ['contacts', 'invitations', 'outgoing'] as const;
export const blocksKey = ['contacts', 'blocks'] as const;
export const currencyBadgeKey = ['wallet', 'currency-badge'] as const;
// Сервис «Сотрудники» (B2B)
export const workspaceKey = (id: string) => ['workspaces', id] as const;
export const workspaceMembersKey = (id: string) => ['workspaces', id, 'members'] as const;
export const workspaceStaffKey = (id: string) => ['workspaces', id, 'staff'] as const;
export const workspaceInvitationsKey = (id: string) => ['workspaces', id, 'invitations'] as const;
// Сервис «Процессы» (B2B)
export const processesKey = (wsId: string) => ['workspaces', wsId, 'processes'] as const;
export const processKey = (wsId: string, defId: string) =>
  ['workspaces', wsId, 'processes', defId] as const;
export const processNodeTypesKey = (wsId: string) =>
  ['workspaces', wsId, 'processes', 'node-types'] as const;
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

// ---- Fetchers ----

/** The whole environment (cursor-paginated server-side; the UI shows everyone). */
export async function fetchAllContacts(): Promise<Contact[]> {
  const acc: Contact[] = [];
  let cursor: string | undefined;
  do {
    const res = await api.get('/contacts', { params: cursor ? { cursor } : undefined });
    acc.push(...res.data.data);
    cursor = res.data.nextCursor ?? undefined;
  } while (cursor);
  return acc;
}

export async function fetchCircles(): Promise<Circle[]> {
  const res = await api.get('/circles');
  return res.data.data;
}

export async function fetchCircleDetail(id: string): Promise<CircleWithMembers> {
  const res = await api.get(`/circles/${id}`);
  return res.data.data;
}

export async function fetchIncomingInvitations(): Promise<IncomingInvitation[]> {
  const res = await api.get('/contacts/invitations/incoming');
  return res.data.data;
}

export async function fetchOutgoingInvitations(): Promise<OutgoingInvitation[]> {
  const res = await api.get('/contacts/invitations/outgoing');
  return res.data.data;
}

export async function fetchBlocks(): Promise<ContactBlockRecord[]> {
  const res = await api.get('/contacts/blocks');
  return res.data.data;
}

// ---- Процессы (B2B) ----

export async function fetchProcesses(wsId: string): Promise<ProcessDefinitionDto[]> {
  const res = await api.get(`/workspaces/${wsId}/processes`);
  return res.data.data;
}

export async function fetchProcess(wsId: string, defId: string): Promise<ProcessDefinitionDetailDto> {
  const res = await api.get(`/workspaces/${wsId}/processes/${defId}`);
  return res.data.data;
}

export async function fetchProcessNodeTypes(wsId: string): Promise<ProcessNodeTypeDto[]> {
  const res = await api.get(`/workspaces/${wsId}/processes/node-types`);
  return res.data.data;
}

export async function fetchProcessInstances(
  wsId: string,
  filter?: { definitionId?: string; status?: string },
): Promise<ProcessInstanceDto[]> {
  const res = await api.get(`/workspaces/${wsId}/processes/instances`, { params: filter });
  return res.data.data;
}

export async function fetchProcessInstance(
  wsId: string,
  instId: string,
): Promise<ProcessInstanceDetailDto> {
  const res = await api.get(`/workspaces/${wsId}/processes/instances/${instId}`);
  return res.data.data;
}

/** Тонкий статус для поллинга (P7): без документа/анкеты — только статусы шагов. */
export async function fetchProcessInstanceStatus(
  wsId: string,
  instId: string,
): Promise<ProcessInstanceStatusDto> {
  const res = await api.get(`/workspaces/${wsId}/processes/instances/${instId}/status`);
  return res.data.data;
}

export async function fetchProcessInbox(wsId: string): Promise<ProcessInboxItem[]> {
  const res = await api.get(`/workspaces/${wsId}/processes/inbox`);
  return res.data.data;
}

export async function fetchProcessReport(wsId: string, defId: string): Promise<ProcessReportDto> {
  const res = await api.get(`/workspaces/${wsId}/processes/${defId}/report`);
  return res.data.data;
}

export async function fetchProcessCredentials(wsId: string): Promise<ProcessCredentialDto[]> {
  const res = await api.get(`/workspaces/${wsId}/processes/credentials`);
  return res.data.data;
}

/** My currency icon + per-holder balances ("держит N 🪙" badges). Optional context. */
export async function fetchCurrencyBadge(): Promise<{ icon: string | null; holders: Record<string, number> }> {
  try {
    const [cur, holders] = await Promise.all([
      api.get('/wallet/currency'),
      api.get('/wallet/currency/holders'),
    ]);
    const map: Record<string, number> = {};
    for (const h of holders.data.data as Array<{ userId: string; balance: number }>) {
      map[h.userId] = h.balance;
    }
    return { icon: cur.data.data?.icon ?? null, holders: map };
  } catch {
    return { icon: null, holders: {} };
  }
}
