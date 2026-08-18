import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  COUNTERPARTY_KIND_LABELS,
  COUNTERPARTY_REF_TYPE,
  ORG_FORMS,
  counterpartyIdLabel,
  type CounterpartyKind,
  type RichCardPayload,
} from '@superapp/shared';
import { RichCardRegistry } from '../../core/rich-cards/rich-cards.registry';
import type { RichCardDeps } from '../../core/rich-cards/rich-card.types';

/**
 * Rich card «Контрагент» (Принцип 3): карточку справочника можно переслать в чат
 * («обсуди с бухгалтером, это наш новый поставщик») — название, БИН/ИИН,
 * подписант и «Открыть».
 *
 * Action-ключей нет НАМЕРЕННО (прецедент org_document/drive_node): доступ к
 * справочнику гейтится РОЛЬЮ команды, а не can() движка прав — кнопка-действие
 * врала бы на срок жизни кэша. Правки делаются на самой карточке сервиса.
 */
@Injectable()
export class CounterpartiesRichCardsProvider implements OnModuleInit {
  constructor(private readonly registry: RichCardRegistry) {}

  onModuleInit(): void {
    this.registry.registerRenderer(COUNTERPARTY_REF_TYPE, (deps, viewerId, refId) =>
      this.render(deps, viewerId, refId),
    );
  }

  private async render(deps: RichCardDeps, viewerId: string, refId: string): Promise<RichCardPayload | null> {
    const row = await deps.db.counterparty.findUnique({
      where: { id: refId },
      include: {
        contacts: { where: { archivedAt: null }, orderBy: { createdAt: 'asc' }, take: 1 },
      },
    });
    if (!row) return null;

    // Право = команда организации-владельца (тот же предикат, что у хроники)
    const membership = await deps.db.userRole.findFirst({
      where: {
        userId: viewerId,
        context: 'workspace',
        tenantId: row.workspaceId,
        isActive: true,
        role: { not: 'contractor' },
      },
      select: { id: true },
    });
    if (!membership) return null;

    const kind = row.kind as CounterpartyKind;
    const orgFormLabel = row.orgForm ? (ORG_FORMS.find((f) => f.value === row.orgForm)?.label ?? row.orgForm) : null;
    const contact = row.contacts[0] ?? null;

    return {
      kind: 'rich_card',
      cardType: COUNTERPARTY_REF_TYPE,
      ref: { type: COUNTERPARTY_REF_TYPE, id: refId },
      title: row.name,
      subtitle: row.legalName ?? orgFormLabel ?? COUNTERPARTY_KIND_LABELS[kind],
      icon: '🏢',
      imageUrl: null,
      fields: [
        ...(row.bin ? [{ label: counterpartyIdLabel(kind), value: row.bin }] : []),
        ...(contact
          ? [{ label: 'Подписант', value: [contact.name, contact.position].filter(Boolean).join(' · ') }]
          : []),
        ...(row.phone ? [{ label: 'Телефон', value: row.phone }] : []),
      ],
      progress: null,
      status: row.archivedAt ? 'В архиве' : (orgFormLabel ?? COUNTERPARTY_KIND_LABELS[kind]),
      actions: [],
      href: `/workspaces/${row.workspaceId}/counterparties?open=${row.id}`,
    };
  }
}
