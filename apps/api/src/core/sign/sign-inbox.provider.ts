import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  SIGN_LEVEL_LABELS,
  approvalSignatureKindOf,
  signRequestHref,
  type InboxItemDto,
  type InboxScope,
  type SignLevel,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { ApprovalsRegistry } from '../approvals/approvals.registry';

/**
 * СВОБОДНЫЕ подписи в общей стопке «Ждут решения» — второй источник реестра
 * (первый — заявки согласований). Свободная заявка (без шага маршрута) — это
 * внутренний подписант документа с контрагентом: до этой регистрации он узнавал
 * о своей подписи только из уведомления, а бейджа и стопки у неё не было.
 *
 * Шаговые заявки (approvalStepId NOT NULL) отфильтрованы: их шаг УЖЕ стоит в
 * стопке источником `approval`, и вторая строка была бы дублем той же работы.
 *
 * Кнопок решения нет намеренно (`actions: []`): подпись — модалка с
 * криптографией и SMS-кодом, из списка одним кликом её не поставить; «Открыть
 * целиком» ведёт на карточку подписания.
 */
@Injectable()
export class SignInboxProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly approvals: ApprovalsRegistry,
  ) {}

  onModuleInit(): void {
    this.approvals.registerSource('sign', {
      label: 'Подписи',
      count: (userId, scope) => this.db.signAct.count({ where: this.where(userId, scope) }),
      list: (userId, limit, scope) => this.list(userId, limit, scope),
    });
  }

  private where(userId: string, scope: InboxScope): Prisma.SignActWhereInput {
    return {
      status: 'pending',
      signerUserId: userId,
      request: {
        is: {
          status: 'pending',
          approvalStepId: null,
          // Протухшую, но ещё не закрытую кроном заявку не показываем: подпись
          // по ней всё равно отвергнется «срок истёк».
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          ...(scope.workspaceId
            ? { workspaceId: scope.workspaceId }
            : scope.personalOnly
              ? { workspaceId: null }
              : {}),
        },
      },
    };
  }

  private async list(userId: string, limit: number, scope: InboxScope): Promise<InboxItemDto[]> {
    const acts = await this.db.signAct.findMany({
      where: this.where(userId, scope),
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { request: true },
    });
    return acts.map((act): InboxItemDto => {
      const level = act.request.level as SignLevel;
      return {
        sourceKey: 'sign',
        id: act.id,
        title: act.request.refTitle,
        subtitle: `Подпишите документ · ${SIGN_LEVEL_LABELS[level].short}`,
        icon: act.request.refIcon ?? 'signature',
        href: signRequestHref(act.requestId, act.request.workspaceId),
        actions: [],
        requestedById: act.request.createdById,
        createdAt: act.request.createdAt.toISOString(),
        dueAt: act.request.expiresAt?.toISOString() ?? null,
        overdue: false,
        stepKind: 'signature',
        signRequirement: approvalSignatureKindOf(level),
      };
    });
  }
}
