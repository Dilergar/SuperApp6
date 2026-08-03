import { Injectable, OnModuleInit } from '@nestjs/common';
import { ORG_DOCUMENT_REF_TYPE, type SearchSourceType } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { ApprovalsRegistry } from '../../core/approvals/approvals.registry';
import { ChatterRefRegistry } from '../../core/chatter/chatter-ref.registry';
import { FilesRefRegistry } from '../../core/files/files-ref.registry';
import { SearchRegistry } from '../../core/search/search.registry';
import { SearchProjectionService } from '../../core/search/search-projection.service';
import { TemplateFieldRegistry } from '../../core/templates/template-field.registry';
import type { SearchProviderOpts, SearchProviderResult } from '../../core/search/search.types';
import { DocumentsService } from './documents.service';

/**
 * Регистрации сервиса «Документы» во всех движках — одним файлом.
 *
 * Направление знания всюду одно: движок не знает про Документы, Документы
 * регистрируются в нём сами (паттерн FilesRefRegistry / ShareLinksRegistry).
 */
@Injectable()
export class DocumentsRegistriesProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly documents: DocumentsService,
    private readonly approvals: ApprovalsRegistry,
    private readonly chatterRegistry: ChatterRefRegistry,
    private readonly filesRegistry: FilesRefRegistry,
    private readonly searchRegistry: SearchRegistry,
    private readonly searchProjection: SearchProjectionService,
    private readonly templateFields: TemplateFieldRegistry,
  ) {}

  onModuleInit(): void {
    // ---- Согласования: документ как ПРЕДМЕТ решения ----
    // Право «отправить этот документ на решение» проверяем ЗДЕСЬ: через этот метод
    // проходит любое заведение заявки, и он же — единственное место, где движок может
    // спросить у нас про наши правила. Раньше проверки не было ни здесь, ни в движке.
    this.approvals.register(ORG_DOCUMENT_REF_TYPE, {
      describeForCreate: async (userId, refId) => {
        const doc = await this.db.orgDocument.findUnique({ where: { id: refId } });
        if (!doc) return null;
        if (!(await this.documents.canRequestApproval(userId, doc))) return null;
        return {
          title: doc.number ? `${doc.title} № ${doc.number}` : doc.title,
          icon: '📄',
          workspaceId: doc.workspaceId,
          // Отпечаток ТОГО содержимого, которое видит решающий: без него подпись не
          // привязана ни к какой версии файла (движок пишет его в каждое решение).
          contentSha256: await this.documents.contentFingerprint(doc),
        };
      },
      canView: (userId, refId) =>
        this.documents
          .get(userId, refId)
          .then(() => true)
          .catch(() => false),
      describeRef: async (refId) => {
        const doc = await this.db.orgDocument.findUnique({ where: { id: refId } });
        if (!doc) return null;
        return {
          title: doc.number ? `${doc.title} № ${doc.number}` : doc.title,
          icon: '📄',
          href: `/workspaces/${doc.workspaceId}/documents/${doc.id}`,
        };
      },
    });

    // ---- Файлы карточки: доступ наследуется ОТ ДОКУМЕНТА ----
    // Без этой регистрации файл документа принадлежал организации и попадал под общее
    // правило движка «файл организации виден всей команде»: вид «только управляющим»
    // закрывал реестр, но не байты — .docx и его PDF скачивал любой, кто узнал fileId.
    this.filesRegistry.register(
      ORG_DOCUMENT_REF_TYPE,
      {
        canView: (viewerId, refId) =>
          this.documents
            .get(viewerId, refId)
            .then(() => true)
            .catch(() => false),
        // Прикладывать и менять содержимое — только пока документ правится его автором
        // (после отправки на маршрут правку держит `locked` в core/docs).
        canAttach: (userId, refId) => this.documents.canEditFile(userId, refId),
        canEditContent: (userId, refId) => this.documents.canEditFile(userId, refId),
      },
      { scopedPlace: true },
    );

    // ---- Хроника карточки: видит тот, кто видит документ ----
    this.chatterRegistry.register(ORG_DOCUMENT_REF_TYPE, {
      canView: (viewerId, refId) =>
        this.documents
          .get(viewerId, refId)
          .then(() => true)
          .catch(() => false),
    });

    // ---- Глобальный поиск: номер, название, вид ----
    this.searchRegistry.register({
      type: ORG_DOCUMENT_REF_TYPE,
      label: 'Документы',
      search: (viewerId, query, opts) => this.search(viewerId, query, opts),
    });

    // ---- Группа полей шаблона «Документ» ----
    // Значения приходят от сервиса при сборке (номер, дата, поля формы), поэтому
    // resolve здесь ничего не отдаёт: группа объявлена ради панели конструктора и
    // компилятора — чтобы `{Документ.Номер}` не считался опечаткой.
    this.templateFields.register({
      key: 'document',
      tagPrefix: 'Документ',
      label: 'Документ',
      fields: [
        { key: 'Название', label: 'Название документа', example: 'Заявление на отпуск' },
        { key: 'Номер', label: 'Регистрационный номер', example: 'ПР-2026-007' },
        { key: 'Дата', label: 'Дата документа', example: '03.08.2026' },
      ],
      resolve: async () => null,
    });
  }

  /**
   * Поиск по реестру документов. Права режутся В SQL: без документов организаций,
   * где зритель не работает, и без чужих карточек закрытых видов.
   */
  private async search(
    viewerId: string,
    query: string,
    opts: SearchProviderOpts,
  ): Promise<SearchProviderResult> {
    const memberships = await this.db.userRole.findMany({
      where: { userId: viewerId, context: 'workspace', isActive: true, role: { not: 'contractor' } },
      select: { tenantId: true, role: true },
    });
    const workspaceIds = memberships.map((m) => m.tenantId).filter((v): v is string => !!v);
    if (!workspaceIds.length) return { items: [] };

    const rows = await this.db.orgDocument.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { number: { contains: query, mode: 'insensitive' } },
        ],
        // Видимость: свои документы и виды, открытые всей команде. Управляющим шире —
        // но это уже проверит открытие карточки; в выдаче поиска мы намеренно строги.
        AND: [
          {
            OR: [
              { createdById: viewerId },
              { subjectUserId: viewerId },
              { docType: { visibility: 'team' } },
            ],
          },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit,
      include: { docType: { select: { name: true } } },
    });

    return {
      items: rows.map((r) => ({
        type: ORG_DOCUMENT_REF_TYPE as SearchSourceType,
        id: r.id,
        title: r.number ? `${r.title} № ${r.number}` : r.title,
        snippet: r.docType.name,
        url: `/workspaces/${r.workspaceId}/documents/${r.id}`,
        chatId: null,
        messageId: null,
        avatar: null,
        createdAt: r.createdAt.toISOString(),
        score: 0,
      })),
    };
  }

  /** Проекция карточки в индекс поиска (зовётся сервисом при мутациях) */
  async project(documentId: string): Promise<void> {
    const doc = await this.db.orgDocument.findUnique({
      where: { id: documentId },
      include: { docType: { select: { name: true } } },
    });
    if (!doc) {
      await this.searchProjection.remove(ORG_DOCUMENT_REF_TYPE, documentId).catch(() => undefined);
      return;
    }
    await this.searchProjection
      .upsert({
        sourceType: ORG_DOCUMENT_REF_TYPE,
        sourceId: doc.id,
        url: `/workspaces/${doc.workspaceId}/documents/${doc.id}`,
        itemCreatedAt: doc.updatedAt,
        title: doc.number ? `${doc.title} № ${doc.number}` : doc.title,
        body: doc.docType.name,
        workspaceId: doc.workspaceId,
      })
      .catch(() => undefined);
  }
}
