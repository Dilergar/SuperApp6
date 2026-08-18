import { Injectable, OnModuleInit } from '@nestjs/common';
import { DOC_STATUS_LABELS, ORG_DOCUMENT_REF_TYPE, type DocStatus, type RichCardPayload } from '@superapp/shared';
import { RichCardRegistry } from '../../core/rich-cards/rich-cards.registry';
import type { RichCardDeps } from '../../core/rich-cards/rich-card.types';
import { DocumentsService } from './documents.service';

/**
 * Rich card «Документ организации» (Принцип 3): документ пересылается в чат
 * карточкой — название, номер, вид, статус и «Открыть».
 *
 * Action-ключей нет НАМЕРЕННО (прецедент Диска): права документов считает
 * собственный предикат сервиса (видимость вида, роль, участие в решении), а не
 * `can()` движка прав — кнопка-действие в чате врала бы на срок жизни кэша.
 * Решения и подпись собираются своими экранами.
 */
@Injectable()
export class DocumentsRichCardsProvider implements OnModuleInit {
  constructor(
    private readonly registry: RichCardRegistry,
    private readonly documents: DocumentsService,
  ) {}

  onModuleInit(): void {
    this.registry.registerRenderer(ORG_DOCUMENT_REF_TYPE, (deps, viewerId, refId) =>
      this.render(deps, viewerId, refId),
    );
  }

  private async render(deps: RichCardDeps, viewerId: string, refId: string): Promise<RichCardPayload | null> {
    const doc = await deps.db.orgDocument.findUnique({
      where: { id: refId },
      include: { docType: { select: { name: true, category: true } } },
    });
    if (!doc) return null;
    // Право — тем же предикатом, что и открытие карточки (одна планка)
    const visible = await this.documents
      .get(viewerId, refId)
      .then(() => true)
      .catch(() => false);
    if (!visible) return null;

    const counterparty = doc.counterpartyId
      ? await deps.db.counterparty.findUnique({ where: { id: doc.counterpartyId }, select: { name: true } })
      : null;

    return {
      kind: 'rich_card',
      cardType: ORG_DOCUMENT_REF_TYPE,
      ref: { type: ORG_DOCUMENT_REF_TYPE, id: refId },
      title: doc.number ? `${doc.title} № ${doc.number}` : doc.title,
      subtitle: doc.docType.name,
      icon: '📄',
      imageUrl: null,
      fields: [
        ...(counterparty ? [{ label: 'Контрагент', value: counterparty.name }] : []),
        ...(doc.signedAt
          ? [{ label: 'Подписан', value: doc.signedAt.toLocaleDateString('ru-RU') }]
          : []),
      ],
      progress: null,
      status: DOC_STATUS_LABELS[doc.status as DocStatus] ?? doc.status,
      actions: [],
      href: `/workspaces/${doc.workspaceId}/documents/${doc.id}`,
    };
  }
}
