import { Injectable, OnModuleInit } from '@nestjs/common';
import { ORG_DOCUMENT_REF_TYPE, type SearchSourceType } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { ApprovalsRegistry } from '../../core/approvals/approvals.registry';
import { SignRegistry, type SignActFinishedInfo } from '../../core/sign/sign.registry';
import { ChatterService } from '../../core/chatter/chatter.service';
import { ChatterRefRegistry } from '../../core/chatter/chatter-ref.registry';
import { FilesRefRegistry } from '../../core/files/files-ref.registry';
import { SearchRegistry } from '../../core/search/search.registry';
import { SearchProjectionService } from '../../core/search/search-projection.service';
import { TemplateFieldRegistry } from '../../core/templates/template-field.registry';
import type { SearchProviderOpts, SearchProviderResult } from '../../core/search/search.types';
import { DocumentsService } from './documents.service';

/**
 * Окно, в котором запись хроники о подписи считается уже сделанной. Берём с
 * большим запасом: джоб живёт до восьми попыток с растущим бэкоффом, а сверка
 * идёт по идентификатору АКТА — он уникален, и ложного совпадения быть не может.
 */
const SIGN_CHATTER_DEDUP_MS = 30 * 24 * 3600 * 1000;

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
    private readonly sign: SignRegistry,
    private readonly chatter: ChatterService,
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
      // Ознакомление СТОРОНЫ документа по шагу маршрута — юридический факт:
      // уходит в личный архив работника (КЭДО), как и клик в кампании.
      onDecided: async ({ refId, stepKind, decision, userId }) => {
        if (stepKind !== 'acknowledgement' || decision !== 'approved') return;
        const doc = await this.db.orgDocument.findUnique({
          where: { id: refId },
          select: { subjectUserId: true },
        });
        if (doc?.subjectUserId !== userId) return;
        await this.documents.notifyHrAcknowledged(refId, userId);
      },
    });

    // ---- Электронная подпись: документ как ПРЕДМЕТ подписи ----
    // Движок подписи сам заморозит копию того, что показывает подписанту, —
    // поэтому здесь достаточно сказать, ГДЕ лежат байты и КТО вправе отправить
    // документ на подпись. Правило то же, что у согласования: право проверяем
    // здесь, потому что через этот резолвер проходит любое заведение заявки.
    this.sign.register(ORG_DOCUMENT_REF_TYPE, {
      resolveSubject: async (refId) => {
        const doc = await this.db.orgDocument.findUnique({ where: { id: refId } });
        if (!doc) return null;
        // Подписывается ОТПЕЧАТОК, а не живой .docx: у builder-документа `fileId`
        // и есть готовый PDF, у docx-документа PDF снимается отдельным джобом и
        // ложится в `pdfFileId`.
        //
        // Отсутствие отпечатка — это ОТКАЗ, а не повод подписать исходник. Прежнее
        // `doc.pdfFileId ?? doc.fileId` при неготовом (или упавшем) джобе тихо
        // отдавало на подпись сам .docx: человек видел и подписывал редактируемый
        // файл вместо печатного отпечатка — ровно то, чего заморозка и должна не
        // допускать. Лучше честное «документ не готов».
        const fileId = doc.builderDoc ? doc.fileId : doc.pdfFileId;
        if (!fileId) return null;
        // У docx-документа pdfFileId указывает на ЖИВОЙ файл (documentId ведёт в
        // core/docs), а PDF существует его ВАРИАНТОМ — движку так и говорим, какой
        // вариант читать. `documentId` в условии несущий: у ЗАГРУЖЕННОГО PDF тоже
        // pdfFileId === fileId, но файл и есть PDF — вариант у него не существует,
        // и без этой сверки отправка контрагенту падала «Вариант файла не найден».
        const variant =
          !doc.builderDoc && doc.pdfFileId === doc.fileId && !!doc.documentId ? 'pdf' : undefined;
        return {
          fileId,
          variant,
          title: doc.number ? `${doc.title} № ${doc.number}` : doc.title,
          icon: 'signature',
          workspaceId: doc.workspaceId,
          // Владелец доказательств — ОРГАНИЗАЦИЯ: подписанный приказ не может
          // числиться за сотрудником и исчезнуть вместе с ним при увольнении.
          ownerType: 'workspace',
          ownerId: doc.workspaceId,
        };
      },
      canRequestSign: async (userId, refId) => {
        const doc = await this.db.orgDocument.findUnique({ where: { id: refId } });
        if (!doc) return false;
        return this.documents.canRequestApproval(userId, doc);
      },
      canView: (userId, refId) =>
        this.documents
          .get(userId, refId)
          .then(() => true)
          .catch(() => false),
      describeForVerify: async (refId) => {
        const doc = await this.db.orgDocument.findUnique({
          where: { id: refId },
          include: { docType: { select: { name: true } }, workspace: { select: { name: true } } },
        });
        if (!doc) return null;
        // Публичная страница проверки — открытая (ст. 61 ЦК), поэтому отдаём
        // МИНИМУМ: что за документ и от какой организации. Ни сторон, ни полей,
        // ни содержимого — их приносит тот, у кого файл на руках.
        return {
          title: doc.number ? `${doc.title} № ${doc.number}` : doc.title,
          kindLabel: doc.docType.name,
          orgLabel: doc.workspace.name,
        };
      },
      onActFinished: async (refId, info) => {
        // Отметку «подписан» ставит МАРШРУТ (он знает, все ли шаги пройдены), а
        // не отдельная подпись. Наше дело здесь — хроника: без неё подпись,
        // поставленная вне маршрута, не оставила бы на карточке ни следа.
        await this.chatterLog(refId, info);
        // ВНЕШНИЙ ЭТАП: свободная заявка (без шага) двигает статус документа
        // сама — маршрута у категории «С контрагентами» нет. Методы статус-
        // гвардятся `WHERE status='sent'` и для внутренних документов no-op.
        await this.externalOutcome(refId, info);
        // КЭДО: работник подписал документ о себе → личная запись-архив; акт
        // работодателя ЭЦП физлица на кадровом виде → предупреждение (порт hr).
        await this.documents.notifyHrActFinished(refId, {
          outcome: info.outcome,
          level: info.level,
          signerUserId: info.signerUserId,
          signRequestId: info.requestId,
          certSubjectBin: info.certSubjectBin,
        });
      },
      // Срок сбора истёк (крон закрыл заявку): документ возвращается в черновик
      onRequestExpired: async (refId, info) => {
        await this.documents.externalResolve(refId, 'expired', { requestId: info.requestId });
      },
      // Сертификат ВНЕШНЕГО подписанта сверяется с карточкой контрагента:
      // договор должен подписать тот, с кем его заключают.
      checkGuestCert: (refId, cert) => this.documents.checkCounterpartyCert(refId, cert),
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
        // КЭДО (Этап 8): ПОДПИСАННЫЙ кадровый документ не удаляется никем и
        // никогда — ни ручкой файлов, ни удалением узла Диска (приказ № 279-НК:
        // сроки хранения до 75 лет; правило enforce'ит движок файлов на ОБОИХ
        // путях удаления, спрашивая этот предикат).
        blocksDeletion: async (refId) => {
          const doc = await this.db.orgDocument.findUnique({
            where: { id: refId },
            select: { status: true, docType: { select: { category: true } } },
          });
          if (!doc) return false;
          return (
            doc.docType.category === 'hr' &&
            ['signed', 'registered', 'active', 'archived'].includes(doc.status)
          );
        },
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
   * Исход внешнего этапа по закрытому акту. Guard-методы сервиса переводят
   * статус документа сами; здесь только маршрутизация.
   *
   * Отказ различается ПО СТОРОНЕ подписанта, как и подпись ниже. Отказ одного
   * закрывает всю заявку (правило движка), но это не делает виновником вторую
   * сторону: пока `signerType` здесь не смотрели, отказ собственного директора
   * ставил документу статус «Контрагент отказал» и слал автору «Контрагент
   * отказал» с причиной, которую написал свой же сотрудник, — при том, что
   * хроника рядом честно писала `org_document.rejected`.
   */
  private async externalOutcome(documentId: string, info: SignActFinishedInfo): Promise<void> {
    const act = await this.db.signAct.findUnique({
      where: { id: info.actId },
      select: {
        signerType: true,
        signerName: true,
        declineReason: true,
        request: { select: { id: true, approvalStepId: true } },
      },
    });
    // Шаговые заявки двигает маршрут — внешний этап только у свободных
    if (!act || act.request.approvalStepId) return;
    const isGuest = act.signerType === 'guest';
    if (info.outcome === 'declined') {
      await this.documents.externalResolve(documentId, isGuest ? 'declined' : 'declined_internal', {
        reason: act.declineReason,
        signerName: act.signerName,
        requestId: act.request.id,
      });
      return;
    }
    if (info.requestCompleted) {
      await this.documents.externalMarkSigned(documentId, {
        signerName: isGuest ? act.signerName : null,
        requestId: act.request.id,
      });
    }
  }

  /** След подписи в хронике карточки — она же превращается в плашку чата */
  private async chatterLog(documentId: string, info: SignActFinishedInfo): Promise<void> {
    const doc = await this.db.orgDocument.findUnique({
      where: { id: documentId },
      select: { title: true, workspaceId: true },
    });
    if (!doc) return;
    // Гость (контрагент) получает свои записи хроники — с именем и причиной;
    // внутренние акты пишутся как раньше.
    const act = await this.db.signAct.findUnique({
      where: { id: info.actId },
      select: { signerType: true, signerName: true, declineReason: true },
    });
    const isGuest = act?.signerType === 'guest';
    const typeKey =
      info.outcome === 'signed'
        ? isGuest
          ? 'org_document.counterparty_signed'
          : 'org_document.signed'
        : isGuest
          ? 'org_document.counterparty_declined'
          : 'org_document.rejected';

    // Хук зовёт ДЖОБ, а он исполняется at-least-once: повтор после сбоя доставки
    // уведомления написал бы «документ подписан» второй раз — и в хронике, и
    // плашкой в чате. Ключ идемпотентности здесь естественный: акт подписи. Он
    // уходит в payload и по нему же проверяется, не записано ли уже.
    const already = await this.chatter
      .hasRecent({
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: documentId,
        typeKey,
        withinMs: SIGN_CHATTER_DEDUP_MS,
        payloadPath: { path: ['actId'], equals: info.actId },
      })
      .catch(() => false);
    if (already) return;

    await this.chatter
      .log(null, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: documentId,
        workspaceId: doc.workspaceId,
        typeKey,
        payload: {
          title: doc.title,
          reasonSuffix: isGuest && act?.declineReason ? `: ${act.declineReason}` : '',
          signerSuffix: isGuest && act?.signerName ? ` — ${act.signerName}` : '',
          actId: info.actId,
        },
        actorId: info.signerUserId ?? undefined,
      })
      .catch(() => undefined);
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
