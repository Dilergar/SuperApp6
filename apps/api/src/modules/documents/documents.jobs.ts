import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import { ORG_DOCUMENT_REF_TYPE, driveNameKey, expandDocFormValues } from '@superapp/shared';
import type { BuilderDoc } from '@superapp/shared';
import type { OrgDocument } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { JobDiscardError, JobsRegistry } from '../../core/jobs/jobs.registry';
import { JobsService } from '../../core/jobs/jobs.service';
import { FilesService } from '../../core/files/files.service';
import { DocsService } from '../../core/docs/docs.service';
import { DocsRenditionService } from '../../core/docs/docs-rendition.service';
import { TemplateRenderService } from '../../core/templates/template-render.service';
import { PdfRenderService } from '../../core/templates/pdf-render.service';
import { renderBuilderHtml } from '../../core/templates/builder-render.driver';
import { TemplateCompileError, TemplateDataError } from '../../core/templates/template.types';
import { DriveService } from '../drive/drive.service';
import { AccessService } from '../../core/access/access.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { DocumentsService } from './documents.service';
import { withTempFile } from '../../shared/fs/temp-file.util';
import {
  DOCUMENTS_FILE_JOB,
  DOCUMENTS_FILE_PROFILE,
  DOCUMENTS_GENERATE_JOB,
  DOCUMENTS_PDF_JOB,
  DOCUMENTS_QUEUE,
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
  docGenKey,
} from './documents.constants';

/**
 * Фоновая работа сервиса «Документы» — своя очередь `documents`.
 *
 * Почему не 'default': сборка .docx и конвертация в PDF ходят к редактору и к
 * хранилищу и занимают слот надолго; в общей очереди они подпирали бы
 * латентно-чувствительные типы (правило движка джобов о тяжёлых типах).
 */
@Injectable()
export class DocumentsJobs implements OnModuleInit {
  private readonly logger = new Logger(DocumentsJobs.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: JobsRegistry,
    private readonly jobs: JobsService,
    private readonly files: FilesService,
    private readonly docs: DocsService,
    private readonly rendition: DocsRenditionService,
    private readonly templates: TemplateRenderService,
    private readonly pdfRender: PdfRenderService,
    private readonly drive: DriveService,
    private readonly access: AccessService,
    private readonly chatter: ChatterService,
    private readonly documents: DocumentsService,
  ) {}

  onModuleInit(): void {
    // Бэкофф у сборки и отпечатка КОРОТКИЙ (3с, не движковые 30с): их транзиенты —
    // это «параллельный рендер успел раньше» (замок replaceContent) и «конвертация
    // ещё идёт», то есть состояния, живущие секундами. Пока бэкофф был 30с×2^n,
    // страж assertNotRebuilding держал отправку до минуты с лишним, и человек
    // кликал в красный тост «попробуйте через несколько секунд», которые врали.
    this.registry.register(
      DOCUMENTS_GENERATE_JOB,
      (p) => this.generate(String(p.documentId), p.rerun === true),
      {
        queue: DOCUMENTS_QUEUE,
        queueConcurrency: 3,
        maxAttempts: 6,
        backoffBaseMs: 3000,
        leaseMs: 5 * 60 * 1000,
      },
    );
    this.registry.register(DOCUMENTS_PDF_JOB, (p) => this.snapshotPdf(String(p.documentId)), {
      queue: DOCUMENTS_QUEUE,
      // 3+6+12+24+48+96+192с ≈ 6 мин потолок ожидания конвертации Collabora —
      // сопоставимо с прежними 5 попытками по 30с+, но первые опросы приходят
      // через секунды, а не через полминуты.
      maxAttempts: 8,
      backoffBaseMs: 3000,
      leaseMs: 10 * 60 * 1000,
    });
    this.registry.register(
      DOCUMENTS_FILE_JOB,
      (p, ctx) => this.fileToDrive(String(p.documentId), ctx),
      {
        queue: DOCUMENTS_QUEUE,
        maxAttempts: 5,
        leaseMs: 5 * 60 * 1000,
      },
    );
  }

  // ============================================================
  // Сборка документа по шаблону
  // ============================================================

