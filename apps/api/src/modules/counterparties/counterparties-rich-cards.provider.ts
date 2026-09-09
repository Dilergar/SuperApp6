import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  COUNTERPARTY_REF_TYPE,
  ORG_FORMS,
  counterpartyIdKey,
  type CounterpartyKind,
  type RichCardPayload,
} from '@superapp/shared';
import { RichCardRegistry } from '../../core/rich-cards/rich-cards.registry';
import { I18nService } from '../../shared/i18n/i18n.service';
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
  constructor(
    private readonly registry: RichCardRegistry,
    private readonly i18n: I18nService,
  ) {}

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

    const t = (key: string) => this.i18n.translate(key);
    const kind = row.kind as CounterpartyKind;
    // Карточка читается в языке ЗАПРОСА: и вид, и орг-форма — слова каталога
    const orgFormLabel =
      row.orgForm && ORG_FORMS.includes(row.orgForm as (typeof ORG_FORMS)[number])
        ? t(`workspaces.orgForm.${row.orgForm}`)
        : row.orgForm;
    const kindLabel = t(`counterparties.kind.${kind}`);
    const contact = row.contacts[0] ?? null;

    return {
      kind: 'rich_card',
      cardType: COUNTERPARTY_REF_TYPE,
      ref: { type: COUNTERPARTY_REF_TYPE, id: refId },
      title: row.name,
      subtitle: row.legalName ?? orgFormLabel ?? kindLabel,
      icon: '🏢',
      imageUrl: null,
      fields: [
        ...(row.bin ? [{ label: t(`counterparties.idLabel.${counterpartyIdKey(kind)}`), value: row.bin }] : []),
        ...(contact
          ? [
              {
                label: t('counterparties.card.signer'),
                value: [contact.name, contact.position].filter(Boolean).join(' · '),
              },
            ]
          : []),
        ...(row.phone ? [{ label: t('counterparties.card.phone'), value: row.phone }] : []),
      ],
      progress: null,
      status: row.archivedAt ? t('counterparties.card.archived') : (orgFormLabel ?? kindLabel),
      actions: [],
      href: `/workspaces/${row.workspaceId}/counterparties?open=${row.id}`,
    };
  }
}
