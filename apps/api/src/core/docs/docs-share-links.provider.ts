import { Injectable, OnModuleInit } from '@nestjs/common';
import { type ShareDocGuestView } from '@superapp/shared';
import { AccessService } from '../access/access.service';
import { FilesService } from '../files/files.service';
import {
  ShareLinksRegistry,
  type ShareLinkGuestContext,
  type ShareLinkProvider,
  type ShareRefContext,
} from '../share-links/share-links.registry';
import { DatabaseService } from '../../shared/database/database.service';
import { DocsRenditionService } from './docs-rendition.service';

/** refType документа в движке ссылок — та же строка, что у резолверов файлов и хроники */
export const DOCUMENT_REF_TYPE = 'document';

/**
 * Документы в движке гостевых ссылок (core/share-links).
 *
 * Два решения продукта, оба несущие:
 *
 * 1. Ссылку наружу создаёт ТОЛЬКО ВЛАДЕЛЕЦ документа (тот же предикат document.manage,
 *    которым гейтятся переименование и закрытие). Право правки часто приходит «от
 *    места» — например, у всех участников задачи; если бы его хватало, любой участник
 *    мог бы вынести чужой файл во внешний мир, а право «от места» начало бы действовать
 *    ЗА пределами этого места.
 *
 * 2. Гость получает только PDF-отпечаток текущего содержимого — читаемую копию, а не
 *    исходник и не редактор. Тот же отпечаток позже подписывает ЭДО, поэтому «что
 *    видел человек» и «что он подписал» — один и тот же байт-в-байт документ.
 */
@Injectable()
export class DocsShareLinksProvider implements ShareLinkProvider, OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly files: FilesService,
    private readonly rendition: DocsRenditionService,
    private readonly registry: ShareLinksRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(DOCUMENT_REF_TYPE, this);
  }

  async authorizeManage(userId: string, documentId: string): Promise<ShareRefContext | null> {
    const doc = await this.db.document.findUnique({ where: { id: documentId } });
    if (!doc || doc.deletedAt || doc.status !== 'active') return null;
    const isOwner = await this.access.can({ type: 'user', id: userId }, 'document.manage', doc.id);
    if (!isOwner) return null;
    return {
      ownerType: doc.ownerType === 'workspace' ? 'workspace' : 'user',
      ownerId: doc.ownerId,
      workspaceId: doc.ownerType === 'workspace' ? doc.ownerId : null,
      title: doc.title,
      icon: 'file-text',
    };
  }

  async resolveGuestView(link: ShareLinkGuestContext): Promise<ShareDocGuestView | null> {
    const doc = await this.db.document.findUnique({ where: { id: link.refId } });
    if (!doc || doc.deletedAt || doc.status !== 'active') return null;

    const base = {
      kind: 'document' as const,
      title: doc.title,
      ext: doc.ext,
      updatedAt: (doc.lastSavedAt ?? doc.updatedAt).toISOString(),
      allowDownload: link.allowDownload,
    };

    // Под одним try обе половины намеренно. Раньше ловилась только конвертация, и
    // выдача ссылки бросала наружу 403 движка файлов («Файл помечен как заражённый»):
    // машинного кода в details у него нет, поэтому гостевая страница показывала общее
    // «попробуйте обновить через минуту» — обещание, которое не сбудется, — и заодно
    // подтверждала постороннему человеку, что у нас там заражённый файл. Гостю во всех
    // случаях нужен ОДИН честный ответ «сейчас показать не можем».
    try {
      // request() сам сверяет отпечаток с текущим содержимым по sha и идемпотентен:
      // пока документ не менялся, повторные показы страницы работы не плодят, а после
      // правки отпечаток пересчитывается — гость никогда не видит устаревшую копию.
      const { ready } = await this.rendition.request(doc.id, 'pdf');
      if (!ready) return { ...base, state: 'preparing', pdf: null };

      // Системный контракт движка файлов: доступ проверил вызывающий — здесь это сделал
      // токен ссылки. Обычный getDownloadUrl тут неприменим, у гостя нет userId.
      const url = await this.files.buildSystemDownloadUrl(doc.fileId, 'pdf');
      return { ...base, state: 'ready', pdf: { url: url.url, expiresAt: url.expiresAt } };
    } catch {
      // Редактор не подключён, файл заражён, отпечаток пропал из хранилища — всё это
      // для гостя одно и то же: «не показать». Страница предложит зайти позже.
      return { ...base, state: 'unavailable', pdf: null };
    }
  }

  async describeRef(documentId: string): Promise<{ title: string; icon?: string } | null> {
    const doc = await this.db.document.findUnique({
      where: { id: documentId },
      select: { title: true },
    });
    return doc ? { title: doc.title, icon: 'file-text' } : null;
  }
}
