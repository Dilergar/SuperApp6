// ============================================================
// Сервис «Контрагенты» — тонкий слой запросов раздела.
// Типы — только из @superapp/shared (правило «Контракт API ↔ клиенты»).
// ============================================================

import type {
  CounterpartyBankAccountDto,
  CounterpartyContactDto,
  CounterpartyDto,
  CounterpartyLiteDto,
  CursorPage,
} from '@superapp/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';

const base = (wsId: string) => `/workspaces/${wsId}/counterparties`;

export async function fetchCounterparties(
  wsId: string,
  params: Record<string, string | number | undefined>,
): Promise<CursorPage<CounterpartyDto>> {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  return await apiGet(base(wsId), { params: clean });
}

export async function fetchCounterparty(wsId: string, cpId: string): Promise<CounterpartyDto> {
  return await apiGet(`${base(wsId)}/${cpId}`);
}

/** Дедуп в форме: живой контрагент с таким БИН/ИИН уже есть? */
export async function lookupCounterparty(wsId: string, bin: string): Promise<CounterpartyLiteDto | null> {
  return await apiGet(`${base(wsId)}/lookup`, { params: { bin } });
}

export const counterpartiesApi = {
  base,
  create: (wsId: string, body: Record<string, unknown>) => apiPost<CounterpartyDto>(base(wsId), body),
  update: (wsId: string, cpId: string, body: Record<string, unknown>) =>
    apiPatch<CounterpartyDto>(`${base(wsId)}/${cpId}`, body),
  archive: (wsId: string, cpId: string) => apiDelete(`${base(wsId)}/${cpId}`),
  restore: (wsId: string, cpId: string) => apiPost<CounterpartyDto>(`${base(wsId)}/${cpId}/restore`),

  addContact: (wsId: string, cpId: string, body: Record<string, unknown>) =>
    apiPost<CounterpartyContactDto>(`${base(wsId)}/${cpId}/contacts`, body),
  updateContact: (wsId: string, cpId: string, contactId: string, body: Record<string, unknown>) =>
    apiPatch<CounterpartyContactDto>(`${base(wsId)}/${cpId}/contacts/${contactId}`, body),
  removeContact: (wsId: string, cpId: string, contactId: string) =>
    apiDelete(`${base(wsId)}/${cpId}/contacts/${contactId}`),

  addAccount: (wsId: string, cpId: string, body: Record<string, unknown>) =>
    apiPost<CounterpartyBankAccountDto>(`${base(wsId)}/${cpId}/accounts`, body),
  setPrimaryAccount: (wsId: string, cpId: string, accId: string) =>
    apiPost(`${base(wsId)}/${cpId}/accounts/${accId}/set-primary`),
  removeAccount: (wsId: string, cpId: string, accId: string) =>
    apiDelete(`${base(wsId)}/${cpId}/accounts/${accId}`),
};
