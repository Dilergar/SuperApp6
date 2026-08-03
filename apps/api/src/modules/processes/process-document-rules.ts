import type { ProcessDocument, ProcessValidationIssue } from '@superapp/shared';

// ============================================================
// Правила предметной области для маршрутов документов.
//
// ЧЬИ ОНИ: платформенные. Проверки пишем и обновляем мы — меняется закон, меняется
// у всех сразу. Кадровая служба клиента не обязана держать ТК РК в голове и вбивать
// его в настройки: ровно за это сервису и платят.
//
// НАСКОЛЬКО ЖЁСТКИЕ: это `warning`, а не `error`. Публикацию они не блокируют —
// у компании может быть законная причина сделать иначе, а сервис, который в такой
// момент говорит «нельзя», выключают целиком. Но предупреждение принимается ЯВНО
// («Понимаю, публикую»), и в журнал организации попадает, кто и когда взял риск.
//
// ГДЕ ГРАНИЦА: правило смотрит ТОЛЬКО на состав маршрута — какие ноды есть и в каком
// порядке. Оно не читает содержимое документа и не пытается быть юристом.
// ============================================================

/** Ключ правила уходит в issue и в отметку «принято к сведению» */
export const HR_RULES = {
  orderRequired: 'hr.order_required',
  acknowledgeRequired: 'hr.acknowledge_required',
  registerRequired: 'hr.register_required',
  signatureRequired: 'hr.signature_required',
  personalFileRequired: 'hr.personal_file_required',
} as const;

type NodeKindOf = (node: { type: string; config: Record<string, unknown> }) => string | null;

/** Вид решения у человеческой ноды: с ним и работают кадровые правила */
const decisionKind: NodeKindOf = (n) =>
  n.type === 'human.approval' ? String(n.config.kind ?? 'approval') : null;

/**
 * Проверки кадрового маршрута (профиль `documents.hr`).
 *
 * Вызывается компилятором после структурной валидации: если маршрут вообще не
 * собирается, ругаться на кадровый учёт бессмысленно и только шумит.
 */
export function checkHrRoute(doc: ProcessDocument): ProcessValidationIssue[] {
  const issues: ProcessValidationIssue[] = [];
  const kinds = doc.nodes.map(decisionKind).filter((k): k is string => !!k);

  const has = (type: string) => doc.nodes.some((n) => n.type === type);
  const warn = (ruleKey: string, message: string): void => {
    issues.push({ severity: 'warning', ruleKey, message });
  };

  // 1. Приказ. Заявление сотрудника — основание, но кадровым документом является
  //    ПРИКАЗ; без него в личном деле остаётся бумага, которая ничего не решает.
  if (!has('doc.generate')) {
    warn(
      HR_RULES.orderRequired,
      'По кадровому учёту РК основанием является приказ: добавьте «Сформировать документ», иначе в деле останется только заявление',
    );
  }

  // 2. Подпись руководителя. Неподписанный приказ силы не имеет.
  if (!kinds.includes('signature')) {
    warn(
      HR_RULES.signatureRequired,
      'Приказ должен быть подписан руководителем: добавьте шаг «Решение человека» с видом «Подписать»',
    );
  }

  // 3. Ознакомление. По ТК РК работника знакомят с приказом под роспись —
  //    именно этого пункта чаще всего не хватает при трудовой проверке.
  if (!kinds.includes('acknowledgement')) {
    warn(
      HR_RULES.acknowledgeRequired,
      'Сотрудника нужно ознакомить с приказом: добавьте шаг «Решение человека» с видом «Ознакомиться»',
    );
  }

  // 4. Регистрация номера. Без номера документа нет в книге регистрации.
  if (!has('doc.register')) {
    warn(HR_RULES.registerRequired, 'Приказу нужен номер: добавьте шаг «Регистрация», иначе документ не попадёт в книгу регистрации');
  }

  // 5. Личное дело. Документ, который никуда не подшит, при проверке не найти.
  if (!has('doc.file')) {
    warn(HR_RULES.personalFileRequired, 'Подписанный документ стоит подшить в личное дело: добавьте шаг «Подшить в дело»');
  }

  return issues;
}

/** Правила по профилю редактора. Новая область — одна строка здесь. */
export function checkSurfaceRules(surface: string, doc: ProcessDocument): ProcessValidationIssue[] {
  if (surface === 'documents.hr') return checkHrRoute(doc);
  return [];
}
