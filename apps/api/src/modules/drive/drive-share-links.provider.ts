import { ForbiddenException, Injectable, OnModuleInit } from '@nestjs/common';
import {
  DRIVE_NODE_REF_TYPE,
  type FileKind,
  type ShareDriveGuestView,
  type ShareDriveNodeDto,
  type ShareGuestFile,
} from '@superapp/shared';
import { FilesService } from '../../core/files/files.service';
import {
  ShareLinksRegistry,
  type ShareLinkGuestContext,
  type ShareLinkProvider,
  type ShareRefContext,
} from '../../core/share-links/share-links.registry';
import { DatabaseService } from '../../shared/database/database.service';
import { DriveService, type NodeRow } from './drive.service';

/**
 * Диск в движке гостевых ссылок (core/share-links) — первый потребитель.
 *
 * Планка «поделиться наружу» = планка внутреннего шеринга: управляющий узлом. На диске
 * организации это значит manager+ (корень раздаёт им роль управляющего), то есть одна
 * модель в голове у человека: кто раздаёт доступ внутри, тот раздаёт и наружу.
 *
 * Корзина ссылку ПРИОСТАНАВЛИВАЕТ, а не убивает (модель Google Drive): резолвер вернёт
 * null → гость увидит «объект недоступен», а восстановление вернёт ссылку к жизни.
 * Окончательное удаление отзывает ссылки насовсем — это делает purge в DriveTreeService.
 */
