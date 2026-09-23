/**
 * Запись события журнала безопасности (core/audit) из СКРИПТА первого запуска — там, где
 * Nest и `AuditService` не поднимаются (bootstrap владельца Кабинета, публикация документов).
 * Те же правила, что у движка: ключ и детали — строго по реестру `@superapp/shared`
 * (Zod-схема `.strict()`), актор — система, клиент — `script`, видимость — из паспорта.
 * IP и UA у скрипта нет (запуск на сервере) — колонки пусты.
 */
const {
  AUDIT_REGISTRY,
  AUDIT_CATEGORY_CODE,
  AUDIT_SEVERITY_CODE,
  AUDIT_OUTCOME_CODE,
  AUDIT_ACTOR_KIND_CODE,
  AUDIT_CLIENT_CODE,
} = require('@superapp/shared');

/** Партиция текущего месяца — функцией владельца журнала (вне транзакции записи). */
async function ensureAuditPartition(prisma) {
  const month = new Date().toISOString().slice(0, 7) + '-01';
  await prisma.$queryRawUnsafe(`SELECT audit_ensure_partition($1::date)`, month);
}

/**
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {{ key: string, op?: string, target?: { type: string, id: string, label?: string }, subjectUserId?: string | null, workspaceId?: string | null, reasonCode?: string | null, details: object }} e
 */
async function recordScriptEvent(tx, e) {
  const def = AUDIT_REGISTRY[e.key];
  if (!def) throw new Error(`audit: unknown event key "${e.key}"`);
  const details = def.details.parse(e.details ?? {});
  const subject = e.subjectUserId ?? null;
  const workspace = e.workspaceId ?? null;
  return tx.securityEvent.create({
    data: {
      eventKey: e.key,
      op: e.op ?? null,
      category: AUDIT_CATEGORY_CODE[def.category],
      severity: AUDIT_SEVERITY_CODE[def.severity],
      outcome: AUDIT_OUTCOME_CODE.success,
      reasonCode: e.reasonCode ?? null,
      actorKind: AUDIT_ACTOR_KIND_CODE.system,
      subjectUserId: subject,
      workspaceId: workspace,
      targetType: e.target ? e.target.type : null,
      targetId: e.target ? e.target.id : null,
      targetLabel: e.target && e.target.type !== 'user' ? (e.target.label ?? null) : null,
      visSubject: def.visibility.subject && !!subject,
      visWorkspace: def.visibility.workspace && !!workspace,
      client: AUDIT_CLIENT_CODE.script,
      details,
    },
    select: { id: true, eventId: true },
  });
}

module.exports = { ensureAuditPartition, recordScriptEvent };