  /**
   * Заполнить бланк шаблона данными: группы реестра `core/templates` (Организация,
   * Сотрудник) + значения формы подачи. Результат — новый .docx карточки; повторный
   * заход пересобирает содержимое ЖИВОГО файла на месте, поэтому id вложения и
   * открытая вкладка редактора остаются рабочими.
   *
   * Схлопывание пересборок (см. docGenKey): джоб на документ ОДИН (стабильный
   * ключ), а правка, приземлившаяся ПОКА мы рендерили, не теряется — снимок
   * входов сверяется перед записью (устаревшие байты не пишем вовсе) и в хвосте
   * (изменился → перезаказываем себя парным ключом; свой ещё живёт executing, и
   * одноимённая постановка схлопнулась бы об него).
   */
  private async generate(documentId: string, rerun: boolean): Promise<void> {
    const doc = await this.db.orgDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new JobDiscardError('документ удалён');
    const snap = this.contentSnapshot(doc);
    // Блочный документ (по builder-шаблону или свободный): файл = сам PDF
    if (doc.builderDoc) await this.generateBuilder(doc, snap);
    else await this.generateDocx(doc, snap);
    await this.rerunIfStale(documentId, snap, rerun);
  }

  private async generateDocx(doc: OrgDocument, snap: string): Promise<void> {
    if (!doc.templateId) throw new JobDiscardError('документ без шаблона — собирать нечего');
    // Ушедший на маршрут документ ПЕРЕсобирать нельзя: под руками согласующего
    // содержимое меняться не должно (ровно то, ради чего его и замораживают).
    //
    // Но ПЕРВАЯ сборка разрешена в любом статусе: производный приказ создаётся нодой
    // маршрута сразу «в работе», и с проверкой по одному статусу он не собирался
    // никогда — карточка с номером и без единого файла, а «Подшить в дело» падало.
    if (doc.fileId && doc.status !== 'draft' && doc.status !== 'rejected') return;

    const tpl = await this.db.docTemplate.findUnique({ where: { id: doc.templateId } });
    if (!tpl?.fileId) throw new JobDiscardError('у шаблона нет бланка');

    const { result } = await this.files.openRawStream(tpl.fileId, null);
    const blank = await streamToBuffer(result.stream);

    let bytes: Buffer;
    try {
      const rendered = await this.templates.renderForContext(
        blank,
        {
          workspaceId: doc.workspaceId,
          subjectUserId: doc.subjectUserId ?? undefined,
          actorUserId: doc.createdById,
          // Внешний контур: теги {Контрагент.*} заполняет группа справочника
          counterpartyId: doc.counterpartyId ?? undefined,
          counterpartyContactId: doc.counterpartyContactId ?? undefined,
        },
        this.documentValues(doc),
        // Мягкий режим: недостающее поле остаётся ВИДИМЫМ тегом в черновике. Иначе
        // сборка падала бы у каждого, кто ещё не дозаполнил анкету, и человек видел
        // бы пустую карточку вместо документа с подсказкой, чего не хватает.
        { strict: false },
      );
      bytes = rendered.bytes;
    } catch (e) {
      if (e instanceof TemplateCompileError || e instanceof TemplateDataError) {
        // Битый бланк чинит автор шаблона — ретраить нечего.
        throw new JobDiscardError(`шаблон не собирается: ${e.message}`);
      }
      throw e;
    }

    const name = `${doc.title}.docx`.replace(/[\\/:*?"<>|]/g, '-');

    // Пересборка черновика: содержимое ЖИВОГО файла меняется на месте (модель
    // core/docs), поэтому id вложения стабилен, а открытый редактор подхватит новое.
    if (doc.fileId) {
      // Пока рендерили, входы могли смениться — устаревшие байты не пишем вовсе:
      // хвост rerunIfStale перезакажет рендер по свежим данным. Без этой проверки
      // поздний рендер СТАРЫХ данных мог лечь ПОВЕРХ свежих байтов соседа.
      if ((await this.freshSnapshot(doc.id)) !== snap) return;
      await withTempFile(name, bytes, (filePath) =>
        this.files.replaceContent({ fileId: doc.fileId!, sourcePath: filePath, actorId: doc.createdById }),
      );
      // Содержимое сменилось — прежний PDF-отпечаток МЁРТВ (`replaceContent`
      // сносит производные варианты), а колонка `pdfFileId` продолжала на него
      // указывать: отправка контрагенту находила «отпечаток», замораживала
      // несуществующий вариант и падала «Вариант файла не найден» — без пути к
      // самолечению, потому что веб по непустой колонке считал PDF готовым и
      // заново его не заказывал. Честно обнуляем и заказываем новый; страж
      // `assertNotRebuilding` держит отправку, пока pdf-джоб не дожуётся.
      await this.db.orgDocument.updateMany({
        where: { id: doc.id, pdfFileId: { not: null } },
        data: { pdfFileId: null },
      });
      await this.documents.requestPdf(doc.id).catch((e) => {
        this.logger.warn(`перезаказ отпечатка ${doc.id}: ${(e as Error).message}`);
      });
      return;
    }

    const file = await withTempFile(name, bytes, (filePath) =>
      this.files.ingestLocalFile({
        path: filePath,
        name,
        mime: DOCX_MIME_TYPE,
        profile: DOCUMENTS_FILE_PROFILE,
        ownerUserId: doc.createdById,
        // Владелец — ОРГАНИЗАЦИЯ: приказ не может числиться за сотрудником и исчезнуть
        // вместе с его квотой при увольнении.
        ownerType: 'workspace',
        ownerId: doc.workspaceId,
      }),
    );

    // Оживление в документ core/docs — чтобы правка шла общим редактором.
    let liveDocumentId: string | null = null;
    if (this.docs.enabled) {
      liveDocumentId = await this.docs
        .createFromFile(doc.createdById, { fileId: file.id, title: doc.title })
        .then((d) => d.id)
        .catch((e) => {
          this.logger.warn(`оживление документа ${doc.id}: ${(e as Error).message}`);
          return null;
        });
    }

    await this.db.$transaction(async (tx) => {
      const claimed = await tx.orgDocument.updateMany({
        where: { id: doc.id, fileId: null },
        data: { fileId: file.id, ...(liveDocumentId ? { documentId: liveDocumentId } : {}) },
      });
      if (claimed.count === 0) return; // соседний заход успел первым
      // Связь с КАРТОЧКОЙ: она и делает документ «местом» файла, а место у нас со
      // своими правилами (вид «только управляющим»). Без неё файл принадлежал бы
      // организации и попадал под общее «файл организации виден всей команде».
      await this.files.linkSystemInTx(tx, {
        fileId: file.id,
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: doc.id,
        createdById: doc.createdById,
      });
    });
  }

  /**
   * Снимок ВСЕХ входов рендера, живущих на строке документа. Сравнение «до/после»
   * — замок схлопывания пересборок: правка, приземлившаяся ПОКА джоб рендерил,
   * обнаруживается по несовпадению снимка. Новое поле, влияющее на рендер, ОБЯЗАНО
   * попасть сюда — иначе его правка не перебьёт уже идущий рендер старых данных.
   * Ключи jsonb Postgres нормализует сам, поэтому две выборки одного значения
   * дают одинаковую строку.
   */
  private contentSnapshot(doc: {
    title: string;
    number: string | null;
    subjectUserId: string | null;
    counterpartyId: string | null;
    counterpartyContactId: string | null;
    templateId: string | null;
    fields: unknown;
    formFields: unknown;
    builderDoc: unknown;
  }): string {
    return JSON.stringify({
      title: doc.title,
      number: doc.number,
      subjectUserId: doc.subjectUserId,
      counterpartyId: doc.counterpartyId,
      counterpartyContactId: doc.counterpartyContactId,
      templateId: doc.templateId,
      fields: doc.fields ?? null,
      formFields: doc.formFields ?? null,
      builderDoc: doc.builderDoc ?? null,
    });
  }

  /** Свежий снимок входов рендера; null — документ исчез */
  private async freshSnapshot(documentId: string): Promise<string | null> {
    const row = await this.db.orgDocument.findUnique({
      where: { id: documentId },
      select: {
        title: true,
        number: true,
        subjectUserId: true,
        counterpartyId: true,
        counterpartyContactId: true,
        templateId: true,
        fields: true,
        formFields: true,
        builderDoc: true,
      },
    });
    return row ? this.contentSnapshot(row) : null;
  }

  /**
   * Хвост схлопывания: входы сменились, пока джоб работал, → перезаказать рендер
   * ПАРНЫМ ключом. Своим нельзя — текущий джоб ещё числится executing, и
   * одноимённая постановка схлопнулась бы об него, потеряв правку. Парный джоб
   * перечитает всё свежим на СВОЁМ старте, поэтому цепочка сходится, как только
   * правки прекращаются; бесконечного пинг-понга нет — без новой правки снимки
   * совпадают и перезаказ не ставится.
   */
  private async rerunIfStale(documentId: string, renderedSnap: string, rerun: boolean): Promise<void> {
    const fresh = await this.freshSnapshot(documentId);
    if (fresh === null || fresh === renderedSnap) return;
    await this.jobs.enqueue(null, {
      type: DOCUMENTS_GENERATE_JOB,
      payload: { documentId, rerun: !rerun },
      uniqueKey: docGenKey(documentId, !rerun),
      runAt: new Date(Date.now() + 1500),
    });
  }

  /**
   * Значения формы подачи под группой «Документ» + сами поля россыпью.
   * Периоды дат {from,to} разворачиваются в «X С»/«X По»/«X Дней» — теги
   * шаблонов остаются плоскими двухчастными, глубоких путей в синтаксисе нет.
   */
  private documentValues(doc: {
    title: string;
    number: string | null;
    createdAt: Date;
    fields: unknown;
  }): Record<string, unknown> {
    const fields = (doc.fields ?? {}) as Record<string, unknown>;
    return {
      ...expandDocFormValues(fields),
      Документ: {
        Название: doc.title,
        Номер: doc.number ?? '',
        Дата: doc.createdAt,
      },
    };
  }

  // ============================================================
  // Блочный документ (конструктор): файл карточки — сам PDF
  // ============================================================

  /**
   * Собрать PDF из блоков. Симметрия с docx-путём: пересборка меняет ЖИВОЙ файл
   * на месте (id стабилен — вложения и подшивка не ломаются), первая сборка
   * инжестит новый; documentId (core/docs) у builder-документов не бывает —
   * PDF внешним редактором не правится.
   */
  private async generateBuilder(doc: OrgDocument, snap: string): Promise<void> {
    if (!this.pdfRender.enabled) {
      // Карточка остаётся без файла, submit честно заблокирован (он требует fileId)
      throw new JobDiscardError('PDF-рендер выключен (GOTENBERG_URL не задан)');
    }
    // Тот же гейт, что у docx-пути: ушедшее на маршрут не пересобирается
    if (doc.fileId && doc.status !== 'draft' && doc.status !== 'rejected') return;

    const bytes = await this.renderBuilderPdf(doc);
    const name = `${doc.title}.pdf`.replace(/[\\/:*?"<>|]/g, '-');

    if (doc.fileId) {
      // Устаревшие байты не пишем (см. docx-путь) — хвост rerunIfStale перерендерит
      if ((await this.freshSnapshot(doc.id)) !== snap) return;
      await withTempFile(name, bytes, (filePath) =>
        this.files.replaceContent({ fileId: doc.fileId!, sourcePath: filePath, actorId: doc.createdById }),
      );
      return;
    }

    const file = await withTempFile(name, bytes, (filePath) =>
      this.files.ingestLocalFile({
        path: filePath,
        name,
        mime: PDF_MIME_TYPE,
        profile: DOCUMENTS_FILE_PROFILE,
        ownerUserId: doc.createdById,
        ownerType: 'workspace',
        ownerId: doc.workspaceId,
      }),
    );
    await this.db.$transaction(async (tx) => {
      const claimed = await tx.orgDocument.updateMany({
        where: { id: doc.id, fileId: null },
        data: { fileId: file.id },
      });
      if (claimed.count === 0) return;
      await this.files.linkSystemInTx(tx, {
        fileId: file.id,
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: doc.id,
        createdById: doc.createdById,
      });
    });
  }

  /** Рендер блоков в PDF-байты: значения реестра ПОВЕРХ значений формы (анти-подмена) */
  private async renderBuilderPdf(doc: {
    id: string;
    workspaceId: string;
    createdById: string;
    subjectUserId: string | null;
    counterpartyId: string | null;
    counterpartyContactId: string | null;
    title: string;
    number: string | null;
    createdAt: Date;
    builderDoc: unknown;
    fields: unknown;
  }): Promise<Buffer> {
    const builderDoc = doc.builderDoc as BuilderDoc;
    const values = {
      ...this.documentValues(doc),
      ...(await this.templates.resolveContextValues({
        workspaceId: doc.workspaceId,
        subjectUserId: doc.subjectUserId ?? undefined,
        actorUserId: doc.createdById,
        counterpartyId: doc.counterpartyId ?? undefined,
        counterpartyContactId: doc.counterpartyContactId ?? undefined,
      })),
    };
    const logoDataUri = await this.documents.builderLogo(doc.workspaceId, builderDoc);
    // Мягкий режим, как у docx-сборки: недостающее — ВИДИМАЯ метка в документе,
    // а не отказ (человек дозаполняет анкету и пересобирает)
    const { html } = renderBuilderHtml(builderDoc, values, {
      strict: false,
      title: doc.title,
      assets: { logoDataUri },
    });
    return this.pdfRender.htmlToPdf(html, { footer: builderDoc.page?.footer ?? 'pageNumbers' });
  }

  // ============================================================
  // PDF-отпечаток
  // ============================================================

  /**
   * Снять PDF текущего содержимого. Конвертацию делает `core/docs` (наша сборка
   * редактора) своим джобом; здесь — дождаться готовности и запомнить fileId.
   */
  private async snapshotPdf(documentId: string): Promise<void> {
    const doc = await this.db.orgDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new JobDiscardError('документ удалён');

    // Блочный документ: файл и есть PDF — пересобираем из ТЕКУЩИХ блоков (свежий
    // отпечаток того, что уйдёт на решение) и отмечаем его отпечатком.
    if (doc.builderDoc) {
      if (!this.pdfRender.enabled) throw new JobDiscardError('PDF-рендер выключен (GOTENBERG_URL не задан)');
      const snap = this.contentSnapshot(doc);
      const bytes = await this.renderBuilderPdf(doc);
      const name = `${doc.title}.pdf`.replace(/[\\/:*?"<>|]/g, '-');
      let fileId = doc.fileId;
      if (fileId) {
        // Тот же замок, что у сборки: входы сменились, пока рендерили, → байты
        // не пишем (их перерендерит generate, поставленный правкой), а отпечаток
        // всё равно отметим — у builder-документа он указывает на сам файл, и
        // свежесть байтов держит живой generate-джоб + страж assertNotRebuilding.
        if ((await this.freshSnapshot(doc.id)) === snap) {
          await withTempFile(name, bytes, (filePath) =>
            this.files.replaceContent({ fileId: fileId!, sourcePath: filePath, actorId: doc.createdById }),
          );
        }
      } else {
        // generate мог не успеть (или его джоб потерялся) — отпечаток сам создаёт файл
        const file = await withTempFile(name, bytes, (filePath) =>
          this.files.ingestLocalFile({
            path: filePath,
            name,
            mime: PDF_MIME_TYPE,
            profile: DOCUMENTS_FILE_PROFILE,
            ownerUserId: doc.createdById,
            ownerType: 'workspace',
            ownerId: doc.workspaceId,
          }),
        );
        fileId = file.id;
        await this.db.$transaction(async (tx) => {
          const claimed = await tx.orgDocument.updateMany({
            where: { id: doc.id, fileId: null },
            data: { fileId: file.id },
          });
          if (claimed.count === 0) return;
          await this.files.linkSystemInTx(tx, {
            fileId: file.id,
            refType: ORG_DOCUMENT_REF_TYPE,
            refId: doc.id,
            createdById: doc.createdById,
          });
        });
      }
      await this.db.orgDocument.update({ where: { id: doc.id }, data: { pdfFileId: fileId } });
      // Правка приземлилась, пока мы писали, → байты перерендерит generate: ставим
      // его ОСНОВНЫМ ключом (pdf-джоб генераторных ключей не держит; живой уже
      // есть — постановка схлопнется об него, и правку покроет он сам).
      await this.rerunIfStale(doc.id, snap, true);
      return;
    }

    if (!doc.documentId) throw new JobDiscardError('у документа нет живого файла — PDF снимать не с чего');
    if (!this.docs.enabled) throw new JobDiscardError('редактор документов выключен');

    const { ready } = await this.rendition.request(doc.documentId, 'pdf');
    // Не готово — это НЕ ошибка: конвертация идёт своим джобом. Просим движок
    // повторить нас позже обычным ретраем.
    if (!ready) throw new Error('PDF ещё конвертируется');

    const live = await this.db.document.findUnique({
      where: { id: doc.documentId },
      select: { fileId: true },
    });
    if (!live) throw new JobDiscardError('живой документ исчез');
    const variant = await this.files.getVariant(live.fileId, 'pdf');
    if (!variant) throw new Error('PDF-вариант ещё не записан');

    await this.db.orgDocument.update({
      where: { id: doc.id },
      data: { pdfFileId: live.fileId },
    });
  }

  // ============================================================
  // Подшивка на Диск
  // ============================================================

  /**
   * Положить подписанный документ на Диск организации ДВУМЯ узлами: в реестр вида и
   * (если вид так настроен) в личное дело сотрудника. Файл при этом ОДИН — байты не
   * дублируются и квота не удваивается.
   */
  private async fileToDrive(documentId: string, ctx?: { attempt: number; maxAttempts: number }): Promise<void> {
    const doc = await this.db.orgDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new JobDiscardError('документ удалён');
    if (!doc.fileId) throw new JobDiscardError('у документа нет файла');
    if (doc.registryNodeId && (doc.personalNodeId || !(await this.wantsPersonal(doc.docTypeId)))) return;

    const type = await this.db.docType.findUniqueOrThrow({ where: { id: doc.docTypeId } });
    const space = await this.drive.getOrCreateSpace('workspace', doc.workspaceId);
    if (!space.rootId) throw new JobDiscardError('у диска организации нет корня');

    // ВНЕШНИЙ контур: в реестр подшивается ШТАМПОВАННАЯ копия (полосы + «Лист
    // подписей») — это тот экземпляр, который печатают и рассылают. Штамп собирает
    // джоб движка подписи; ждём его обычными ретраями, а на последней попытке
    // честно откатываемся на PDF-отпечаток — документ обязан попасть в реестр.
    let fileToPin = doc.fileId;
    let fileOwner = doc.createdById;
    // Признак штампа — ЯВНЫЙ флаг, а не «файл отличается от doc.fileId»: у
    // docx-документа `pdfFileId` тоже не равен `fileId`, поэтому на фолбэке
    // чистый отпечаток уезжал в реестр с именем «… (подписано).pdf» — то есть
    // именно тот экземпляр, который печатают и отдают контрагенту, обещал штампы
    // и «Лист подписей», которых в нём нет.
    let stamped = false;
    // `undefined` — «считай по карточке» (обычный путь); true ставим там, где
    // подшиваем заведомо PDF, отличный от файла карточки.
    let pinIsPdf: boolean | undefined;
    if (type.category === 'external') {
      const request = await this.db.signRequest.findFirst({
        where: { refType: ORG_DOCUMENT_REF_TYPE, refId: doc.id, status: 'completed', approvalStepId: null },
        orderBy: { createdAt: 'desc' },
        select: { stampedFileId: true, createdById: true },
      });
      if (request?.stampedFileId) {
        fileToPin = request.stampedFileId;
        fileOwner = request.createdById;
        stamped = true;
        pinIsPdf = true;
      } else if (request && ctx && ctx.attempt < ctx.maxAttempts) {
        throw new Error('штампованная копия ещё собирается');
      } else if (doc.pdfFileId) {
        fileToPin = doc.pdfFileId;
        pinIsPdf = true;
      }
    }

    // 1) Реестр вида: «Документы организации» → «Приказы»
    let registryNodeId = doc.registryNodeId;
    if (!registryNodeId) {
      const registryRoot = await this.drive.systemFolder(space.id, 'documents');
      // Папка закрытая (наследование с корня обрывается), поэтому доступ внутрь —
      // явными грантами: управляющие ведут документооборот и видят реестр целиком.
      await this.drive.systemEnsureRestricted(registryRoot.id);
      await this.grantFolder(registryRoot.id, doc.workspaceId, 'manager', 'manager');
      const typeFolder = await this.drive.systemEnsureFolder(space.id, registryRoot.id, type.name);
      // Вид, объявленный открытым для команды, открыт и на Диске — иначе одна и та же
      // настройка означала бы разное в реестре и в папке.
      if (type.visibility === 'team') {
        await this.grantFolder(typeFolder.id, doc.workspaceId, 'viewer', 'member');
      }
      // Актор — тот, под кем файл ингестился (uploaderId): для Диска он «свой».
      // Подставить 'system' нельзя — тот же метод счёл бы файл чужим и полез
      // бы делать копию (или ответил 404), а нам нужен один файл в двух местах.
      const node = await this.drive.placeFile(fileOwner, {
        spaceId: space.id,
        parentId: typeFolder.id,
        fileId: fileToPin,
        name: this.fileName(doc, { stamped, pdf: pinIsPdf }),
        parentAncestors: [...typeFolder.ancestorIds, typeFolder.id],
        depth: typeFolder.depth + 1,
      });
      registryNodeId = node.id;
    }

    // 2) Личное дело сотрудника — только если вид так настроен
    let personalNodeId = doc.personalNodeId;
    if (type.toPersonalFile && doc.subjectUserId && !personalNodeId) {
      // «Личные дела» — ЗАКРЫТАЯ папка: наследование с корня диска на ней обрывается,
      // поэтому доступ внутрь надо выдать явно. Управляющим — на всю папку (они ведут
      // кадры), сотруднику — только на его собственное дело.
      const personalRoot = await this.drive.systemFolder(space.id, 'personal_files');
      await this.grantPersonalRoot(personalRoot.id, doc.workspaceId);
      const personFolder = await this.personalFolder(space.id, personalRoot.id, doc.workspaceId, doc.subjectUserId);
      await this.access
        .grant({
          resourceType: 'drive_node',
          resourceId: personFolder.id,
          relation: 'viewer',
          subjectType: 'user',
          subjectId: doc.subjectUserId,
        })
        .catch(() => undefined);
      const node = await this.drive.placeFile(doc.createdById, {
        spaceId: space.id,
        parentId: personFolder.id,
        fileId: doc.fileId,
        name: this.fileName(doc),
        parentAncestors: [...personFolder.ancestorIds, personFolder.id],
        depth: personFolder.depth + 1,
      });
      personalNodeId = node.id;
    }

    await this.db.orgDocument.update({
      where: { id: doc.id },
      data: { registryNodeId, personalNodeId, status: doc.status === 'registered' ? 'active' : doc.status },
    });
    await this.chatter
      .log(null, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: doc.id,
        workspaceId: doc.workspaceId,
        typeKey: 'org_document.filed',
        payload: {
          title: doc.title,
          placeLabel: personalNodeId ? `реестр «${type.name}» и личное дело` : `реестр «${type.name}»`,
        },
      })
      .catch(() => undefined);
  }

  /**
   * Кадровые управляющие видят «Личные дела» целиком. Принципал — роль организации,
   * а не список людей: повысили человека до Менеджера — доступ появился сам, сняли —
   * пропал. Идемпотентно (upsert в движке прав).
   */
  private async grantPersonalRoot(nodeId: string, workspaceId: string): Promise<void> {
    // Одного ребра достаточно: лестница ролей организации (owner > admin > manager >
    // member) разворачивается движком прав, поэтому владелец и админ проходят по
    // грантy на «manager» сами.
    await this.grantFolder(nodeId, workspaceId, 'manager', 'manager');
  }

  /**
   * Грант на папку роли организации. `subjectRelation` — несущий: принципал зрителя
   * приезжает из проекции с отношением (`workspace:<id>#manager`), и грант без него
   * не совпал бы ни с кем (ровно так молча не работали гранты шаблонов).
   */
  private async grantFolder(
    nodeId: string,
    workspaceId: string,
    relation: 'manager' | 'editor' | 'viewer',
    role: 'manager' | 'member',
  ): Promise<void> {
    await this.access
      .grant({
        resourceType: 'drive_node',
        resourceId: nodeId,
        relation,
        subjectType: 'workspace',
        subjectId: workspaceId,
        subjectRelation: role,
      })
      .catch(() => undefined);
  }

  /**
   * Папка личного дела СОТРУДНИКА (не «папка с таким именем»).
   *
   * Идентичность папки в Диске — это её имя, а имя и фамилию человек правит сам.
   * Пока адресом служило только имя, тёзка (в том числе назвавшийся тёзкой намеренно)
   * попадал в чужое личное дело и получал на него доступ. Поэтому сначала ищем папку
   * по ПРЕДЫДУЩИМ документам того же сотрудника, а имя используем лишь как ярлык —
   * и при столкновении добавляем к нему короткую метку.
   */
  private async personalFolder(
    spaceId: string,
    personalRootId: string,
    workspaceId: string,
    subjectUserId: string,
  ): Promise<{ id: string; ancestorIds: string[]; depth: number }> {
    const previous = await this.db.orgDocument.findFirst({
      where: { workspaceId, subjectUserId, personalNodeId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { personalNodeId: true },
    });
    if (previous?.personalNodeId) {
      const node = await this.db.driveNode.findUnique({ where: { id: previous.personalNodeId } });
      if (node?.parentId) {
        const folder = await this.db.driveNode.findUnique({ where: { id: node.parentId } });
        // Папка могла уехать в корзину — тогда заводим заново по общему пути.
        if (folder && !folder.trashedAt && folder.ancestorIds.includes(personalRootId)) return folder;
      }
    }

    const person = await this.db.user.findUnique({
      where: { id: subjectUserId },
      select: { firstName: true, lastName: true },
    });
    const label = [person?.lastName, person?.firstName].filter(Boolean).join(' ') || 'Сотрудник';

    // Имя занято ЧУЖИМ делом (у папки уже есть личный доступ другого человека) —
    // берём имя с меткой, а не подселяем двоих в одну папку.
    const taken = await this.db.driveNode.findFirst({
      where: { spaceId, parentId: personalRootId, nameKey: driveNameKey(label), kind: 'folder', trashedAt: null },
      select: { id: true },
    });
    if (taken) {
      const owners = await this.db.relationTuple.findMany({
        where: {
          resourceType: 'drive_node',
          resourceId: taken.id,
          relation: 'viewer',
          subjectType: 'user',
        },
        select: { subjectId: true },
      });
      const mine = owners.length === 0 || owners.some((o) => o.subjectId === subjectUserId);
      if (!mine) {
        return this.drive.systemEnsureFolder(spaceId, personalRootId, `${label} · ${subjectUserId.slice(0, 4)}`);
      }
    }
    return this.drive.systemEnsureFolder(spaceId, personalRootId, label);
  }

  private async wantsPersonal(docTypeId: string): Promise<boolean> {
    const type = await this.db.docType.findUnique({
      where: { id: docTypeId },
      select: { toPersonalFile: true },
    });
    return !!type?.toPersonalFile;
  }

  /**
   * Имя файла в реестре. Расширение и пометка «(подписано)» — про ПОДШИВАЕМЫЙ
   * файл, а не про карточку: их разводит вызывающий, потому что только он знает,
   * какой из трёх файлов документа сейчас кладёт (бланк, отпечаток или штамп).
   * Выводить это из сравнений с `doc.fileId` нельзя: у docx-документа `pdfFileId`
   * тоже не равен `fileId`, и обе половины подписи получались неверными.
   */
  private fileName(
    doc: { number: string | null; title: string; builderDoc?: unknown; fileId?: string | null; pdfFileId?: string | null },
    opts: { stamped?: boolean; pdf?: boolean } = {},
  ): string {
    const base = doc.number ? `${doc.number} ${doc.title}` : doc.title;
    // По умолчанию подшивается сам `fileId` карточки: у builder-документа это уже
    // PDF, у ЗАГРУЖЕННОГО PDF отпечаток совпадает с файлом, остальное — .docx бланка.
    const isPdf =
      opts.pdf ?? (!!doc.builderDoc || (!!doc.pdfFileId && doc.pdfFileId === doc.fileId));
    const suffix = opts.stamped ? ' (подписано)' : '';
    return `${base}${suffix}.${isPdf ? 'pdf' : 'docx'}`.replace(/[\\/:*?"<>|]/g, '-');
  }
}

export { DocumentsService };