@Injectable()
export class DriveShareLinksProvider implements ShareLinkProvider, OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly drive: DriveService,
    private readonly files: FilesService,
    private readonly registry: ShareLinksRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(DRIVE_NODE_REF_TYPE, this);
  }

  async authorizeManage(userId: string, nodeId: string): Promise<ShareRefContext | null> {
    let node: NodeRow;
    try {
      ({ node } = await this.drive.requireNode(userId, nodeId, 'manager'));
    } catch {
      // «Нет права» и «нет объекта» — РАЗНЫЕ ответы. Постороннему по-прежнему 404:
      // подтверждать существование чужого объекта нельзя. Но тому, кто узел ВИДИТ в
      // своём же списке, «Объект не найден» — прямая ложь; на диске организации корень
      // раздаёт роль «правит» каждому сотруднику, и этот текст получала вся команда.
      const visible = await this.drive
        .requireNode(userId, nodeId, 'viewer')
        .then(() => true)
        .catch(() => false);
      if (!visible) return null;
      throw new ForbiddenException(
        'Раздавать доступ по ссылке наружу может тот, кто управляет доступом к объекту',
      );
    }
    // requireNode проверяет ПРАВА, но не состояние: узел в корзине права не теряет
    // (иначе его нельзя было бы восстановить). Раздавать наружу удалённое — нельзя.
    if (node.trashedAt) return null;
    const space = await this.drive.loadSpace(node.spaceId);
    return {
      ownerType: space.ownerType === 'workspace' ? 'workspace' : 'user',
      ownerId: space.ownerId,
      workspaceId: space.ownerType === 'workspace' ? space.ownerId : null,
      title: node.name,
      icon: node.kind === 'folder' ? 'folder' : 'file',
    };
  }

  async resolveGuestView(link: ShareLinkGuestContext): Promise<ShareDriveGuestView | null> {
    const node = await this.db.driveNode.findUnique({ where: { id: link.refId } });
    if (!node || node.trashedAt) return null;

    if (node.kind === 'folder') {
      return { kind: 'folder', rootId: node.id, name: node.name, allowDownload: link.allowDownload };
    }
    if (!node.fileId) return null;
    const file = (await this.guestFiles([node.fileId], link.allowDownload)).get(node.fileId);
    if (!file) return null;
    return {
      kind: 'file',
      rootId: node.id,
      name: node.name,
      allowDownload: link.allowDownload,
      file,
    };
  }

  async describeRef(nodeId: string): Promise<{ title: string; icon?: string } | null> {
    const node = await this.db.driveNode.findUnique({
      where: { id: nodeId },
      select: { name: true, kind: true },
    });
    return node ? { title: node.name, icon: node.kind === 'folder' ? 'folder' : 'file' } : null;
  }

  // ============================================================
  // Сериализация для гостя
  // ============================================================

  /**
   * Строки листинга для гостя. Своя сборка, а НЕ serializeNodes: тот требует userId
   * (звёзды «избранное»), отдаёт внутренние поля узла (владелец, системный ключ,
   * пространство) и вообще рассчитан на своего человека, а не на постороннего.
   */
  async guestNodes(rows: NodeRow[], allowDownload: boolean): Promise<ShareDriveNodeDto[]> {
    const files = await this.guestFiles(
      rows.map((r) => r.fileId).filter((id): id is string => !!id),
      allowDownload,
    );
    return rows.map((row) => {
      const file = row.fileId ? (files.get(row.fileId) ?? null) : null;
      return {
        id: row.id,
        kind: row.kind === 'folder' ? 'folder' : 'file',
        name: row.name,
        // У файла размер точный, у папки — объём поддерева (null = ещё не посчитан).
        size: row.kind === 'folder' ? (row.subtreeBytes === null ? null : Number(row.subtreeBytes)) : (file?.size ?? null),
        updatedAt: row.updatedAt.toISOString(),
        file,
      };
    });
  }

  /**
   * Ссылки на байты для гостя. buildAttachmentViews — системный контракт движка
   * («доступ проверил вызывающий»), и здесь его проверил токен ссылки. Заражённые и
   * недогруженные файлы движок в выдачу не кладёт вовсе — гость увидит «недоступен».
   *
   * При выключенном скачивании ОРИГИНАЛ не отдаётся вообще: остаётся уменьшенная копия
   * (у картинки) или постер (у видео). Это не защита от копирования — байты превью всё
   * равно у гостя в браузере, — но оригинал 4000px за собой он уже не унесёт, и это
   * ровно то, что в этой настройке обещают Google Drive и Dropbox.
   */
  private async guestFiles(
    fileIds: string[],
    allowDownload: boolean,
  ): Promise<Map<string, ShareGuestFile>> {
    const out = new Map<string, ShareGuestFile>();
    if (!fileIds.length) return out;

    const [meta, views] = await Promise.all([
      this.db.fileObject.findMany({
        where: { id: { in: fileIds } },
        select: { id: true, name: true, mime: true, kind: true, size: true, meta: true },
      }),
      this.files.buildAttachmentViews(fileIds),
    ]);
    for (const raw of meta) {
      const view = views.get(raw.id);
      const m = (raw.meta as Record<string, unknown> | null) ?? {};
      // Превью — то, что можно показать, НЕ отдавая оригинал: средняя копия картинки,
      // постер видео, на худой конец миниатюра.
      const preview = view ? (view.mediumUrl ?? view.posterUrl ?? view.thumbUrl) : null;
      out.set(raw.id, {
        fileId: raw.id,
        name: raw.name,
        mime: raw.mime,
        kind: raw.kind as FileKind,
        size: Number(raw.size),
        // Ссылки нет — файл ещё не готов или помечен антивирусом: страница честно
        // скажет «файл недоступен» вместо битой кнопки «Скачать».
        available: !!view,
        url: allowDownload ? (view?.url ?? null) : null,
        previewUrl: preview,
        thumbUrl: view?.thumbUrl ?? null,
        posterUrl: view?.posterUrl ?? null,
        urlExpiresAt: view?.urlExpiresAt ?? null,
        width: view?.width ?? null,
        height: view?.height ?? null,
        durationMs: view?.durationMs ?? null,
        waveform: view?.waveform ?? null,
        thumbhash: typeof m.thumbhash === 'string' ? m.thumbhash : null,
      });
    }
    return out;
  }
}
