import { Injectable, OnModuleInit } from '@nestjs/common';
import { DRIVE_NODE_REF_TYPE, type RichCardPayload } from '@superapp/shared';
import { RichCardRegistry } from '../../core/rich-cards/rich-cards.registry';
import type { RichCardDeps } from '../../core/rich-cards/rich-card.types';
import { DriveService } from './drive.service';

const KB = 1024;

/**
 * Rich card «Объект Диска» (Принцип 3): название, тип, размер и ссылка «Открыть».
 *
 * Action-ключей нет НАМЕРЕННО. Движок перепроверяет способность кнопки через
 * `AccessService.can()`, а у типов Диска пустой фанаут эпох кэша — права считает
 * собственный предикат по живым tuples. Кнопка-действие показывала бы ответ,
 * устаревший на срок жизни кэша; ссылка ведёт на страницу, где право проверяется
 * заново, и это честно.
 */
@Injectable()
export class DriveRichCardsProvider implements OnModuleInit {
  constructor(
    private readonly registry: RichCardRegistry,
    private readonly drive: DriveService,
  ) {}

  onModuleInit(): void {
    this.registry.registerRenderer(DRIVE_NODE_REF_TYPE, (deps, viewerId, refId) =>
      this.render(deps, viewerId, refId),
    );
  }

  private async render(deps: RichCardDeps, viewerId: string, refId: string): Promise<RichCardPayload | null> {
    const node = await deps.db.driveNode.findUnique({ where: { id: refId } });
    if (!node || node.trashedAt) return null;

    // Права — через свой предикат, не через can(): у Диска наследование по дереву,
    // которого движок не знает.
    const access = await this.drive.nodeAccessOf(viewerId, node);
    if (!access) return null;

    const isFolder = node.kind === 'folder';
    const bytes = node.subtreeBytes === null ? null : Number(node.subtreeBytes);
    const fields = [
      { label: 'Тип', value: isFolder ? 'Папка' : 'Файл' },
      ...(bytes !== null ? [{ label: 'Размер', value: humanSize(bytes) }] : []),
      ...(isFolder && node.subtreeFiles !== null
        ? [{ label: 'Файлов внутри', value: String(node.subtreeFiles) }]
        : []),
    ];

    return {
      kind: 'rich_card',
      cardType: DRIVE_NODE_REF_TYPE,
      ref: { type: DRIVE_NODE_REF_TYPE, id: refId },
      title: node.name,
      subtitle: isFolder ? 'Папка на Диске' : 'Файл на Диске',
      icon: isFolder ? '📁' : '📄',
      imageUrl: null,
      fields,
      progress: null,
      status: null,
      actions: [],
      href: `/drive/n/${refId}`,
    };
  }
}

function humanSize(bytes: number): string {
  if (bytes < KB) return `${bytes} Б`;
  if (bytes < KB * KB) return `${(bytes / KB).toFixed(1)} КБ`;
  if (bytes < KB ** 3) return `${(bytes / KB ** 2).toFixed(1)} МБ`;
  return `${(bytes / KB ** 3).toFixed(2)} ГБ`;
}
