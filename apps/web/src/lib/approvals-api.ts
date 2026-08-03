import type {
  ApprovalActorLite,
  ApprovalDecisionKind,
  ApprovalMineDto,
  ApprovalRequestDto,
  InboxCountDto,
  InboxItemDto,
} from '@superapp/shared';
import { api } from './api';
import { approvalScopeParams, type ApprovalScope } from './queries';

// ============================================================
// core/approvals — «Ждут решения»
// ============================================================
// Стопка приходит уже собранной по РЕЕСТРУ источников: сегодня в ней согласования,
// завтра рядом встанут очереди отделов и приёмка задач — клиент не изменится, потому
// что элемент имеет общую форму.

export interface InboxPage {
  items: InboxItemDto[];
  actors: Record<string, ApprovalActorLite>;
  counts: Record<string, number>;
  total: number;
}

export async function fetchInbox(scope?: ApprovalScope, sourceKey?: string): Promise<InboxPage> {
  const { data } = await api.get('/approvals/inbox', {
    params: { ...approvalScopeParams(scope), ...(sourceKey ? { sourceKey } : {}) },
  });
  return data.data;
}

/** Лёгкий путь бейджа — одно число, без списков */
export async function fetchInboxCount(scope?: ApprovalScope): Promise<InboxCountDto> {
  const { data } = await api.get('/approvals/inbox/count', { params: approvalScopeParams(scope) });
  return data.data;
}

export async function fetchApproval(id: string): Promise<ApprovalRequestDto> {
  const { data } = await api.get(`/approvals/${id}`);
  return data.data;
}

export async function decideApproval(
  stepId: string,
  body: { decision: ApprovalDecisionKind; comment?: string },
): Promise<ApprovalRequestDto> {
  const { data } = await api.post(`/approvals/steps/${stepId}/decide`, body);
  return data.data;
}

export interface ApprovalMinePage {
  items: ApprovalMineDto[];
  actors: Record<string, ApprovalActorLite>;
  nextCursor: string | null;
}

export async function fetchMyApprovals(
  scope?: ApprovalScope,
  opts: { archived?: boolean; cursor?: string } = {},
): Promise<ApprovalMinePage> {
  const { data } = await api.get('/approvals/mine', {
    params: { ...approvalScopeParams(scope), ...opts },
  });
  return { items: data.data, actors: data.actors ?? {}, nextCursor: data.nextCursor ?? null };
}

export async function cancelApproval(id: string): Promise<void> {
  await api.post(`/approvals/${id}/cancel`);
}
