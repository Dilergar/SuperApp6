import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  APPROVAL_DECISIONS_NEEDING_COMMENT,
  APPROVAL_KIND_DECISIONS,
  approvalDecideSchema,
  type ApprovalStepKind,
  type RichCardPayload,
} from '@superapp/shared';
import { RichCardRegistry } from '../rich-cards/rich-cards.registry';
import { I18nService } from '../../shared/i18n/i18n.service';
import { ApprovalsService } from './approvals.service';

/** Тон чипа статуса заявки — смысл, а не цвет (веб рисует его своими токенами). */
const REQUEST_STATUS_TONE: Record<string, 'accent' | 'success' | 'danger' | 'warning' | 'neutral'> = {
  pending: 'accent',
  approved: 'success',
  rejected: 'danger',
  returned: 'warning',
  cancelled: 'neutral',
};

/** Ключ действия → исход. Один источник для регистрации и для кнопок карточки. */
const ACTION_TO_DECISION = {
  'approval.approve': 'approved',
  'approval.reject': 'rejected',
  'approval.return': 'returned',
} as const;

/**
 * Согласование прямо из чата: заявку можно кинуть рич-карточкой, и решение
 * принимается кнопкой на ней, без перехода в сервис.
 *
 * Это и есть проверка универсальности движка: карточка не знает, чем является
 * предмет заявки (документ, счёт, задача) — она рисует маршрут и кнопки того шага,
 * который ждёт ЭТОГО зрителя.
 */
@Injectable()
export class ApprovalsRichCardProvider implements OnModuleInit {
  constructor(
    private readonly cards: RichCardRegistry,
    private readonly approvals: ApprovalsService,
    private readonly i18n: I18nService,
  ) {}

  onModuleInit(): void {
    this.cards.registerRenderer('approval_request', async (_deps, viewerId, refId) => this.render(viewerId, refId));

    for (const [actionKey, decision] of Object.entries(ACTION_TO_DECISION)) {
      this.cards.registerAction(actionKey as keyof typeof ACTION_TO_DECISION, {
        // Способности движка прав здесь нет намеренно: право решать — это адресность
        // ШАГА, и она проверяется в сервисе по снимку. Отдельная capability лишь
        // создала бы вторую точку правды.
        handler: async (userId, _refId, payload) => {
          const stepId = String(payload?.stepId ?? '');
          if (!stepId) throw new Error('The decision step is not specified');
          // Тело рич-карточки — свободный JSON (`z.record(z.unknown())` у общего
          // эндпоинта), поэтому причину разбираем ТОЙ ЖЕ схемой, что и обычный путь
          // решения: иначе мимо неё проезжают и потолок длины, и запрет на «<>».
          const dto = approvalDecideSchema.parse({
            decision,
            ...(typeof payload?.comment === 'string' && payload.comment.trim()
              ? { comment: payload.comment }
              : {}),
          });
          await this.approvals.decide(userId, stepId, dto);
        },
      });
    }
  }

  private async render(viewerId: string, requestId: string): Promise<RichCardPayload | null> {
    let request;
    try {
      request = await this.approvals.get(viewerId, requestId);
    } catch {
      return null; // не видит заявку или её нет — карточка просто не рисуется
    }

    const groups = [...new Set(request.steps.map((s) => s.order))];
    const myStep = request.myStepId ? request.steps.find((s) => s.id === request.myStepId) : null;

    // Ни одной строки для человека в файле: карточка собирается при ЧТЕНИИ в
    // языке зрителя — её видят участники маршрута с разными языками.
    const t = this.i18n.t;
    const fields = request.steps.map((step) => {
      const decided = step.decisions[step.decisions.length - 1];
      const who = decided ? (request.actors[decided.userId]?.firstName ?? t('approvals.someone')) : null;
      return {
        label: `${groups.indexOf(step.order) + 1}. ${step.title}`,
        value:
          step.status === 'active'
            ? `${t(`approvals.kind.${step.kind}.waiting`)}${step.overdue ? t('approvals.overdueSuffix') : ''}`
            : decided && who
              ? `${who} — ${
                  decided.decision === 'approved'
                    ? t(`approvals.kind.${step.kind}.done`)
                    : t(`approvals.decisionVerb.${decided.decision}`)
                }`
              : step.status === 'skipped'
                ? t('approvals.stepStatus.skippedLower')
                : t('approvals.stepStatus.waitingLower'),
      };
    });

    const actions: RichCardPayload['actions'] = [];
    if (myStep) {
      const allowed = APPROVAL_KIND_DECISIONS[myStep.kind as ApprovalStepKind] ?? [];
      for (const decision of allowed) {
        const entry = Object.entries(ACTION_TO_DECISION).find(([, d]) => d === decision);
        if (!entry) continue;
        actions.push({
          key: entry[0] as RichCardPayload['actions'][number]['key'],
          label:
            decision === 'approved'
              ? t(`approvals.kind.${myStep.kind}.action`)
              : t(`approvals.decision.${decision}`),
          style: decision === 'approved' ? 'primary' : decision === 'rejected' ? 'danger' : 'default',
          // Отказ и возврат без причины сервер не принимает, поэтому карточка обязана
          // спросить её ДО отправки: без этого признака кнопка «Отклонить» в чате
          // всегда упиралась в «Укажите причину», а ввести причину было негде.
          commentRequired: APPROVAL_DECISIONS_NEEDING_COMMENT.includes(decision),
          commentPlaceholder: t('approvals.commentPlaceholder'),
          // Шаг едет в payload: карточка привязана к ЗАЯВКЕ, а решают всегда по шагу,
          // и у зрителя это может быть не первый и не единственный шаг маршрута.
          payload: { stepId: myStep.id },
        });
      }
    }

    return {
      kind: 'rich_card',
      cardType: 'approval_request',
      ref: { type: 'approval_request', id: request.id },
      title: request.ref?.title ?? request.refTitle,
      subtitle: myStep ? myStep.title : null,
      icon: request.refIcon ?? '🖋️',
      fields,
      status: t(`approvals.status.${request.status}`),
      statusTone: REQUEST_STATUS_TONE[request.status] ?? 'neutral',
      actions,
      href: request.ref?.href ?? null,
    };
  }
}
