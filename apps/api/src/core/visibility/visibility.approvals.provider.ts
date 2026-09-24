import { Injectable, OnModuleInit } from '@nestjs/common';
import { VISIBILITY_APPROVAL_REF_TYPE } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { ApprovalsRegistry } from '../approvals/approvals.registry';
import { VisibilityPolicyService, typeTitleKey } from './visibility.policy.service';

/**
 * «Четыре глаза» на ослабление строгих полей (решение грилла, R18): предмет заявки core/approvals —
 * черновик политики видимости организации. Автор — владелец/админ; одобряет ДРУГОЙ владелец или
 * админ (заявка приходит ему в «Ждут решения»). Отпечаток — правила черновика: правка после
 * заявки меняет токен, и одобрение к новым правилам не применяется. Публикует — ведущий
 * (этот модуль) по исходу, от имени автора заявки.
 */
@Injectable()
export class VisibilityApprovalsProvider implements OnModuleInit {
  constructor(
    private readonly registry: ApprovalsRegistry,
    private readonly policies: VisibilityPolicyService,
    private readonly db: DatabaseService,
    private readonly i18n: I18nService,
  ) {}

  onModuleInit(): void {
    this.registry.register(VISIBILITY_APPROVAL_REF_TYPE, {
      describeForCreate: (userId, refId) => this.policies.describePublishApproval(userId, refId),
      // Видят заявку владельцы и админы организации черновика (участники маршрута — всегда)
      canView: async (userId, refId) => {
        const draft = await this.db.visibilityPolicy.findUnique({ where: { id: refId }, select: { ownerType: true, ownerId: true } });
        if (!draft || draft.ownerType !== 'workspace') return false;
        const role = await this.policies.roleIn(userId, draft.ownerId);
        return role === 'owner' || role === 'admin';
      },
      describeRef: async (refId) => {
        const draft = await this.db.visibilityPolicy.findUnique({ where: { id: refId }, select: { ownerType: true, ownerId: true, recordType: true } });
        if (!draft || draft.ownerType !== 'workspace') return null;
        return {
          title: this.i18n.translate('visibility.approval.title', { type: this.i18n.translate(typeTitleKey(draft.recordType)) }),
          icon: 'eye',
          href: `/workspaces/${encodeURIComponent(draft.ownerId)}/profile/visibility`,
        };
      },
    });
    this.registry.registerOrigin(VISIBILITY_APPROVAL_REF_TYPE, {
      onResolved: (originRef, outcome) => this.policies.onPublishApprovalResolved(originRef, outcome),
    });
  }
}
