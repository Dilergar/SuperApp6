import type {
  ApprovalDecisionKind,
  ApprovalMinePage,
  ApprovalRequestDto,
  InboxCountDto,
  InboxPageDto,
} from '@superapp/shared';
import { apiGet, apiPost } from './api';
import { approvalScopeParams, type ApprovalScope } from './queries';

// ============================================================
// core/approvals — «Ждут решения»
// ============================================================
// Стопка приходит уже собранной по РЕЕСТРУ источников: сегодня в ней согласования,
// завтра рядом встанут очереди отделов и приёмка задач — клиент не изменится, потому
// что элемент имеет общую форму.
//
// Локальных `InboxPage`/`ApprovalMinePage` здесь БОЛЬШЕ НЕТ: они были побайтовыми
// копиями shared-типов (у второго совпадало даже имя), из-за чего сами shared-типы
// числились мёртвыми. Оба родились в одном коммите с сервером — и разъехались бы
// при первой же правке.

export async function fetchInbox(scope?: ApprovalScope, sourceKey?: string): Promise<InboxPageDto> {
  return apiGet<InboxPageDto>('/approvals/inbox', {
    params: { ...approvalScopeParams(scope), ...(sourceKey ? { sourceKey } : {}) },
  });
}

/** Лёгкий путь бейджа — одно число, без списков */
export async function fetchInboxCount(scope?: ApprovalScope): Promise<InboxCountDto> {
  return apiGet<InboxCountDto>('/approvals/inbox/count', { params: approvalScopeParams(scope) });
}

export async function fetchApproval(id: string): Promise<ApprovalRequestDto> {
  return apiGet<ApprovalRequestDto>(`/approvals/${id}`);
}

export async function decideApproval(
  stepId: string,
  body: { decision: ApprovalDecisionKind; comment?: string },
): Promise<ApprovalRequestDto> {
  return apiPost<ApprovalRequestDto>(`/approvals/steps/${stepId}/decide`, body);
}

export async function fetchMyApprovals(
  scope?: ApprovalScope,
  opts: { archived?: boolean; cursor?: string } = {},
): Promise<ApprovalMinePage> {
  return apiGet<ApprovalMinePage>('/approvals/mine', {
    params: { ...approvalScopeParams(scope), ...opts },
  });
}

export async function cancelApproval(id: string): Promise<void> {
  await apiPost(`/approvals/${id}/cancel`);
}
