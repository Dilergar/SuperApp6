import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DEFAULT_DOC_NUMBER_FORMAT,
  DOC_EDITABLE_STATUSES,
  DOC_GRANT_PRINCIPAL_TYPES,
  DOC_EXTERNAL_DEFAULT_TTL_DAYS,
  DOC_IN_WORK_STATUSES,
  DOC_LIMITS,
  DOC_ROUTABLE_STATUSES,
  ORG_DOCUMENT_REF_TYPE,
  SIGN_REQUEST_REF_TYPE,
  WORKSPACE_ROLE_RANK,
  buildShareLinkUrl,
  buildSignLinkSmsText,
  maskPhone,
  expandDocFormValues,
  formatDocNumber,
  isDocDateRangeValue,
  emptyBuilderDoc,
  type BuilderDoc,
  type CounterpartyLiteDto,
  type CreateDocTemplateInput,
  type CreateDocTypeInput,
  type CreateFreeOrgDocumentInput,
  type CreateOrgDocumentInput,
  type CreateUploadedOrgDocumentInput,
  type DocCategory,
  type DocFormFieldDto,
  type DocStatus,
  type DocTemplateDto,
  type AvailableTemplateDto,
  type DocTemplateGrantDto,
  type DocTemplateGrantInput,
  type OrgDocumentContactRef,
  type OrgDocumentExternalDto,
  type OrgDocumentListDto,
  type DocTypeDto,
  type ListOrgDocumentsInput,
  type OrgDocumentDto,
  type CreateShareLinkInput,
  type SendExternalOrgDocumentInput,
  type SignActStatus,
  type SignLevel,
  type SignRequestStatus,
  type UpdateDocTemplateInput,
  type UpdateDocTypeInput,
  type UpdateOrgDocumentInput,
  type WorkspaceRole,
} from '@superapp/shared';
import type { Prisma } from '@prisma/client';
import { DatabaseService } from '../../shared/database/database.service';
import { trustedFetch } from '../../shared/http';
import { RolesService } from '../../core/roles/roles.service';
import { AccessService } from '../../core/access/access.service';
import { principalSubjectRelation } from '../../core/access/access-schema';
import { DocsService } from '../../core/docs/docs.service';
import { TemplateRenderService } from '../../core/templates/template-render.service';
import { TemplateFieldRegistry } from '../../core/templates/template-field.registry';
import { PdfRenderService } from '../../core/templates/pdf-render.service';
import { renderBuilderHtml, checkBuilderDoc } from '../../core/templates/builder-render.driver';
import { ApprovalsService } from '../../core/approvals/approvals.service';
import { SignService } from '../../core/sign/sign.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { JobsService } from '../../core/jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CounterpartiesService } from '../counterparties/counterparties.service';
import { FilesService } from '../../core/files/files.service';
import { ShareLinksService } from '../../core/share-links/share-links.service';
import { SmsOutboundService } from '../../core/verify/sms-outbound.service';
import { isDevEnv } from '../../shared/config/env.validation';
import { fullName } from '../../shared/utils/user-name';
import {
  DOCUMENTS_FILE_JOB,
  DOCUMENTS_GENERATE_JOB,
  DOCUMENTS_PDF_JOB,
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
  docGenKey,
} from './documents.constants';

const WS_CONTEXT = 'workspace';

/**
 * Маршрут документа ведут «Процессы». Ссылка ленивая (как 'ShopService' у Задачника):
 * Процессы уже зависят от документов через свои ноды, и прямая инъекция замкнула бы цикл.
 */
export interface ProcessesStarter {
  startInstanceProgrammatic(
    definitionId: string,
    runAsUserId: string,
    variables: Record<string, unknown>,
    triggerType: 'event' | 'schedule' | 'webhook' | 'telegram',
    entryNodeId?: string,
  ): Promise<string | null>;
  /** Остановить маршрут отменённого документа (без гейтов сервиса Процессов) */
  cancelInstanceProgrammatic?(instanceId: string, byUserId: string): Promise<boolean>;
}

/**
 * Порт КЭДО (modules/hr): документ с `hrActionId` двигает машину кадрового
 * действия, а закрытый акт подписи и фиксация вручения рождают личную
 * запись-архив сотрудника. Разрешается лениво на bootstrap (DI_TOKENS.HrService).
 */
export interface HrPort {
  onDocumentSubmitted(hrActionId: string): Promise<void>;
  onDocumentWithdrawn(hrActionId: string): Promise<void>;
  onDocumentCancelled(hrActionId: string, documentId: string): Promise<void>;
  onDocumentResolved(hrActionId: string, outcome: 'approved' | 'rejected' | 'returned' | 'cancelled'): Promise<void>;
  onDocumentActFinished(
    documentId: string,
    info: { outcome: 'signed' | 'declined'; level: 'ecp' | 'pep'; signerUserId: string | null; signRequestId: string; certSubjectBin: string | null },
  ): Promise<void>;
  onDocumentDelivered(documentId: string): Promise<void>;
  /** Сторона документа ознакомилась с ним по шагу маршрута → личная запись-архив */
  onDocumentAcknowledged(documentId: string, userId: string): Promise<void>;
}

/**
 * Сервис «Документы» (B2B) — документооборот организации поверх готовых движков.
 *
 * Своего он держит немного: справочник ВИДОВ (нумерация, видимость, категория),
 * ШАБЛОНЫ (бланк + форма подачи) и КАРТОЧКИ документов. Всё остальное — чужое и
 * переиспользованное: файл и совместная правка — `core/docs`, заполнение бланка —
 * `core/templates`, сбор решений — `core/approvals`, маршрут — «Процессы», хранение
 * и папки — Диск, хроника — `core/chatter`, фон — `core/jobs`.
 *
 * Несущее правило сервиса: **всё, что делает система, стоит нодой на канвасе**.
 * Сервис не решает сам, когда присвоить номер и куда подшить, — это делают ноды
 * маршрута (`doc.register`, `doc.file`), а сервис даёт им системные методы.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly roles: RolesService,
    private readonly access: AccessService,
    private readonly docs: DocsService,
    private readonly templates: TemplateRenderService,
    private readonly fieldRegistry: TemplateFieldRegistry,
    private readonly pdfRender: PdfRenderService,
    private readonly chatter: ChatterService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
    private readonly approvals: ApprovalsService,
    private readonly sign: SignService,
    private readonly counterparties: CounterpartiesService,
    private readonly files: FilesService,
    private readonly shareLinks: ShareLinksService,
    private readonly smsOutbound: SmsOutboundService,
  ) {}

  /** Ставится на bootstrap модулем — см. DocumentsModule (разрыв цикла с Процессами). */
  private processes: ProcessesStarter | null = null;
  setProcessesService(svc: ProcessesStarter | null): void {
    this.processes = svc;
  }

  /**
   * КЭДО (modules/hr) — ленивое ребро тем же паттерном: hr импортирует документы,
   * обратное знание идёт через порт, поставленный на bootstrap. Все вызовы
   * best-effort: кадровая машина не имеет права уронить документооборот.
   */
  private hr: HrPort | null = null;
  setHrService(svc: HrPort | null): void {
    this.hr = svc;
  }

  /**
   * Сторона документа ознакомилась по шагу МАРШРУТА (зовёт approvals-провайдер
   * этого модуля из хука onDecided). Ознакомление кликом — юридический факт
   * (ст. 23 п. 2 пп. 6 ТК РК), и обещание экрана «Мои документы» («всё, с чем
   * ознакомитесь») обязано выполняться и для маршрутов, не только для кампаний.
   */
  async notifyHrAcknowledged(documentId: string, userId: string): Promise<void> {
    await this.hr?.onDocumentAcknowledged(documentId, userId).catch((e) => {
      this.logger.warn(`hr.onDocumentAcknowledged ${documentId}: ${(e as Error).message}`);
    });
  }

  /** Сообщить КЭДО о закрытом акте подписи (зовёт sign-провайдер этого модуля) */
  async notifyHrActFinished(
    documentId: string,
    info: { outcome: 'signed' | 'declined'; level: 'ecp' | 'pep'; signerUserId: string | null; signRequestId: string; certSubjectBin: string | null },
  ): Promise<void> {
    await this.hr?.onDocumentActFinished(documentId, info).catch((e) => {
      this.logger.warn(`hr.onDocumentActFinished ${documentId}: ${(e as Error).message}`);
    });
  }

  // ============================================================
  // Гейты
  // ============================================================

  private async roleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const roles = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    if (roles.length === 0) return null;
    return roles
      .map((r) => r.role as WorkspaceRole)
      .sort((a, b) => (WORKSPACE_ROLE_RANK[b] ?? 0) - (WORKSPACE_ROLE_RANK[a] ?? 0))[0];
  }

  /** Команда организации. Подрядчик изолирован — документооборот ему закрыт. */
  private async requireTeam(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const role = await this.roleOf(userId, workspaceId);
    if (!role) throw new ForbiddenException('Нет доступа к этой организации');
    if (role === 'contractor') throw new ForbiddenException('Подрядчику документы организации недоступны');
    return role;
  }

  /** Настройка сервиса — Менеджер+ (виды, шаблоны, нумерация, доступность). */
  private async requireManager(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const role = await this.requireTeam(userId, workspaceId);
    if ((WORKSPACE_ROLE_RANK[role] ?? 0) < WORKSPACE_ROLE_RANK.manager) {
      throw new ForbiddenException('Недостаточно прав (нужен Менеджер или выше)');
    }
    return role;
  }

  private isManager(role: WorkspaceRole | null): boolean {
    return !!role && (WORKSPACE_ROLE_RANK[role] ?? 0) >= WORKSPACE_ROLE_RANK.manager;
  }

  // ============================================================
  // Виды документов
  // ============================================================

  async listTypes(userId: string, workspaceId: string): Promise<DocTypeDto[]> {
    await this.requireTeam(userId, workspaceId);
    const rows = await this.db.docType.findMany({
      where: { workspaceId, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { templates: true } } },
    });
    return rows.map((r) => this.serializeType(r, r._count.templates));
  }

  async createType(userId: string, workspaceId: string, dto: CreateDocTypeInput): Promise<DocTypeDto> {
    await this.requireManager(userId, workspaceId);
    const count = await this.db.docType.count({ where: { workspaceId, archivedAt: null } });
    if (count >= DOC_LIMITS.maxTypesPerWorkspace) {
      throw new BadRequestException('Достигнут предел видов документов в организации');
    }
    const category = (dto.category ?? 'general') as DocCategory;
    // «В личное дело» — про сотрудника; у документа с контрагентом личного дела нет.
    if (category === 'external' && dto.toPersonalFile) {
      throw new BadRequestException('Документы с контрагентами не подшиваются в личное дело');
    }
    await this.assertTypeNameFree(workspaceId, dto.name);
    try {
      const row = await this.db.docType.create({
        data: {
          workspaceId,
          name: dto.name,
          category,
          numberFormat: dto.numberFormat ?? DEFAULT_DOC_NUMBER_FORMAT,
          visibility: dto.visibility ?? 'managers',
          // Кадровому виду по умолчанию ставим ЭЦП: ст. 33 ТК РК не оставляет
          // выбора, а «по умолчанию без подписи» означало бы, что забыть можно
          // молча. Внешнему (договоры) — ПЭП: достаточна по соглашению сторон
          // (ст. 47 ЦК) и работает у контрагента без ключа НУЦ; поднять до ЭЦП
          // можно явно. Снять требование тоже можно явно.
          signatureLevel:
            dto.signatureLevel ?? (category === 'hr' ? 'ecp' : category === 'external' ? 'pep' : 'none'),
          toPersonalFile: dto.toPersonalFile ?? false,
          specialDelivery: dto.specialDelivery ?? false,
          retentionYears: dto.retentionYears ?? null,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
      return this.serializeType(row, 0);
    } catch (err) {
      this.rethrowTypeNameConflict(err);
      throw err;
    }
  }

  /**
   * Имя вида свободно среди ЖИВЫХ видов организации. Проверка дружелюбная,
   * НАСТОЯЩАЯ гарантия — партиальный уникум `doc_types_workspace_name_live`
   * (lower(name), руками в миграции): папка реестра на Диске ключуется именем
   * вида, и одноимённые виды делили бы одну папку — вместе с её грантами. Вид
   * «команда» открывал бы команде уже подшитые документы вида «управляющие».
   */
  private async assertTypeNameFree(
    workspaceId: string,
    name: string,
    exceptTypeId?: string,
  ): Promise<void> {
    const taken = await this.db.docType.findFirst({
      where: {
        workspaceId,
        archivedAt: null,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptTypeId ? { id: { not: exceptTypeId } } : {}),
      },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException('Вид с таким названием уже есть — выберите другое имя');
    }
  }

  /** Гонку за имя проиграли на уникуме — тот же человеческий 409, что у проверки */
  private rethrowTypeNameConflict(err: unknown): void {
    if ((err as Prisma.PrismaClientKnownRequestError)?.code === 'P2002') {
      throw new ConflictException('Вид с таким названием уже есть — выберите другое имя');
    }
  }

  async updateType(
    userId: string,
    workspaceId: string,
    typeId: string,
    dto: UpdateDocTypeInput,
  ): Promise<DocTypeDto> {
    await this.requireManager(userId, workspaceId);
    const type = await this.typeOrThrow(workspaceId, typeId);
    // Смена категории на/с «С контрагентами» при живых документах запрещена:
    // у категорий разные пути (маршрут ↔ прямая отправка), и существующие
    // документы оказались бы на пути, которого для них не существует.
    if (
      dto.category !== undefined &&
      dto.category !== type.category &&
      (dto.category === 'external' || type.category === 'external')
    ) {
      const docs = await this.db.orgDocument.count({ where: { docTypeId: type.id } });
      if (docs > 0) {
        throw new BadRequestException(
          'У вида уже есть документы — категорию «С контрагентами» менять нельзя, заведите новый вид',
        );
      }
    }
    const nextCategory = (dto.category ?? type.category) as DocCategory;
    if (nextCategory === 'external' && (dto.toPersonalFile ?? type.toPersonalFile)) {
      throw new BadRequestException('Документы с контрагентами не подшиваются в личное дело');
    }
    if (dto.name !== undefined && dto.name !== type.name) {
      await this.assertTypeNameFree(workspaceId, dto.name, type.id);
    }
    try {
      const row = await this.db.docType.update({
        where: { id: type.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.category !== undefined ? { category: dto.category } : {}),
          ...(dto.numberFormat !== undefined ? { numberFormat: dto.numberFormat } : {}),
          ...(dto.visibility !== undefined ? { visibility: dto.visibility } : {}),
          ...(dto.signatureLevel !== undefined ? { signatureLevel: dto.signatureLevel } : {}),
          ...(dto.toPersonalFile !== undefined ? { toPersonalFile: dto.toPersonalFile } : {}),
          ...(dto.specialDelivery !== undefined ? { specialDelivery: dto.specialDelivery } : {}),
          ...(dto.retentionYears !== undefined ? { retentionYears: dto.retentionYears } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        },
        include: { _count: { select: { templates: true } } },
      });
      return this.serializeType(row, row._count.templates);
    } catch (err) {
      this.rethrowTypeNameConflict(err);
      throw err;
    }
  }

  /**
   * Вид уходит в архив, а не удаляется: на нём висят выданные номера и подписанные
   * документы — их история не может исчезнуть вместе со строкой справочника.
   *
   * Архив вида — про СПРАВОЧНИК: читать прошлое можно (см. `visibilityWhere`),
   * заводить новое нельзя. Вторую половину обеспечивает каскад на БЛАНКИ: и
   * `availableTemplates`, и `templateOrThrow` смотрят на `archivedAt` ШАБЛОНА, а не
   * вида, поэтому без каскада архивный вид продолжал принимать новые заявления —
   * он пропадал из справочника, но его шаблон оставался в «Подать заявление».
   * Архив вида терминален (PATCH архивного отклоняет `typeOrThrow`, ручки возврата
   * нет), так что расхождения «вид вернули, бланки остались архивными» быть не может.
   */
  async archiveType(userId: string, workspaceId: string, typeId: string): Promise<void> {
    await this.requireManager(userId, workspaceId);
    const type = await this.typeOrThrow(workspaceId, typeId);
    const live = await this.db.orgDocument.count({
      // `sent` в списке обязателен: документ у контрагента — идущий процесс, и вид
      // под возвращающимся документом исчезать не должен (DOC_IN_WORK_STATUSES).
      where: { docTypeId: type.id, status: { in: [...DOC_IN_WORK_STATUSES] } },
    });
    if (live > 0) throw new BadRequestException('Есть документы этого вида в работе — сначала завершите их');
    const archivedAt = new Date();
    await this.db.$transaction(async (tx) => {
      await tx.docType.update({ where: { id: type.id }, data: { archivedAt } });
      await tx.docTemplate.updateMany({
        where: { docTypeId: type.id, archivedAt: null },
        data: { archivedAt },
      });
    });
  }

  // ============================================================
  // Шаблоны
  // ============================================================

  async listTemplates(userId: string, workspaceId: string): Promise<DocTemplateDto[]> {
    await this.requireManager(userId, workspaceId);
    const rows = await this.db.docTemplate.findMany({
      where: { workspaceId, archivedAt: null },
      orderBy: [{ createdAt: 'desc' }],
      include: { docType: true },
    });
    const routed = await this.routedTemplateIds(workspaceId);
    return rows.map((r) => this.serializeTemplate(r, r.docType, routed.has(r.id)));
  }

  async createTemplate(
    userId: string,
    workspaceId: string,
    dto: CreateDocTemplateInput,
  ): Promise<DocTemplateDto> {
    await this.requireManager(userId, workspaceId);
    const type = await this.typeOrThrow(workspaceId, dto.docTypeId);
    const count = await this.db.docTemplate.count({ where: { docTypeId: type.id, archivedAt: null } });
    if (count >= DOC_LIMITS.maxTemplatesPerType) {
      throw new BadRequestException('Слишком много шаблонов этого вида');
    }

    const kind = dto.kind ?? 'docx';
    if (kind === 'builder' && dto.fileId) {
      throw new BadRequestException('У блочного шаблона не бывает Word-бланка');
    }
    if (kind === 'docx' && dto.builderDoc) {
      throw new BadRequestException('Блоки конструктора — только у блочного шаблона');
    }

    // Бланк: файл уже загружен обычным путём движка файлов. Оживление в документ
    // core/docs делаем сразу — бланк правится тем же редактором, что и всё остальное.
    let documentId: string | null = null;
    if (dto.fileId) {
      await this.assertOwnFile(userId, dto.fileId);
      if (this.docs.enabled) {
        const doc = await this.docs.createFromFile(userId, { fileId: dto.fileId, title: dto.name });
        documentId = doc.id;
      }
    }

    const row = await this.db.docTemplate.create({
      data: {
        workspaceId,
        docTypeId: type.id,
        name: dto.name,
        description: dto.description ?? null,
        kind,
        builderDoc: kind === 'builder' ? ((dto.builderDoc ?? emptyBuilderDoc()) as object) : undefined,
        fileId: dto.fileId ?? null,
        documentId,
        fields: (dto.fields ?? []) as object,
        selfService: dto.selfService ?? false,
        createdById: userId,
      },
      include: { docType: true },
    });
    return this.serializeTemplate(row, row.docType, false);
  }

  async updateTemplate(
    userId: string,
    workspaceId: string,
    templateId: string,
    dto: UpdateDocTemplateInput,
  ): Promise<DocTemplateDto> {
    await this.requireManager(userId, workspaceId);
    const tpl = await this.templateOrThrow(workspaceId, templateId);

    if (dto.fileId && tpl.kind === 'builder') {
      throw new BadRequestException('У блочного шаблона не бывает Word-бланка');
    }
    // Правка блоков — только у блочного шаблона (у docx бланк живёт файлом)
    if (dto.builderDoc && tpl.kind !== 'builder') {
      throw new BadRequestException('Блоки конструктора — только у блочного шаблона');
    }

    // Бланк прикрепляется ОДИН раз: у шаблона с историей подач подменять бланк нельзя
    // (иначе поданные документы ссылались бы на текст, которого никто не видел).
    let documentId: string | null = null;
    if (dto.fileId) {
      if (tpl.fileId) throw new BadRequestException('У шаблона уже есть бланк — создайте новый шаблон');
      await this.assertOwnFile(userId, dto.fileId);
      if (this.docs.enabled) {
        const doc = await this.docs.createFromFile(userId, { fileId: dto.fileId, title: dto.name ?? tpl.name });
        documentId = doc.id;
      }
    }

    const row = await this.db.docTemplate.update({
      where: { id: tpl.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.fields !== undefined ? { fields: dto.fields as object } : {}),
        ...(dto.selfService !== undefined ? { selfService: dto.selfService } : {}),
        ...(dto.builderDoc !== undefined ? { builderDoc: dto.builderDoc as object } : {}),
        ...(dto.fileId ? { fileId: dto.fileId, ...(documentId ? { documentId } : {}) } : {}),
      },
      include: { docType: true },
    });
    const routed = await this.routedTemplateIds(workspaceId);
    return this.serializeTemplate(row, row.docType, routed.has(row.id));
  }

  /**
   * Публикация шаблона. Проверяем ровно то, без чего подача сломается у сотрудника:
   * бланк на месте и поля формы объявлены. Компиляцию тегов бланка проверяет
   * конструктор (Этап 5) — она требует байтов файла и делается при сохранении бланка.
   */
  async publishTemplate(userId: string, workspaceId: string, templateId: string): Promise<DocTemplateDto> {
    await this.requireManager(userId, workspaceId);
    const tpl = await this.templateOrThrow(workspaceId, templateId);
    if (tpl.kind === 'builder') {
      const builderDoc = tpl.builderDoc as BuilderDoc | null;
      // «Пустой» — это и свежий лист с одним пустым абзацем: длина blocks тут не критерий
      const hasContent = (builderDoc?.blocks ?? []).some(
        (b) => !('content' in b) || (Array.isArray(b.content) && b.content.length > 0),
      );
      if (!builderDoc || !hasContent) {
        throw new BadRequestException('Бланк пустой — соберите документ в конструкторе');
      }
      // Аналог компилятора docx-пути: чипы сверяются с реестром полей и формой подачи.
      // Период дат разворачивается в плоские ключи — они тоже законные пути чипов.
      const formKeys = ((tpl.fields ?? []) as unknown as DocFormFieldDto[]).flatMap((f) =>
        f.kind === 'daterange' ? [f.key, `${f.key} С`, `${f.key} По`, `${f.key} Дней`] : [f.key],
      );
      const issues = checkBuilderDoc(builderDoc, (p) => this.fieldRegistry.isKnownPath(p), formKeys);
      if (issues.length) {
        throw new BadRequestException({
          message: `Бланк не готов к публикации: ${issues[0].message}${issues.length > 1 ? ` (и ещё ${issues.length - 1})` : ''}`,
          errors: issues.map((i) => ({ field: i.tag ?? '', message: i.message })),
        });
      }
    } else if (!tpl.fileId) {
      throw new BadRequestException('У шаблона нет бланка — загрузите файл документа');
    }
    const row = await this.db.docTemplate.update({
      where: { id: tpl.id },
      data: { status: 'published', version: { increment: tpl.status === 'published' ? 0 : 1 } },
      include: { docType: true },
    });
    const routed = await this.routedTemplateIds(workspaceId);
    return this.serializeTemplate(row, row.docType, routed.has(row.id));
  }

  // ---- кому доступен шаблон (гранты core/access) ----

  async listGrants(userId: string, workspaceId: string, templateId: string): Promise<DocTemplateGrantDto[]> {
    await this.requireManager(userId, workspaceId);
    const tpl = await this.templateOrThrow(workspaceId, templateId);
    const rows = await this.db.relationTuple.findMany({
      where: { resourceType: 'doc_template', resourceId: tpl.id, relation: 'requester' },
    });
    // Дедуп: у грантов, записанных до починки `subjectRelation`, есть вторая форма
    // с пустым отношением — человеку это один и тот же доступ, а не два.
    const unique = [...new Map(rows.map((r) => [`${r.subjectType}:${r.subjectId}`, r])).values()];
    // Подпись — ИМЯ получателя, а не вид принципала: список из пяти чипов «Сотрудник,
    // Сотрудник, Отдел» не даёт снять доступ у нужного, и крестик жмут наугад.
    const labels = await this.principalLabels(unique.map((r) => ({ type: r.subjectType, id: r.subjectId })));
    return unique.map((r) => ({
      // principal_type в БД — колонка String; перечисление живёт в коде.
      principalType: r.subjectType as DocTemplateGrantDto['principalType'],
      principalId: r.subjectId,
      label: labels.get(`${r.subjectType}:${r.subjectId}`) ?? null,
    }));
  }

  /** Имена получателей грантов одним заходом на тип (человек, отдел, должность, филиал) */
  private async principalLabels(
    principals: { type: string; id: string }[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const byType = new Map<string, string[]>();
    for (const p of principals) byType.set(p.type, [...(byType.get(p.type) ?? []), p.id]);

    const users = byType.get('user') ?? [];
    if (users.length) {
      const names = await this.namesOf(users);
      for (const [id, name] of names) out.set(`user:${id}`, name);
    }
    const load = async (
      type: 'department' | 'position' | 'branch',
      table: { findMany(args: unknown): Promise<{ id: string; name: string }[]> },
    ): Promise<void> => {
      const ids = byType.get(type) ?? [];
      if (!ids.length) return;
      const rows = await table.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      for (const r of rows) out.set(`${type}:${r.id}`, r.name);
    };
    await load('department', this.db.staffDepartment as never);
    await load('position', this.db.staffPosition as never);
    await load('branch', this.db.staffBranch as never);
    return out;
  }

  async addGrant(
    userId: string,
    workspaceId: string,
    templateId: string,
    dto: DocTemplateGrantInput,
  ): Promise<void> {
    await this.requireManager(userId, workspaceId);
    const tpl = await this.templateOrThrow(workspaceId, templateId);
    await this.assertPrincipalOfWorkspace(workspaceId, dto);
    await this.access.grant({
      resourceType: 'doc_template',
      resourceId: tpl.id,
      relation: 'requester',
      subjectType: dto.principalType,
      subjectId: dto.principalId,
      // БЕЗ отношения грант отделу, должности и филиалу не совпадает НИ С КЕМ:
      // `principalsOf` отдаёт принципалы вида `department:<id>#member`, а не голый id.
      // Пока его здесь не было, «выдать шаблон отделу» тихо не работало вовсе.
      subjectRelation: principalSubjectRelation(dto.principalType),
    });
  }

  async removeGrant(
    userId: string,
    workspaceId: string,
    templateId: string,
    principalType: string,
    principalId: string,
  ): Promise<void> {
    await this.requireManager(userId, workspaceId);
    const tpl = await this.templateOrThrow(workspaceId, templateId);
    // Тип принципала приезжает из ПУТИ, то есть мимо Zod-схемы тела — сверяем сами.
    if (!DOC_GRANT_PRINCIPAL_TYPES.includes(principalType)) {
      throw new BadRequestException('Неизвестный получатель доступа');
    }
    await this.access.revoke({
      resourceType: 'doc_template',
      resourceId: tpl.id,
      relation: 'requester',
      subjectType: principalType,
      subjectId: principalId,
      subjectRelation: principalSubjectRelation(principalType),
    });
    // Хвост от старой ошибки: гранты, записанные без отношения, ничего не давали, но
    // и не исчезали — снятие доступа обязано убирать обе формы записи.
    await this.access.revoke({
      resourceType: 'doc_template',
      resourceId: tpl.id,
      relation: 'requester',
      subjectType: principalType,
      subjectId: principalId,
    });
  }

  /**
   * «Что я могу подать». Выборка под правами — ОДНИМ условием по выданным id
   * (`grantSetFor`), а не `check()` в цикле по шаблонам: это тот самый массовый
   * читающий путь, ради которого второй путь движка прав и заведён.
   */
  async availableTemplates(userId: string, workspaceId: string): Promise<AvailableTemplateDto[]> {
    await this.requireTeam(userId, workspaceId);
    const grants = await this.access.grantSetFor(userId, 'doc_template');
    const grantedIds = grants.granted.get('requester') ?? [];
    if (grantedIds.length === 0) return [];
    const rows = await this.db.docTemplate.findMany({
      where: {
        workspaceId,
        archivedAt: null,
        status: 'published',
        selfService: true,
        id: { in: grantedIds },
      },
      orderBy: { name: 'asc' },
      include: { docType: true },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      docTypeId: r.docTypeId,
      docTypeName: r.docType.name,
      category: r.docType.category as DocCategory,
      kind: (r.kind ?? 'docx') as 'docx' | 'builder',
      fields: (r.fields ?? []) as unknown as DocFormFieldDto[],
    }));
  }

  // ============================================================
  // Превью конструктора: «Пример с данными» — настоящий PDF
  // ============================================================

  /**
   * PDF-превью блочного шаблона глазами сотрудника: живые данные организации,
   * пример-сотрудник — сам смотрящий, поля формы — образцы. Абсолютная честность:
   * тот же рендер и тот же Chromium, что соберут настоящий документ.
   */
  async previewTemplatePdf(
    userId: string,
    workspaceId: string,
    templateId: string,
    override?: BuilderDoc,
  ): Promise<Buffer> {
    await this.requireManager(userId, workspaceId);
    const tpl = await this.templateOrThrow(workspaceId, templateId);
    if (tpl.kind !== 'builder') throw new BadRequestException('Превью конструктора — только у блочного шаблона');
    const builderDoc = override ?? (tpl.builderDoc as BuilderDoc | null);
    if (!builderDoc) throw new BadRequestException('Бланк пустой');
    if (!this.pdfRender.enabled) {
      throw new BadRequestException('PDF-рендер выключен — поднимите профиль pdf (GOTENBERG_URL)');
    }

    const fields = (tpl.fields ?? []) as unknown as DocFormFieldDto[];
    const sample: Record<string, unknown> = {};
    for (const f of fields) sample[f.key] = this.sampleFieldValue(f);
    const type = await this.typeOrThrow(workspaceId, tpl.docTypeId);
    const values = {
      ...expandDocFormValues(sample),
      Документ: {
        Название: tpl.name,
        Номер: this.sampleNumber(type.numberFormat),
        Дата: new Date(),
      },
      ...(await this.templates.resolveContextValues({
        workspaceId,
        subjectUserId: userId,
        actorUserId: userId,
      })),
    };
    const logoDataUri = await this.builderLogo(workspaceId, builderDoc);
    const { html } = renderBuilderHtml(builderDoc, values, {
      strict: false,
      title: tpl.name,
      assets: { logoDataUri },
    });
    return this.pdfRender.htmlToPdf(html, { footer: builderDoc.page?.footer ?? 'pageNumbers' });
  }

  /** PDF-превью блочного ДОКУМЕНТА: текущие блоки + его собственные данные */
  async previewDocumentPdf(userId: string, documentId: string, override?: BuilderDoc): Promise<Buffer> {
    const row = await this.documentOrThrow(documentId);
    const role = await this.requireTeam(userId, row.workspaceId);
    if (!(await this.canView(userId, row, role))) throw new ForbiddenException('Нет доступа к документу');
    const builderDoc = override ?? (row.builderDoc as BuilderDoc | null);
    if (!builderDoc) throw new BadRequestException('У этого документа нет блочного тела');
    // Свежие блоки шлёт только тот, кто вправе их править
    if (override && !this.canEdit(userId, row, role)) throw new ForbiddenException('Документ на маршруте — правка закрыта');
    if (!this.pdfRender.enabled) {
      throw new BadRequestException('PDF-рендер выключен — поднимите профиль pdf (GOTENBERG_URL)');
    }
    const fieldsBag = (row.fields ?? {}) as Record<string, unknown>;
    const values = {
      ...expandDocFormValues(fieldsBag),
      Документ: {
        Название: row.title,
        Номер: row.number ?? '',
        Дата: row.createdAt,
      },
      ...(await this.templates.resolveContextValues({
        workspaceId: row.workspaceId,
        subjectUserId: row.subjectUserId ?? undefined,
        actorUserId: row.createdById,
        counterpartyId: row.counterpartyId ?? undefined,
        counterpartyContactId: row.counterpartyContactId ?? undefined,
      })),
    };
    const logoDataUri = await this.builderLogo(row.workspaceId, builderDoc);
    const { html } = renderBuilderHtml(builderDoc, values, {
      strict: false,
      title: row.title,
      assets: { logoDataUri },
    });
    return this.pdfRender.htmlToPdf(html, { footer: builderDoc.page?.footer ?? 'pageNumbers' });
  }

  /** Образец значения поля формы для превью шаблона */
  private sampleFieldValue(f: DocFormFieldDto): unknown {
    switch (f.kind) {
      case 'date':
        return new Date();
      case 'daterange': {
        const from = new Date();
        const to = new Date(from.getTime() + 13 * 86_400_000);
        const iso = (d: Date) => d.toISOString().slice(0, 10);
        return { from: iso(from), to: iso(to) };
      }
      case 'number':
        return 10;
      case 'select':
        return f.options?.[0]?.value ?? '';
      default:
        return `(${f.label})`;
    }
  }

  /** Пример номера по формату вида: «ЗАЯВ-{ГГГГ}-{NNN}» → «ЗАЯВ-2026-001» */
  private sampleNumber(numberFormat: string | null): string {
    return formatDocNumber(numberFormat ?? DEFAULT_DOC_NUMBER_FORMAT, 1, new Date());
  }

  /**
   * Лого для шапки-бланка — data:URI (Chromium в контейнере наружу не ходит).
   * Тянем ТОЛЬКО свои публичные файлы (`/public-files/` нашего API): произвольный
   * URL из настроек организации серверу качать нельзя — SSRF. Метод без гейта —
   * зовут превью (после своих проверок) и джоб сборки.
   */
  async builderLogo(workspaceId: string, builderDoc: BuilderDoc): Promise<string | null> {
    const wantsLogo = builderDoc.blocks.some((b) => b.type === 'requisites' && b.props?.showLogo !== false);
    if (!wantsLogo) return null;
    const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { logo: true } });
    const logo = ws?.logo ?? '';
    if (!logo.includes('/public-files/')) return null;
    const apiBase = (process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3001}`).replace(/\/+$/, '');
    const url = logo.startsWith('http') ? logo : `${apiBase}${logo.startsWith('/') ? '' : '/'}${logo}`;
    if (!url.startsWith(apiBase)) return null;
    try {
      const res = await trustedFetch(url, {}, { timeoutMs: 5000, origin: 'self' });
      if (!res.ok) return null;
      const mime = res.headers.get('content-type') ?? 'image/png';
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 1024 * 1024) return null;
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  }

  // ============================================================
  // Документы
  // ============================================================

  async createDocument(
    userId: string,
    workspaceId: string,
    dto: CreateOrgDocumentInput,
  ): Promise<OrgDocumentDto> {
    await this.requireTeam(userId, workspaceId);
    const tpl = await this.templateOrThrow(workspaceId, dto.templateId);
    if (tpl.status !== 'published') throw new BadRequestException('Шаблон ещё не опубликован');

    // Право подать: либо шаблон выдан мне (самообслуживание), либо я управляющий и
    // завожу документ на сотрудника. Проверяется ровно здесь — движок шаблонов и
    // движок файлов про «кому можно подать» не знают ничего.
    const role = await this.roleOf(userId, workspaceId);
    const grants = await this.access.grantSetFor(userId, 'doc_template');
    const mine = (grants.granted.get('requester') ?? []).includes(tpl.id);
    if (!mine && !this.isManager(role)) {
      throw new ForbiddenException('Этот шаблон вам не выдан');
    }
    // «Сотрудник подаёт сам» — это гейт ПОДАЧИ, а не подсказка для списка. Пока он
    // проверялся только в `availableTemplates`, шаблон с выключенным тумблером всё
    // равно принимал прямой POST от любого, кому выдан грант.
    if (!this.isManager(role) && !tpl.selfService) {
      throw new ForbiddenException('По этому шаблону документ оформляет управляющий');
    }

    const type = await this.typeOrThrow(workspaceId, tpl.docTypeId);
    // У документа с контрагентом сотрудник-«сторона» — необязательный куратор,
    // а не суть документа: по умолчанию НЕ подставляем автора.
    const subjectUserId =
      type.category === 'external' ? (dto.subjectUserId ?? null) : (dto.subjectUserId ?? userId);
    await this.assertSubject(userId, workspaceId, role, subjectUserId);
    await this.assertCounterpartyBinding(
      workspaceId,
      type.category,
      dto.counterpartyId ?? null,
      dto.counterpartyContactId ?? null,
    );

    const fields = await this.sanitizeFields(dto.fields ?? {}, tpl.id);
    const created = await this.db.$transaction(async (tx) => {
      const row = await tx.orgDocument.create({
        data: {
          workspaceId,
          docTypeId: tpl.docTypeId,
          templateId: tpl.id,
          title: dto.title ?? tpl.name,
          status: 'draft',
          subjectUserId,
          counterpartyId: dto.counterpartyId ?? null,
          counterpartyContactId: dto.counterpartyContactId ?? null,
          createdById: userId,
          fields: fields as object,
          // СНИМОК блоков: правка шаблона после подачи не меняет поданное
          ...(tpl.kind === 'builder' && tpl.builderDoc ? { builderDoc: tpl.builderDoc as object } : {}),
        },
      });
      await this.chatter.log(tx, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: row.id,
        workspaceId,
        actorId: userId,
        actorName: await this.nameOf(userId),
        typeKey: 'org_document.created',
        payload: { title: row.title },
      });
      // Сборка .docx — фоном, в ТОЙ ЖЕ транзакции (transactional outbox): откат
      // создания карточки не оставит джоб, который потом не найдёт документ.
      await this.jobs.enqueue(tx, {
        type: DOCUMENTS_GENERATE_JOB,
        payload: { documentId: row.id },
        uniqueKey: docGenKey(row.id),
      });
      return row;
    });
    return this.get(userId, created.id);
  }

  /**
   * Свободный документ «с нуля» — конструктор без шаблона (служебка, письмо).
   * Создать может любой член команды; вид обязателен (нумерация, видимость,
   * подшивка держатся на нём), сторона проверяется как у документа по шаблону.
   */
  async createFreeDocument(
    userId: string,
    workspaceId: string,
    dto: CreateFreeOrgDocumentInput,
  ): Promise<OrgDocumentDto> {
    const role = await this.requireTeam(userId, workspaceId);
    const type = await this.typeOrThrow(workspaceId, dto.docTypeId);

    const subjectUserId =
      type.category === 'external' ? (dto.subjectUserId ?? null) : (dto.subjectUserId ?? userId);
    await this.assertSubject(userId, workspaceId, role, subjectUserId);
    await this.assertCounterpartyBinding(
      workspaceId,
      type.category,
      dto.counterpartyId ?? null,
      dto.counterpartyContactId ?? null,
    );

    const created = await this.db.$transaction(async (tx) => {
      const row = await tx.orgDocument.create({
        data: {
          workspaceId,
          docTypeId: type.id,
          templateId: null,
          title: dto.title,
          status: 'draft',
          subjectUserId,
          counterpartyId: dto.counterpartyId ?? null,
          counterpartyContactId: dto.counterpartyContactId ?? null,
          createdById: userId,
          fields: {},
          ...(dto.formFields ? { formFields: dto.formFields as object } : {}),
          builderDoc: (dto.builderDoc ?? emptyBuilderDoc()) as object,
        },
      });
      await this.chatter.log(tx, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: row.id,
        workspaceId,
        actorId: userId,
        actorName: await this.nameOf(userId),
        typeKey: 'org_document.created',
        payload: { title: row.title },
      });
      await this.jobs.enqueue(tx, {
        type: DOCUMENTS_GENERATE_JOB,
        payload: { documentId: row.id },
        uniqueKey: docGenKey(row.id),
      });
      return row;
    });
    return this.get(userId, created.id);
  }

  /**
   * ТРЕТИЙ путь создания — ГОТОВЫЙ файл (договор согласован в Word/PDF вне
   * платформы, сюда приходит на подпись и в реестр). Файл уже загружен обычным
   * путём движка файлов; здесь — привязка карточкой.
   *
   * PDF становится отпечатком сразу (`pdfFileId = fileId`); DOCX оживляется в
   * core/docs (правится общим редактором), отпечаток снимет rendition-путь.
   * Замена файла у такой карточки — не в v1: новый файл = новый документ.
   */
  async createUploadedDocument(
    userId: string,
    workspaceId: string,
    dto: CreateUploadedOrgDocumentInput,
  ): Promise<OrgDocumentDto> {
    const role = await this.requireTeam(userId, workspaceId);
    const type = await this.typeOrThrow(workspaceId, dto.docTypeId);

    const subjectUserId =
      type.category === 'external' ? (dto.subjectUserId ?? null) : (dto.subjectUserId ?? userId);
    await this.assertSubject(userId, workspaceId, role, subjectUserId);
    await this.assertCounterpartyBinding(
      workspaceId,
      type.category,
      dto.counterpartyId ?? null,
      dto.counterpartyContactId ?? null,
    );

    await this.assertOwnFile(userId, dto.fileId);
    const file = await this.db.fileObject.findUniqueOrThrow({
      where: { id: dto.fileId },
      select: { mime: true, name: true, profile: true },
    });
    // Уже карточка другого документа? Один файл — одна карточка: иначе вторая
    // карточка тихо делила бы правку и подписание с первой. Быстрый ответ — здесь,
    // НАСТОЯЩАЯ гарантия — уникум `org_documents_file_id_key` (P2002 ниже): проверка
    // чтением не переживает двойной клик, обе вставки успевают пройти до обеих.
    const taken = await this.db.orgDocument.findFirst({ where: { fileId: dto.fileId }, select: { id: true } });
    if (taken) throw new BadRequestException('Этот файл уже прикреплён к другому документу');
    // Профиль — строго `document` (его потолок 50 МБ и есть расчётный размер
    // конвейера): файл чужого профиля — двухгигабайтный drive_file, вложение
    // чата — утащил бы заморозку core/sign и джоб штампа за расчётные размеры.
    if (file.profile !== 'document') {
      throw new BadRequestException('Загрузите файл через окно «Загрузить готовый файл» — нужна загрузка профилем «Документ»');
    }
    // ФОРМАТ — только печатные: PDF и Word. Остальное (таблицы, фото, архивы)
    // документом-на-подпись не является.
    const isPdf = file.mime === PDF_MIME_TYPE;
    if (!isPdf && file.mime !== DOCX_MIME_TYPE) {
      throw new BadRequestException('Документом можно сделать только PDF или Word-файл (.docx)');
    }

    const title = dto.title ?? file.name.replace(/\.(pdf|docx)$/i, '');
    const created = await this.createUploadedRow(userId, workspaceId, dto, {
      typeId: type.id,
      title,
      subjectUserId,
      isPdf,
    });

    // DOCX оживляем в core/docs ПОСЛЕ транзакции (создание документа зовёт движок
    // с его собственными транзакциями — держать их внутри нашей нельзя).
    if (!isPdf && this.docs.enabled) {
      const live = await this.docs
        .createFromFile(userId, { fileId: dto.fileId, title })
        .catch((e) => {
          this.logger.warn(`оживление загруженного документа ${created.id}: ${(e as Error).message}`);
          return null;
        });
      if (live) {
        await this.db.orgDocument.update({ where: { id: created.id }, data: { documentId: live.id } });
        await this.requestPdf(created.id).catch(() => undefined);
      }
    }
    return this.get(userId, created.id);
  }

  /** Вставка карточки загруженного файла: уникум `file_id` → человеческий отказ */
  private async createUploadedRow(
    userId: string,
    workspaceId: string,
    dto: CreateUploadedOrgDocumentInput,
    ctx: { typeId: string; title: string; subjectUserId: string | null; isPdf: boolean },
  ) {
    const { typeId, title, subjectUserId, isPdf } = ctx;
    try {
      return await this.db.$transaction(async (tx) => {
        const row = await tx.orgDocument.create({
          data: {
            workspaceId,
            docTypeId: typeId,
            templateId: null,
            title,
            status: 'draft',
            subjectUserId,
            counterpartyId: dto.counterpartyId ?? null,
            counterpartyContactId: dto.counterpartyContactId ?? null,
            createdById: userId,
            fileId: dto.fileId,
            // PDF готов быть отпечатком сразу; у DOCX отпечаток снимет rendition
            pdfFileId: isPdf ? dto.fileId : null,
            fields: {},
          },
        });
        // Связь с карточкой В ТОЙ ЖЕ транзакции: она делает документ «местом» файла
        // со своими правилами видимости (scopedPlace) — и держит файл от реапа.
        await this.files.linkSystemInTx(tx, {
          fileId: dto.fileId,
          refType: ORG_DOCUMENT_REF_TYPE,
          refId: row.id,
          createdById: userId,
        });
        await this.chatter.log(tx, {
          refType: ORG_DOCUMENT_REF_TYPE,
          refId: row.id,
          workspaceId,
          actorId: userId,
          actorName: await this.nameOf(userId),
          typeKey: 'org_document.created',
          payload: { title: row.title },
        });
        return row;
      });
    } catch (err) {
      // Гонку за файл выиграл параллельный запрос — тот же отказ, что у проверки выше
      if ((err as Prisma.PrismaClientKnownRequestError)?.code === 'P2002') {
        throw new BadRequestException('Этот файл уже прикреплён к другому документу');
      }
      throw err;
    }
  }

  async list(userId: string, workspaceId: string, q: ListOrgDocumentsInput): Promise<OrgDocumentListDto> {
    const role = await this.requireTeam(userId, workspaceId);
    const where = await this.visibilityWhere(userId, workspaceId, role);
    const filters: Record<string, unknown>[] = [where];
    if (q.docTypeId) filters.push({ docTypeId: q.docTypeId });
    if (q.status) filters.push({ status: q.status });
    // Вкладка «С контрагентами» = category=external; фильтр по виду документа
    if (q.category) filters.push({ docType: { category: q.category } });
    if (q.counterpartyId) filters.push({ counterpartyId: q.counterpartyId });
    if (q.subjectUserId) filters.push({ subjectUserId: q.subjectUserId });
    if (q.createdById) filters.push({ createdById: q.createdById });
    if (q.search) {
      filters.push({
        OR: [
          { title: { contains: q.search, mode: 'insensitive' as const } },
          { number: { contains: q.search, mode: 'insensitive' as const } },
        ],
      });
    }
    if (q.from || q.to) {
      filters.push({
        createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) },
      });
    }

    const whereAll = { workspaceId, AND: filters };
    const [rows, total] = await Promise.all([
      this.db.orgDocument.findMany({
        where: whereAll,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        include: { docType: true, template: true },
      }),
      this.db.orgDocument.count({ where: whereAll }),
    ]);
    const [names, cpx] = await Promise.all([
      this.namesOf(rows.flatMap((r) => [r.subjectUserId, r.createdById])),
      this.counterpartyRefs(rows),
    ]);
    return {
      items: rows.map((r) => this.serializeDocument(r, r.docType, r.template, names, cpx)),
      total,
    };
  }

  async get(userId: string, documentId: string): Promise<OrgDocumentDto> {
    const row = await this.db.orgDocument.findUnique({
      where: { id: documentId },
      include: { docType: true, template: true },
    });
    if (!row) throw new NotFoundException('Документ не найден');
    const role = await this.requireTeam(userId, row.workspaceId);
    if (!(await this.canView(userId, row, role))) throw new ForbiddenException('Нет доступа к документу');
    const [names, cpx] = await Promise.all([
      this.namesOf([row.subjectUserId, row.createdById]),
      this.counterpartyRefs([row]),
    ]);
    const dto = this.serializeDocument(row, row.docType, row.template, names, cpx);
    // Заявку заводит НОДА маршрута, поэтому колонка карточки всегда пуста — спрашиваем
    // живую у движка решений: без неё с карточки не было пути к маршруту согласования.
    dto.approvalRequestId =
      row.approvalRequestId ?? (await this.approvals.activeRequestIdForRef(ORG_DOCUMENT_REF_TYPE, row.id));
    const isExternal = row.docType.category === 'external';
    const authorOrManager = row.createdById === userId || this.isManager(role);
    dto.can = {
      edit: this.canEdit(userId, row, role),
      // Ровно те статусы, которые принимает сам `submit`: пока здесь стоял только
      // 'draft', возвращённый на доработку документ правился, но отправить его было
      // нечем — кнопки не было, хотя ручка сработала бы. У external маршрута НЕТ —
      // его путь «Отправить контрагенту», и кнопка submit не показывается.
      submit:
        !isExternal &&
        this.canEdit(userId, row, role) &&
        DOC_EDITABLE_STATUSES.includes(row.status as DocStatus),
      cancel:
        authorOrManager && ['draft', 'in_review', 'rejected', 'declined_external'].includes(row.status),
      // Возврат в черновик — только пока по документу никто не решает; живую заявку
      // проверяем здесь же, чтобы кнопка не появлялась там, где ручка откажет.
      withdraw:
        authorOrManager &&
        row.status === 'in_review' &&
        !(await this.approvals.activeRequestIdForRef(ORG_DOCUMENT_REF_TYPE, row.id)),
      manage: this.isManager(role),
      // Внешний контур: номер печатается в тексте ДО отправки (в отличие от
      // кадрового приказа, где его присваивает нода «Регистрация» после подписи).
      assignNumber:
        isExternal && authorOrManager && !row.number && DOC_EDITABLE_STATUSES.includes(row.status as DocStatus),
      // Отправка контрагенту — Менеджер+ (решение продукта): это не подача заявления
      // о себе, а действие, которым организацию ОБЯЗЫВАЮТ договором. Черновик при
      // этом готовит кто угодно из команды — планка стоит на отправке, не на тексте.
      sendExternal:
        isExternal && this.isManager(role) && DOC_EDITABLE_STATUSES.includes(row.status as DocStatus),
      revokeExternal: isExternal && authorOrManager && row.status === 'sent',
      returnToDraft: isExternal && authorOrManager && row.status === 'declined_external',
      // КЭДО: фиксация вручения — виды со specialDelivery (ст. 61 п. 3 / ст. 65
      // ТК РК) И документы бумажного/гибридного режима (paperMode: подпись
      // работника заменяют печать и вручение), после подписания, пока вручение
      // не зафиксировано; Менеджер+.
      fixDelivery:
        (row.docType.specialDelivery || row.deliveryMode !== 'electronic') &&
        this.isManager(role) &&
        !row.deliveredAt &&
        ['signed', 'registered', 'active'].includes(row.status),
    };
    // Живая пересборка — вебу: кнопки, которые страж assertNotRebuilding отвергнет
    // («Отправить», «Отправить контрагенту»), карточка гасит заранее и опрашивает
    // себя, пока флаг не погаснет, — вместо красного тоста на честный клик.
    dto.rebuilding = await this.isRebuilding(row.id, { pdfRewritesFile: !!row.builderDoc }).catch(() => false);
    // Подписи под документом — блок «Подписи» на карточке. Право зрителя на
    // ПРЕДМЕТ проверено выше (canView), о чём движку и говорим: `viewAuthorized`
    // здесь несущий, а не оптимизация — иначе движок переспрашивает право у
    // своего резолвера, тот реализован как `documents.get`, и зритель team-вида
    // без роли в заявке замыкал кольцо get → summaryForRef → canViewRequest →
    // get: запрос висел до HTTP-таймаута, молотя БД.
    dto.sign = await this.sign
      .summaryForRef(userId, ORG_DOCUMENT_REF_TYPE, row.id, { viewAuthorized: true })
      .catch(() => null);
    // Внешний этап (только у «С контрагентами»): состояние доставки и подписания
    // второй стороной — право видеть уже подтверждено canView выше. Адрес ссылки
    // при этом остаётся у Менеджер+: он даёт ПОДПИСАТЬ, а не посмотреть.
    if (isExternal) {
      dto.external = await this.externalStage(row, { manager: this.isManager(role) }).catch(() => null);
    }
    return dto;
  }

  async updateDocument(
    userId: string,
    documentId: string,
    dto: UpdateOrgDocumentInput,
  ): Promise<OrgDocumentDto> {
    const row = await this.documentOrThrow(documentId);
    const role = await this.requireTeam(userId, row.workspaceId);
    if (!this.canEdit(userId, row, role)) {
      throw new ForbiddenException('Документ на маршруте — правка закрыта');
    }
    // ТА ЖЕ проверка стороны, что при создании. Пока её здесь не было, автор черновика
    // подставлял в PATCH любой uuid платформы, а сборка печатала в документ ИИН, адрес
    // и удостоверение этого человека — данные, закрытые от коллег по умолчанию.
    if (dto.subjectUserId !== undefined && dto.subjectUserId !== row.subjectUserId) {
      await this.assertSubject(userId, row.workspaceId, role, dto.subjectUserId);
    }
    // ТА ЖЕ проверка привязки контрагента, что при создании (одно определение).
    if (dto.counterpartyId !== undefined || dto.counterpartyContactId !== undefined) {
      const type = await this.db.docType.findUniqueOrThrow({
        where: { id: row.docTypeId },
        select: { category: true },
      });
      const nextCounterpartyId =
        dto.counterpartyId !== undefined ? dto.counterpartyId : row.counterpartyId;
      const nextContactId =
        dto.counterpartyContactId !== undefined ? dto.counterpartyContactId : row.counterpartyContactId;
      await this.assertCounterpartyBinding(row.workspaceId, type.category, nextCounterpartyId, nextContactId);
    }
    // Тело правится только у блочного документа (у docx тело живёт файлом core/docs)
    if (dto.builderDoc && !row.builderDoc) {
      throw new BadRequestException('У этого документа тело правится в редакторе файла');
    }
    // Свои поля — только у СВОБОДНОГО документа: у документа по шаблону форма
    // принадлежит шаблону, и правится она там (иначе две правды об одной форме).
    if (dto.formFields !== undefined && row.templateId) {
      throw new BadRequestException('Поля этого документа заданы шаблоном — измените их в шаблоне');
    }
    // Новое объявление применяем к значениям СРАЗУ: снятое поле не должно оставить
    // за собой висячее значение, которое всё ещё печатается в документе.
    const nextSpec = dto.formFields ?? (row.formFields as unknown);
    await this.db.orgDocument.update({
      where: { id: row.id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.fields !== undefined
          ? { fields: (await this.sanitizeFields(dto.fields, row.templateId, nextSpec)) as object }
          : {}),
        ...(dto.subjectUserId !== undefined ? { subjectUserId: dto.subjectUserId } : {}),
        ...(dto.counterpartyId !== undefined
          ? {
              counterpartyId: dto.counterpartyId,
              // Снят контрагент — контакт не переживает его (принадлежит ему)
              ...(dto.counterpartyId === null ? { counterpartyContactId: null } : {}),
            }
          : {}),
        ...(dto.counterpartyContactId !== undefined ? { counterpartyContactId: dto.counterpartyContactId } : {}),
        ...(dto.builderDoc !== undefined ? { builderDoc: dto.builderDoc as object } : {}),
        ...(dto.formFields !== undefined
          ? {
              formFields: dto.formFields as object,
              // Прежние значения пересеиваем новым объявлением
              fields: (await this.sanitizeFields(
                dto.fields ?? ((row.fields ?? {}) as Record<string, unknown>),
                null,
                dto.formFields,
              )) as object,
            }
          : {}),
      },
    });
    // Данные формы, тело, НАЗВАНИЕ (печатается в {Документ.Название} и шапке
    // конструктора) или КОНТРАГЕНТ поменялись — бланк пересобираем: иначе в
    // документе останется старое значение (у контрагента — чужие реквизиты в тегах
    // {Контрагент.*}), а человек будет уверен, что отправил новое.
    if (
      dto.title !== undefined ||
      dto.fields !== undefined ||
      dto.builderDoc !== undefined ||
      dto.formFields !== undefined ||
      dto.counterpartyId !== undefined ||
      dto.counterpartyContactId !== undefined
    ) {
      await this.requestGenerate(row.id);
    }
    return this.get(userId, row.id);
  }

  /**
   * Отправить на маршрут. Три вещи разом, и все три обязательны:
   * 1) правка закрывается (`readonly` + бамп эпохи токенов редактора) — предмет решения
   *    не должен меняться под руками согласующего;
   * 2) снимается PDF-отпечаток — его видит решающий и его же подпишет `core/sign`;
   * 3) запускается маршрут (если он нарисован) либо документ идёт сразу на подпись.
   */
  async submit(userId: string, documentId: string): Promise<OrgDocumentDto> {
    const row = await this.documentOrThrow(documentId);
    const role = await this.requireTeam(userId, row.workspaceId);
    if (!this.canEdit(userId, row, role)) throw new ForbiddenException('Документ уже отправлен');
    if (row.status !== 'draft' && row.status !== 'rejected') {
      throw new BadRequestException('Отправить можно только черновик');
    }
    // У документов «С контрагентами» маршрута НЕТ (v1): их путь прямой — кнопка
    // «Отправить контрагенту» на карточке (внутренние подписи собираются той же
    // заявкой). Пускать их на внутренний маршрут значило бы завести документ в
    // состояние, из которого не существует продолжения.
    const docType = await this.db.docType.findUniqueOrThrow({
      where: { id: row.docTypeId },
      select: { category: true },
    });
    if (docType.category === 'external') {
      throw new BadRequestException('Документ с контрагентом отправляется контрагенту с карточки документа');
    }
    if (!row.fileId) throw new BadRequestException('Документ ещё формируется — попробуйте через минуту');
    // Тот же страж, что у отправки контрагенту: замороженный предмет решения не
    // должен отставать от только что отредактированных полей.
    await this.assertNotRebuilding(row.id, { pdfRewritesFile: !!row.builderDoc });

    // Маршрут ищем ДО заморозки — но его отсутствие не запрещает подачу: в v1 это
    // законный сценарий (сначала заводят виды и шаблоны, маршруты рисуют потом), и
    // документ ждёт ручного решения управляющего. Чтобы это не было тупиком, у
    // подавшего есть «Вернуть в черновик» (`withdraw`), пока решение никто не начал.
    const trigger = await this.findRoute(row.workspaceId, row.templateId);

    const claimed = await this.db.orgDocument.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: 'in_review' },
    });
    if (claimed.count === 0) throw new BadRequestException('Документ уже отправлен');

    // Заморозка: контракт system* — право проверил вызывающий (мы, только что).
    // Именно `locked`, а не `readonly`: владелец docs-документа — это ПОДАТЕЛЬ, и
    // «только чтение» его самого не ограничивает (он же его обычно и включает).
    if (row.documentId) {
      await this.docs.systemSetMode(row.documentId, 'locked').catch((e) => {
        this.logger.error(`заморозка документа ${row.documentId}: ${(e as Error).message}`);
      });
    }
    await this.requestPdf(row.id).catch(() => undefined);

    await this.chatter
      .log(null, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: row.id,
        workspaceId: row.workspaceId,
        actorId: userId,
        actorName: await this.nameOf(userId),
        typeKey: 'org_document.submitted',
        payload: { title: row.title },
      })
      .catch(() => undefined);

    if (trigger) {
      await this.startRoute(row.id, userId, trigger).catch((e) => {
        this.logger.error(`запуск маршрута для ${row.id}: ${(e as Error).message}`);
      });
    }
    // КЭДО: приказ действия ушёл на маршрут → действие «на оформлении»
    if (row.hrActionId) {
      await this.hr?.onDocumentSubmitted(row.hrActionId).catch(() => undefined);
    }
    return this.get(userId, row.id);
  }

  /**
   * Вернуть документ в черновик, пока по нему НИКТО не начал решать.
   *
   * Без этой ручки отправка была билетом в один конец: маршрут не нарисован (законный
   * сценарий v1) — документ навсегда «На маршруте» с закрытой правкой, и единственным
   * выходом оставалась отмена, то есть подавать заново с нуля. Как только по документу
   * появилось живое решение, возврат закрыт: отзывать надо заявку, а не предмет.
   */
  async withdraw(userId: string, documentId: string): Promise<OrgDocumentDto> {
    const row = await this.documentOrThrow(documentId);
    const role = await this.requireTeam(userId, row.workspaceId);
    if (row.createdById !== userId && !this.isManager(role)) {
      throw new ForbiddenException('Вернуть в черновик может автор или Менеджер+');
    }
    if (row.status !== 'in_review') throw new BadRequestException('Документ не на маршруте');

    const pending = await this.approvals.activeRequestIdForRef(ORG_DOCUMENT_REF_TYPE, row.id);
    if (pending) {
      throw new BadRequestException('По документу уже идёт решение — отзовите заявку в «Ждут решения»');
    }
    if (row.processInstanceId && this.processes?.cancelInstanceProgrammatic) {
      await this.processes
        .cancelInstanceProgrammatic(row.processInstanceId, userId)
        .catch((e) => this.logger.error(`остановка маршрута ${row.processInstanceId}: ${(e as Error).message}`));
    }

    const claimed = await this.db.orgDocument.updateMany({
      where: { id: row.id, status: 'in_review' },
      data: { status: 'draft', processInstanceId: null },
    });
    if (claimed.count === 0) throw new BadRequestException('Документ только что изменился — обновите страницу');
    if (row.documentId) {
      await this.docs.systemSetMode(row.documentId, 'edit').catch(() => undefined);
    }
    await this.chatter
      .log(null, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: row.id,
        workspaceId: row.workspaceId,
        actorId: userId,
        actorName: await this.nameOf(userId),
        typeKey: 'org_document.withdrawn',
        payload: { title: row.title },
      })
      .catch(() => undefined);
    // КЭДО: приказ вернулся в черновик → и действие обратно в черновик
    if (row.hrActionId) {
      await this.hr?.onDocumentWithdrawn(row.hrActionId).catch(() => undefined);
    }
    return this.get(userId, row.id);
  }

  async cancel(userId: string, documentId: string): Promise<OrgDocumentDto> {
    const row = await this.documentOrThrow(documentId);
    const role = await this.requireTeam(userId, row.workspaceId);
    if (row.createdById !== userId && !this.isManager(role)) {
      throw new ForbiddenException('Отменить может автор или Менеджер+');
    }
    // `declined_external` отменяем тоже (контрагент отказал — документ закрывают);
    // из `sent` пути нет: сначала «Отозвать отправку», отмена под ногами у
    // подписывающего контрагента — это гонка, которую незачем разрешать.
    if (!['draft', 'in_review', 'rejected', 'declined_external'].includes(row.status)) {
      throw new BadRequestException('Этот документ уже нельзя отменить');
    }
    const claimed = await this.db.orgDocument.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: 'cancelled' },
    });
    if (claimed.count === 0) throw new BadRequestException('Документ только что изменился — обновите страницу');

    // Отмена обязана ОСТАНОВИТЬ маршрут. Пока этого не было, согласующий видел
    // документ в своей стопке и подписывал его: маршрут доходил до регистрации,
    // отменённый документ получал номер из книги и уезжал в личное дело.
    await this.approvals
      .cancelForRef(ORG_DOCUMENT_REF_TYPE, row.id)
      .catch((e) => this.logger.error(`отмена заявок документа ${row.id}: ${(e as Error).message}`));
    if (row.processInstanceId && this.processes?.cancelInstanceProgrammatic) {
      await this.processes
        .cancelInstanceProgrammatic(row.processInstanceId, userId)
        .catch((e) => this.logger.error(`отмена маршрута ${row.processInstanceId}: ${(e as Error).message}`));
    }
    // Правку возвращаем: документ больше никуда не идёт, и держать его закрытым не за чем.
    if (row.documentId) {
      await this.docs.systemSetMode(row.documentId, 'edit').catch(() => undefined);
    }

    await this.chatter
      .log(null, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: row.id,
        workspaceId: row.workspaceId,
        actorId: userId,
        actorName: await this.nameOf(userId),
        typeKey: 'org_document.cancelled',
        payload: { title: row.title },
      })
      .catch(() => undefined);
    // КЭДО: отменили ПРИКАЗ действия → действие отменяется (пакетные документы — нет)
    if (row.hrActionId) {
      await this.hr?.onDocumentCancelled(row.hrActionId, row.id).catch(() => undefined);
    }
    return this.get(userId, row.id);
  }

  // ============================================================
  // ВНЕШНИЙ ЭТАП (категория «С контрагентами»): отправка второй стороне
  // ============================================================

  /**
   * Файл документа сейчас ПЕРЕСОБИРАЕТСЯ? Живой джоб сборки бланка означает, что
   * текущие байты устарели: «Присвоить номер» и правка полей ставят пересборку
   * фоном и возвращают управление сразу, а заморозка (submit / отправка
   * контрагенту) берёт файл НЕМЕДЛЕННО. Без этого стража контрагент подписывал
   * договор с пустой графой номера, при том что в карточке и книге регистрации
   * номер уже стоял: обе стороны подписали один файл, и криптография расхождения
   * не видела — оно всплывало при сверке бумаг.
   *
   * PDF-джоб блокирует ТОЛЬКО builder-документы: у них он ПЕРЕЗАПИСЫВАЕТ сам
   * файл карточки из текущих блоков. У docx-документа тот же джоб лишь снимает
   * контентный отпечаток живого файла и содержимое не трогает — блокировать по
   * нему значило бы держать submit до получаса (у джоба бэкофф ретраев 30с+,
   * пока Collabora конвертирует), что сьют и поймал: возврат «на доработку» →
   * правка названия → повторная отправка упиралась в pdf-джоб ПЕРВОЙ отправки.
   * Несвежий отпечаток у docx закрыт другим замком: пересборка бланка обнуляет
   * `pdfFileId`, и отправка честно отвечает «отпечаток ещё формируется».
   */
  private async assertNotRebuilding(
    documentId: string,
    opts: { pdfRewritesFile: boolean },
  ): Promise<void> {
    if (await this.isRebuilding(documentId, opts)) {
      throw new BadRequestException('Документ ещё пересобирается — попробуйте через несколько секунд');
    }
  }

  /**
   * Живая пересборка содержимого? Тот же предикат, что у стража отправки, — он же
   * едет в DTO карточки (`rebuilding`): кнопки, которые страж отвергнет, веб гасит
   * заранее и опрашивает карточку, пока пересборка не дожуётся.
   */
  private async isRebuilding(
    documentId: string,
    opts: { pdfRewritesFile: boolean },
  ): Promise<boolean> {
    const types = opts.pdfRewritesFile
      ? [DOCUMENTS_GENERATE_JOB, DOCUMENTS_PDF_JOB]
      : [DOCUMENTS_GENERATE_JOB];
    const live = await this.db.job.findFirst({
      where: {
        type: { in: types },
        status: { in: ['available', 'executing'] },
        payload: { path: ['documentId'], equals: documentId },
      },
      select: { id: true },
    });
    return !!live;
  }

  /**
   * Перезаказать сборку содержимого (правка полей/тела/контрагента, присвоение
   * номера). Схлопывание пересборок: стабильный ключ вместо прежних `…:${Date.now()}`
   * — одноимённая постановка схлопывается об живой джоб. Но живой мог прочитать
   * данные ДО нашей правки — тогда (`inserted: false`) ставим ПАРНЫЙ ключ: рендер,
   * который гарантированно стартует после неё. Симметричный хвост — rerunIfStale
   * в обработчике (см. docGenKey в documents.constants.ts).
   */
  private async requestGenerate(documentId: string): Promise<void> {
    const { inserted } = await this.jobs.enqueue(null, {
      type: DOCUMENTS_GENERATE_JOB,
      payload: { documentId },
      uniqueKey: docGenKey(documentId),
    });
    if (!inserted) {
      await this.jobs.enqueue(null, {
        type: DOCUMENTS_GENERATE_JOB,
        payload: { documentId, rerun: true },
        uniqueKey: docGenKey(documentId, true),
        runAt: new Date(Date.now() + 1500),
      });
    }
  }

  /**
   * Отправить документ контрагенту. Делает разом: клеймит статус `sent`,
   * закрывает правку (`locked`), заводит заявку подписи (внутренние подписанты +
   * будущий гость; движковые уведомления об исходе подавлены — их шлём мы, с
   * контекстом документа), создаёт гостевую ссылку и — по желанию — SMS.
   *
   * Повторная отправка = всегда НОВАЯ заявка с НОВОЙ заморозкой («что видел =
   * что подписал»); частичные подписи прежнего раунда сгорают by design.
   */
  async sendToCounterparty(
    userId: string,
    documentId: string,
    dto: SendExternalOrgDocumentInput,
  ): Promise<OrgDocumentDto> {
    const row = await this.documentOrThrow(documentId);
    const role = await this.requireTeam(userId, row.workspaceId);
    const type = await this.db.docType.findUniqueOrThrow({ where: { id: row.docTypeId } });
    if (type.category !== 'external') {
      throw new BadRequestException('Отправка контрагенту — только у документов «С контрагентами»');
    }
    // Менеджер+ (решение продукта): отправка ОБЯЗЫВАЕТ организацию договором.
    // Правило «автор или Менеджер+» здесь не годится — оно пришло из кадрового
    // контура, где автор подаёт заявление О СЕБЕ; во внешнем автор-Стажёр,
    // которому нельзя даже править справочник контрагентов, отправлял бы договор
    // от имени организации и сам же подписывал его ПЭП. Черновик готовит кто
    // угодно из команды — планка стоит на отправке.
    if (!this.isManager(role)) {
      throw new ForbiddenException('Отправить контрагенту может Менеджер и выше');
    }
    if (!DOC_EDITABLE_STATUSES.includes(row.status as DocStatus)) {
      throw new BadRequestException('Отправить можно черновик (или возвращённый документ)');
    }
    if (!row.counterpartyId) {
      throw new BadRequestException('Сначала привяжите контрагента к документу');
    }
    // Контрагент жив ИМЕННО СЕЙЧАС: черновики архив справочника не блокируют,
    // поэтому между созданием и отправкой карточка могла уехать в архив — и
    // отправлять договор архивному так же нельзя, как заводить по нему новый.
    await this.counterparties.assertUsable(row.workspaceId, row.counterpartyId);
    // Уровень диктует ВИД; «без подписи» для двустороннего документа бессмыслен
    if (type.signatureLevel === 'none') {
      throw new BadRequestException('Вид документа не предполагает подписи — включите её в настройках вида');
    }
    const contact = await this.counterparties.assertContactUsable(row.counterpartyId, dto.counterpartyContactId);

    // Внутренние подписанты — живые члены команды (снимок проверяется сейчас)
    const signerIds = [...new Set(dto.internalSignerUserIds)];
    for (const signerId of signerIds) {
      const signerRole = await this.roleOf(signerId, row.workspaceId);
      if (!signerRole || signerRole === 'contractor') {
        throw new BadRequestException('Внутренний подписант должен работать в организации');
      }
    }

    // Замораживается ТЕКУЩИЙ файл — значит, он обязан быть актуальным: живая
    // пересборка (номер, поля, контрагент) должна доехать до байтов ДО заморозки.
    await this.assertNotRebuilding(row.id, { pdfRewritesFile: !!row.builderDoc });

    // Подписывается ОТПЕЧАТОК (то же правило, что у resolveSubject): его
    // отсутствие — честный отказ, а не подпись живого .docx.
    const subjectFileId = row.builderDoc ? row.fileId : row.pdfFileId;
    if (!subjectFileId) {
      await this.requestPdf(row.id).catch(() => undefined);
      throw new BadRequestException('PDF-отпечаток ещё формируется — попробуйте через минуту');
    }

    const expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : new Date(Date.now() + DOC_EXTERNAL_DEFAULT_TTL_DAYS * 86_400_000);
    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Срок подписания уже прошёл — выберите дату в будущем');
    }

    // Статус-клейм гасит двойную отправку (вторая вкладка проиграет здесь);
    // партиальный уникум свободной заявки — второй ремень на уровне БД.
    const claimed = await this.db.orgDocument.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: 'sent', counterpartyContactId: contact.id },
    });
    if (claimed.count === 0) throw new BadRequestException('Документ только что изменился — обновите страницу');

    // Заморозка правки: владелец файла — податель, `readonly` его не держит.
    if (row.documentId) {
      await this.docs.systemSetMode(row.documentId, 'locked').catch((e) => {
        this.logger.error(`заморозка документа ${row.documentId}: ${(e as Error).message}`);
      });
    }

    let requestId: string | null = null;
    let linkUrl: string | null = null;
    try {
      const request = await this.sign.createRequest(
        userId,
        {
          refType: ORG_DOCUMENT_REF_TYPE,
          refId: row.id,
          level: type.signatureLevel as SignLevel,
          signerUserIds: signerIds,
          expiresAt,
        },
        {
          suppressOutcomeNotify: true,
          // Акт второй стороны заводится СРАЗУ (на контактное лицо): без него
          // заявка закрывалась бы внутренними подписями, не дождавшись контрагента.
          guestSigner: { name: contact.name, phone: contact.phone },
        },
      );
      requestId = request.id;
      // Гостевая ссылка контрагенту: личность форсируют constraints движка
      // (requireIdentity), лимит открытий на подписных запрещён там же.
      //
      // Срок ссылки = сроку сбора подписей: иначе ссылка живёт вечно, и после
      // истечения заявки контрагент по ней открывает замороженный документ,
      // которого уже никто не ждёт.
      const link = await this.shareLinks.create(userId, {
        refType: SIGN_REQUEST_REF_TYPE,
        refId: request.id,
        label: contact.name,
        expiresAt,
      } as CreateShareLinkInput);
      linkUrl = link.url;
    } catch (e) {
      // Компенсация: заявка не завелась (гонка/партиальный уникум/сбой) —
      // документ возвращается в исходный статус, правка открывается.
      //
      // Заявку, которая УСПЕЛА завестись (упал следующий шаг — гостевая ссылка),
      // гасим тоже. Без этого она оставалась живой и свободной: партиальный
      // уникум `sign_requests_one_active_freeform` отбивал любую повторную
      // отправку, а `revokeExternal` до неё не дотягивался — он требует статуса
      // `sent`, которого у откаченного документа уже нет. Документ становился
      // неотправляемым, пока крон не закроет заявку по сроку, то есть до 30 суток.
      if (requestId) {
        const orphanId = requestId;
        await this.sign
          .cancelRequest(userId, orphanId)
          .catch((err) =>
            this.logger.error(`отмена осиротевшей заявки ${orphanId}: ${(err as Error).message}`),
          );
      }
      await this.db.orgDocument.updateMany({
        where: { id: row.id, status: 'sent' },
        data: { status: row.status },
      });
      if (row.documentId) await this.docs.systemSetMode(row.documentId, 'edit').catch(() => undefined);
      if ((e as { code?: string })?.code === 'P2002') {
        throw new BadRequestException('По документу уже идёт подписание — отзовите прежнюю отправку');
      }
      throw e;
    }

    // SMS — best-effort: ссылка копируема, и её недоставка не откатывает отправку
    if (dto.sendSms && contact.phone && linkUrl) {
      const orgName = (await this.db.workspace.findUnique({
        where: { id: row.workspaceId },
        select: { name: true },
      }))?.name ?? 'Организация';
      await this.smsOutbound
        .sendLink(row.workspaceId, contact.phone, buildSignLinkSmsText(orgName, linkUrl), {
          refKey: `org_document:${row.id}`,
        })
        .catch((e) => this.logger.warn(`SMS контрагенту по ${row.id}: ${(e as Error).message}`));
    }

    await this.chatter
      .log(null, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: row.id,
        workspaceId: row.workspaceId,
        actorId: userId,
        actorName: await this.nameOf(userId),
        typeKey: 'org_document.sent_external',
        payload: { title: row.title, contactSuffix: ` — ${contact.name}`, requestId },
      })
      .catch(() => undefined);
    return this.get(userId, row.id);
  }

  /**
   * Отозвать отправку: сбор подписей прекращается, гостевая ссылка гаснет,
   * документ возвращается в черновик. Уже поставленные подписи остаются
   * доказательствами (заявка `cancelled`), но документ они не закрывают.
   */
  async revokeExternal(userId: string, documentId: string): Promise<OrgDocumentDto> {
    const row = await this.documentOrThrow(documentId);
    const role = await this.requireTeam(userId, row.workspaceId);
    if (row.createdById !== userId && !this.isManager(role)) {
      throw new ForbiddenException('Отозвать отправку может автор или Менеджер+');
    }
    if (row.status !== 'sent') throw new BadRequestException('Документ не у контрагента');

    const request = await this.activeExternalRequest(row.id);
    if (request) {
      try {
        await this.sign.cancelRequest(userId, request.id);
      } catch {
        // Гонка: контрагент успел подписать/отказаться — статус документа уже
        // двигают хуки, отзыв опоздал.
        throw new BadRequestException('Подписание уже завершилось — обновите страницу');
      }
      await this.shareLinks.revokeAllForRefs(null, SIGN_REQUEST_REF_TYPE, [request.id]);
    }

    const claimed = await this.db.orgDocument.updateMany({
      where: { id: row.id, status: 'sent' },
      data: { status: 'draft' },
    });
    if (claimed.count === 0) throw new BadRequestException('Документ только что изменился — обновите страницу');
    if (row.documentId) await this.docs.systemSetMode(row.documentId, 'edit').catch(() => undefined);

    await this.chatter
      .log(null, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: row.id,
        workspaceId: row.workspaceId,
        actorId: userId,
        actorName: await this.nameOf(userId),
        typeKey: 'org_document.external_revoked',
        payload: { title: row.title },
      })
      .catch(() => undefined);
    return this.get(userId, row.id);
  }

  /** После отказа контрагента: документ дорабатывают — обратно в черновик */
  async returnToDraft(userId: string, documentId: string): Promise<OrgDocumentDto> {
    const row = await this.documentOrThrow(documentId);
    const role = await this.requireTeam(userId, row.workspaceId);
    if (row.createdById !== userId && !this.isManager(role)) {
      throw new ForbiddenException('Вернуть в черновик может автор или Менеджер+');
    }
    if (row.status !== 'declined_external') {
      throw new BadRequestException('Возврат в черновик — после отказа контрагента');
    }
    const claimed = await this.db.orgDocument.updateMany({
      where: { id: row.id, status: 'declined_external' },
      data: { status: 'draft' },
    });
    if (claimed.count === 0) throw new BadRequestException('Документ только что изменился — обновите страницу');
    if (row.documentId) await this.docs.systemSetMode(row.documentId, 'edit').catch(() => undefined);
    await this.chatter
      .log(null, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: row.id,
        workspaceId: row.workspaceId,
        actorId: userId,
        actorName: await this.nameOf(userId),
        typeKey: 'org_document.external_returned',
        payload: { title: row.title },
      })
      .catch(() => undefined);
    return this.get(userId, row.id);
  }

  /** Перепослать SMS со ссылкой (кулдаун и суточный потолок — у SMS-сервиса) */
  async resendExternalSms(userId: string, documentId: string): Promise<void> {
    const row = await this.documentOrThrow(documentId);
    const role = await this.requireTeam(userId, row.workspaceId);
    if (row.createdById !== userId && !this.isManager(role)) {
      throw new ForbiddenException('Отправить SMS может автор или Менеджер+');
    }
    if (row.status !== 'sent') throw new BadRequestException('Документ не у контрагента');
    const request = await this.activeExternalRequest(row.id);
    if (!request) throw new BadRequestException('Живой заявки на подпись нет — отправьте документ заново');
    const link = await this.db.shareLink.findFirst({
      where: { refType: SIGN_REQUEST_REF_TYPE, refId: request.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!link) throw new BadRequestException('Гостевая ссылка отозвана — отправьте документ заново');
    const contact = row.counterpartyContactId
      ? (await this.counterparties.contactRefsFor([row.counterpartyContactId])).get(row.counterpartyContactId)
      : null;
    if (!contact?.phone) throw new BadRequestException('У контактного лица нет номера телефона');
    const orgName = (await this.db.workspace.findUnique({
      where: { id: row.workspaceId },
      select: { name: true },
    }))?.name ?? 'Организация';
    await this.smsOutbound.sendLink(
      row.workspaceId,
      contact.phone,
      buildSignLinkSmsText(orgName, buildShareLinkUrl(process.env.WEB_URL || 'http://localhost:3000', link.token)),
      { refKey: `org_document:${row.id}` },
    );
  }

  // ---- системные пути внешнего этапа (зовут хуки движка подписи; права
  //      проверять некому — работают статус-гварды `updateMany WHERE status`) ----

  /**
   * Ключ дедупа исхода внешнего этапа. РАУНД, а не документ: повторная отправка
   * после доработки — это новая заявка и новый исход, и ключ, собранный из одного
   * documentId, гасил бы уведомление о каждом следующем круге как «уже было».
   */
  private outcomeDedupKey(kind: string, documentId: string, requestId?: string | null): string {
    return `docext:${kind}:${requestId ?? documentId}`;
  }

  /** Все стороны подписали: sent → signed + подшивка штампованной копии в реестр */
  async externalMarkSigned(
    documentId: string,
    opts: { signerName?: string | null; requestId?: string | null } = {},
  ): Promise<void> {
    const row = await this.documentOrThrow(documentId).catch(() => null);
    if (!row) return;
    const won = await this.db.orgDocument.updateMany({
      where: { id: row.id, status: 'sent' },
      data: { status: 'signed', signedAt: new Date() },
    });
    if (won.count === 0) return;
    await this.notifications
      .notify(
        row.createdById,
        'document.counterparty_signed',
        { title: row.title, signerLabel: opts.signerName ?? '' },
        {
          actionUrl: `/workspaces/${row.workspaceId}/documents/${row.id}`,
          dedupKey: this.outcomeDedupKey('signed', row.id, opts.requestId),
        },
      )
      .catch(() => undefined);
    // Подшивка в реестр вида — штампованной копией (джоб дождётся её готовности)
    await this.jobs.enqueue(null, {
      type: DOCUMENTS_FILE_JOB,
      payload: { documentId: row.id },
      uniqueKey: `doc:file:${row.id}`,
    });
  }

  /**
   * Исход внешнего этапа: отказ контрагента, отказ СВОЕГО подписанта или
   * истечение срока.
   *
   * Отказы двух сторон разведены намеренно. Отказ контрагента — `declined_external`
   * («Контрагент отказал»): документ ждёт решения, дорабатывать его или закрыть.
   * Отказ своего подписанта — обычный `rejected` («Отклонён»): к контрагенту
   * документ вообще не ушёл, и называть это отказом второй стороны — прямая ложь
   * автору, который пойдёт выяснять отношения с тем, кто документ не открывал.
   */
  async externalResolve(
    documentId: string,
    outcome: 'declined' | 'declined_internal' | 'expired',
    opts: { reason?: string | null; signerName?: string | null; requestId?: string | null } = {},
  ): Promise<void> {
    const row = await this.documentOrThrow(documentId).catch(() => null);
    if (!row) return;
    if (outcome === 'declined_internal') {
      const won = await this.db.orgDocument.updateMany({
        where: { id: row.id, status: 'sent' },
        data: { status: 'rejected' },
      });
      if (won.count === 0) return;
      // Правка снова открыта: автору нечего было бы исправлять перед повторной отправкой
      if (row.documentId) await this.docs.systemSetMode(row.documentId, 'edit').catch(() => undefined);
      // Ссылку гасим: собирать по ней подпись уже не будут, а замороженный
      // документ по живому адресу читал бы всякий, кому его переслали.
      // Заявку к этому моменту движок уже закрыл (`declined`), поэтому запасной
      // поиск идёт по ПОСЛЕДНЕЙ свободной заявке, а не по живой.
      const requestId =
        opts.requestId ??
        (
          await this.db.signRequest.findFirst({
            where: { refType: ORG_DOCUMENT_REF_TYPE, refId: row.id, approvalStepId: null },
            orderBy: { createdAt: 'desc' },
            select: { id: true },
          })
        )?.id ??
        null;
      if (requestId) {
        await this.shareLinks
          .revokeAllForRefs(null, SIGN_REQUEST_REF_TYPE, [requestId])
          .catch((e) => this.logger.warn(`отзыв ссылки по ${row.id}: ${(e as Error).message}`));
      }
      await this.notifications
        .notify(
          row.createdById,
          'document.internal_declined',
          {
            title: row.title,
            signerLabel: opts.signerName ?? '',
            reasonLabel: opts.reason ? `: ${opts.reason}` : '',
          },
          {
            actionUrl: `/workspaces/${row.workspaceId}/documents/${row.id}`,
            dedupKey: this.outcomeDedupKey('intdecl', row.id, requestId),
          },
        )
        .catch(() => undefined);
      return;
    }
    if (outcome === 'declined') {
      const won = await this.db.orgDocument.updateMany({
        where: { id: row.id, status: 'sent' },
        data: { status: 'declined_external' },
      });
      if (won.count === 0) return;
      await this.notifications
        .notify(
          row.createdById,
          'document.counterparty_declined',
          { title: row.title, reasonLabel: opts.reason ?? '' },
          {
            actionUrl: `/workspaces/${row.workspaceId}/documents/${row.id}`,
            dedupKey: this.outcomeDedupKey('declined', row.id, opts.requestId),
          },
        )
        .catch(() => undefined);
      return;
    }
    // expired: авто-возврат в черновик — документ не должен вечно висеть «у контрагента»
    const won = await this.db.orgDocument.updateMany({
      where: { id: row.id, status: 'sent' },
      data: { status: 'draft' },
    });
    if (won.count === 0) return;
    if (row.documentId) await this.docs.systemSetMode(row.documentId, 'edit').catch(() => undefined);
    await this.chatter
      .log(null, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: row.id,
        workspaceId: row.workspaceId,
        typeKey: 'org_document.external_expired',
        payload: { title: row.title },
      })
      .catch(() => undefined);
    await this.notifications
      .notify(
        row.createdById,
        'document.external_expired',
        { title: row.title },
        {
          actionUrl: `/workspaces/${row.workspaceId}/documents/${row.id}`,
          dedupKey: this.outcomeDedupKey('expired', row.id, opts.requestId),
        },
      )
      .catch(() => undefined);
  }

  /**
   * Сверка сертификата ВНЕШНЕГО подписанта с карточкой контрагента (жёсткая,
   * решение продукта): юрлицо — по БИН, ИП и физлицо — по ИИН. Пустой номер в
   * карточке → пропуск (личность держит подтверждённый SMS-номер).
   */
  async checkCounterpartyCert(
    documentId: string,
    cert: { iin: string | null; bin: string | null },
  ): Promise<{ ok: boolean; reason?: string }> {
    const row = await this.db.orgDocument.findUnique({ where: { id: documentId } });
    if (!row?.counterpartyId) return { ok: true };
    const cp = await this.db.counterparty.findUnique({ where: { id: row.counterpartyId } });
    if (!cp?.bin) return { ok: true };
    if (cp.kind === 'legal') {
      if (!cert.bin) {
        return { ok: false, reason: `нужен ключ юридического лица «${cp.name}» (в сертификате нет БИН)` };
      }
      if (cert.bin !== cp.bin) {
        return { ok: false, reason: `БИН сертификата не совпадает с БИН контрагента «${cp.name}»` };
      }
      return { ok: true };
    }
    if (!cert.iin || cert.iin !== cp.bin) {
      return { ok: false, reason: `ИИН сертификата не совпадает с ИИН контрагента «${cp.name}»` };
    }
    return { ok: true };
  }

  /** Живая свободная заявка внешнего этапа (партиальный уникум держит одну) */
  private async activeExternalRequest(documentId: string) {
    return this.db.signRequest.findFirst({
      where: {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: documentId,
        status: 'pending',
        approvalStepId: null,
      },
    });
  }

  /**
   * Блок `external` карточки: этап и доставка. Подписи (акты, протокол, экспорт)
   * сюда НЕ дублируются — их рисует блок «Подписи» из `dto.sign`.
   *
   * АДРЕС гостевой ссылки видит только Менеджер+ (`viewer.manager`). Ссылка —
   * не «посмотреть», а ПОДПИСАТЬ: requireIdentity подтверждает владение номером,
   * но не то, что это номер контактного лица, поэтому любой, кому виден адрес,
   * может подтвердить СВОЙ номер и поставить ПЭП «за контрагента». У вида с
   * видимостью «команда» карточку открывает вся организация — раздавать вместе
   * с ней ключ от подписи второй стороны нельзя. Статус этапа, стороны и счётчик
   * открытий остаются видны всем, кто видит документ.
   */
  private async externalStage(
    row: {
      id: string;
      workspaceId: string;
      counterpartyContactId: string | null;
    },
    viewer: { manager: boolean },
  ): Promise<OrgDocumentExternalDto | null> {
    const request = await this.db.signRequest.findFirst({
      where: { refType: ORG_DOCUMENT_REF_TYPE, refId: row.id, approvalStepId: null },
      orderBy: { createdAt: 'desc' },
      include: { acts: { orderBy: { createdAt: 'asc' } } },
    });
    if (!request) return null;

    const link = await this.db.shareLink.findFirst({
      where: { refType: SIGN_REQUEST_REF_TYPE, refId: request.id },
      orderBy: { createdAt: 'desc' },
    });
    const contact = row.counterpartyContactId
      ? (await this.counterparties.contactRefsFor([row.counterpartyContactId])).get(row.counterpartyContactId)
      : null;

    const guestActs = request.acts.filter((a) => a.signerType === 'guest');
    const guestAct = guestActs.length ? guestActs[guestActs.length - 1] : null;
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';

    return {
      requestId: request.id,
      status: request.status as SignRequestStatus,
      level: request.level as SignLevel,
      expiresAt: request.expiresAt?.toISOString() ?? null,
      link:
        link && viewer.manager
          ? { url: buildShareLinkUrl(webUrl, link.token), revoked: !!link.revokedAt }
          : null,
      internalActs: request.acts
        .filter((a) => a.signerType === 'user' && a.signerUserId)
        .map((a) => ({
          userId: a.signerUserId as string,
          name: a.signerName,
          status: a.status as SignActStatus,
          signedAt: a.signedAt?.toISOString() ?? null,
        })),
      guestAct: guestAct
        ? {
            name: guestAct.signerName,
            phoneMasked: guestAct.signerPhone ? maskPhone(guestAct.signerPhone) : null,
            status: guestAct.status as SignActStatus,
            signedAt: guestAct.signedAt?.toISOString() ?? null,
            declineReason: guestAct.declineReason,
            // Мягкая сверка ПЭП: номер гостя ≠ телефон выбранного контакта —
            // предупреждение на карточке, не блок (человек мог дать другой номер)
            matchesContact: !!guestAct.signerPhone && !!contact?.phone && guestAct.signerPhone === contact.phone,
          }
        : null,
      opens: link ? { count: link.openCount, lastOpenedAt: link.lastOpenedAt?.toISOString() ?? null } : null,
      smsAvailable: (this.smsOutbound.live || isDevEnv()) && !!contact?.phone,
      // Готовность считает движок — по живой ссылке, а не по колонке
      stamped: await this.sign.stampedView(request.stampedFileId),
    };
  }

  // ============================================================
  // Системные методы для нод маршрута (контракт system*: право проверил вызывающий —
  // им является сам маршрут, запущенный отправкой документа)
  // ============================================================

  /**
   * Присвоить номер (нода «Регистрация»). Идемпотентно: номер уже есть — возвращаем
   * его. Счётчик инкрементируется одним запросом в БД, поэтому два одновременных
   * «Зарегистрировать» получат РАЗНЫЕ номера, а не один и тот же.
   */
  async systemRegister(documentId: string): Promise<string> {
    const row = await this.documentOrThrow(documentId);
    if (row.number) return row.number;
    // Отменённый и заархивированный документ номера НЕ получают: маршрут мог доехать
    // до регистрации уже после того, как автор отменил подачу, — и книга регистрации
    // получала бы запись о документе, которого нет.
    this.assertRoutable(row);
    const type = await this.db.docType.findUniqueOrThrow({ where: { id: row.docTypeId } });
    const now = new Date();
    const year = now.getFullYear();

    const counter = await this.db.docTypeCounter.upsert({
      where: { docTypeId_year: { docTypeId: type.id, year } },
      create: { docTypeId: type.id, year, value: 1 },
      update: { value: { increment: 1 } },
    });
    const number = formatDocNumber(type.numberFormat, counter.value, now);

    const claimed = await this.db.orgDocument.updateMany({
      where: { id: row.id, number: null },
      data: {
        number,
        numberedAt: now,
        status: row.status === 'signed' ? 'registered' : row.status,
      },
    });
    if (claimed.count === 0) {
      // Гонку выиграл сосед — номер, который мы сожгли, останется дырой в книге
      // регистрации. Это честнее, чем выдать один номер двум приказам.
      const fresh = await this.documentOrThrow(documentId);
      return fresh.number ?? number;
    }
    await this.chatter
      .log(null, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: row.id,
        workspaceId: row.workspaceId,
        typeKey: 'org_document.registered',
        payload: { number, title: row.title },
      })
      .catch(() => undefined);
    return number;
  }

  /**
   * Присвоить номер ЧЕРНОВИКУ — кнопка внешнего контура: у договора номер
   * печатается в тексте ДО отправки контрагенту (в отличие от кадрового приказа,
   * где его выдаёт нода «Регистрация» после подписания). Тот же атомарный счётчик
   * вида, статус НЕ меняется; отправка без номера — предупреждение веба, не блок.
   */
  async assignNumber(userId: string, documentId: string): Promise<OrgDocumentDto> {
    const row = await this.documentOrThrow(documentId);
    const role = await this.requireTeam(userId, row.workspaceId);
    if (row.createdById !== userId && !this.isManager(role)) {
      throw new ForbiddenException('Присвоить номер может автор или Менеджер+');
    }
    if (row.number) return this.get(userId, row.id);
    const type = await this.db.docType.findUniqueOrThrow({ where: { id: row.docTypeId } });
    if (type.category !== 'external') {
      throw new BadRequestException('Номер этому виду присваивает маршрут при регистрации');
    }
    if (!DOC_EDITABLE_STATUSES.includes(row.status as DocStatus)) {
      throw new BadRequestException('Номер присваивается черновику — до отправки контрагенту');
    }

    const now = new Date();
    const counter = await this.db.docTypeCounter.upsert({
      where: { docTypeId_year: { docTypeId: type.id, year: now.getFullYear() } },
      create: { docTypeId: type.id, year: now.getFullYear(), value: 1 },
      update: { value: { increment: 1 } },
    });
    const number = formatDocNumber(type.numberFormat, counter.value, now);
    const claimed = await this.db.orgDocument.updateMany({
      where: { id: row.id, number: null },
      data: { number, numberedAt: now },
    });
    if (claimed.count > 0) {
      await this.chatter
        .log(null, {
          refType: ORG_DOCUMENT_REF_TYPE,
          refId: row.id,
          workspaceId: row.workspaceId,
          actorId: userId,
          actorName: await this.nameOf(userId),
          typeKey: 'org_document.registered',
          payload: { number, title: row.title },
        })
        .catch(() => undefined);
      // Номер печатается в тексте ({Документ.Номер}) — бланк пересобираем.
      // У загруженного файла пересобирать нечего: его номер живёт в карточке.
      if (row.templateId || row.builderDoc) {
        await this.requestGenerate(row.id);
      }
    }
    return this.get(userId, row.id);
  }

  /**
   * Сформировать ПРОИЗВОДНЫЙ документ (нода «Сформировать документ»): приказ из
   * заявления. Родитель остаётся основанием — связь `parentDocumentId` держит цепочку,
   * по которой при проверке видно, на чём приказ основан.
   */
  async systemGenerateChild(
    parentDocumentId: string,
    opts: { templateId: string; title?: string; actorId: string },
  ): Promise<string> {
    const parent = await this.documentOrThrow(parentDocumentId);
    const tpl = await this.db.docTemplate.findFirst({
      where: { id: opts.templateId, workspaceId: parent.workspaceId, archivedAt: null },
    });
    if (!tpl) throw new BadRequestException('Шаблон для формирования не найден в этой организации');

    // Идемпотентность: нода могла отработать и упасть на следующем шаге — второй заход
    // не должен плодить приказы.
    const existing = await this.db.orgDocument.findFirst({
      where: { parentDocumentId: parent.id, templateId: tpl.id },
    });
    if (existing) return existing.id;

    const created = await this.db.$transaction(async (tx) => {
      const row = await tx.orgDocument.create({
        data: {
          workspaceId: parent.workspaceId,
          docTypeId: tpl.docTypeId,
          templateId: tpl.id,
          title: opts.title ?? tpl.name,
          // Производный документ создаётся уже ВНУТРИ маршрута — он не черновик автора,
          // а часть идущего процесса.
          status: 'in_review',
          subjectUserId: parent.subjectUserId,
          createdById: opts.actorId,
          parentDocumentId: parent.id,
          fields: parent.fields as object,
        },
      });
      await this.chatter.log(tx, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: row.id,
        workspaceId: row.workspaceId,
        actorId: opts.actorId,
        typeKey: 'org_document.created',
        payload: { title: row.title },
      });
      await this.jobs.enqueue(tx, {
        type: DOCUMENTS_GENERATE_JOB,
        payload: { documentId: row.id },
        uniqueKey: docGenKey(row.id),
      });
      return row;
    });
    return created.id;
  }

  /**
   * Документ ещё идёт по маршруту? Отменённый, отклонённый и архивный дальше не едут —
   * маршрут мог дойти до своей ноды уже после того, как человек нажал «Отменить».
   */
  private assertRoutable(row: { status: string; title: string }): void {
    if (!DOC_ROUTABLE_STATUSES.includes(row.status as DocStatus)) {
      throw new BadRequestException(`Документ «${row.title}» больше не на маршруте (${row.status})`);
    }
  }

  /** Подшить документ на Диск организации (нода «Подшить в дело») — фоновым джобом. */
  async systemFile(documentId: string): Promise<void> {
    const row = await this.documentOrThrow(documentId);
    this.assertRoutable(row);
    await this.jobs.enqueue(null, {
      type: DOCUMENTS_FILE_JOB,
      payload: { documentId: row.id },
      uniqueKey: `doc:file:${row.id}`,
    });
  }

  /** Пометить документ подписанным (маршрут дошёл до конца с исходом «согласовано»). */
  async systemMarkSigned(documentId: string): Promise<void> {
    const row = await this.documentOrThrow(documentId);
    if (row.signedAt) return;
    this.assertRoutable(row);
    await this.db.orgDocument.updateMany({
      // Статус-гвард обязателен: гвард только по `signedAt` перезаписывал отмену и
      // воскрешал отменённый документ в «подписан».
      where: { id: row.id, signedAt: null, status: { in: [...DOC_ROUTABLE_STATUSES] } },
      data: { signedAt: new Date(), status: row.number ? 'registered' : 'signed' },
    });
    await this.chatter
      .log(null, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: row.id,
        workspaceId: row.workspaceId,
        typeKey: 'org_document.signed',
        payload: { title: row.title },
      })
      .catch(() => undefined);
  }

  /** Итог маршрута: отклонён / на доработку (правка снова открывается). */
  async systemResolve(documentId: string, outcome: 'approved' | 'rejected' | 'returned'): Promise<void> {
    const row = await this.documentOrThrow(documentId);
    if (outcome === 'approved') {
      await this.systemMarkSigned(documentId);
    } else {
      const status: DocStatus = outcome === 'returned' ? 'rejected' : 'rejected';
      await this.db.orgDocument.updateMany({
        where: { id: row.id, status: 'in_review' },
        data: { status },
      });
      // На доработку — правка снова открыта: иначе автору нечего исправлять.
      if (row.documentId) {
        await this.docs.systemSetMode(row.documentId, 'edit').catch(() => undefined);
      }
      await this.chatter
        .log(null, {
          refType: ORG_DOCUMENT_REF_TYPE,
          refId: row.id,
          workspaceId: row.workspaceId,
          typeKey: outcome === 'returned' ? 'org_document.returned' : 'org_document.rejected',
          payload: { title: row.title, reasonSuffix: '' },
        })
        .catch(() => undefined);
    }

    // КЭДО: отклонение/доработка возвращают действие в черновик (правится и заново)
    if (row.hrActionId) {
      await this.hr?.onDocumentResolved(row.hrActionId, outcome).catch(() => undefined);
    }

    const fresh = await this.documentOrThrow(documentId);
    const outcomeLabel =
      outcome === 'approved' ? 'Документ подписан' : outcome === 'returned' ? 'Документ на доработку' : 'Документ отклонён';
    await this.notifications
      .notify(
        fresh.createdById,
        'document.resolved',
        {
          outcomeLabel,
          title: fresh.title,
          numberLabel: fresh.number ? `№ ${fresh.number}` : '',
        },
        { actionUrl: `/workspaces/${fresh.workspaceId}/documents/${fresh.id}` },
      )
      .catch(() => undefined);
  }

  // ============================================================
  // КЭДО (modules/hr) — системные пути и вручение
  // ============================================================

  /**
   * Создать документ кадрового действия. system-контракт: право (Менеджер+)
   * проверил вызывающий — hr. Отличия от пользовательского пути: гейт «шаблон
   * выдан» не спрашивается (приказ заводит машина действия), карточка несёт
   * `hrActionId`, а режим доставки берётся из paperMode трудовой карточки.
   */
  async systemCreateForHrAction(opts: {
    workspaceId: string;
    templateId: string;
    actorId: string;
    subjectUserId: string;
    hrActionId: string;
    title?: string;
    fields?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    const tpl = await this.templateOrThrow(opts.workspaceId, opts.templateId);
    if (tpl.status !== 'published') throw new BadRequestException('Шаблон приказа ещё не опубликован');
    const fields = await this.sanitizeFields(opts.fields ?? {}, tpl.id);
    const employment = await this.db.employment.findFirst({
      where: { workspaceId: opts.workspaceId, userId: opts.subjectUserId, status: { not: 'terminated' } },
      select: { paperMode: true },
    });
    const created = await this.db.$transaction(async (tx) => {
      const row = await tx.orgDocument.create({
        data: {
          workspaceId: opts.workspaceId,
          docTypeId: tpl.docTypeId,
          templateId: tpl.id,
          title: opts.title ?? tpl.name,
          status: 'draft',
          subjectUserId: opts.subjectUserId,
          createdById: opts.actorId,
          hrActionId: opts.hrActionId,
          // Гибрид — постоянный режим: у работника без ЭЦП (paperMode) документ
          // сразу помечен «электронно и на бумаге».
          deliveryMode: employment?.paperMode ? 'hybrid' : 'electronic',
          fields: fields as object,
          ...(tpl.kind === 'builder' && tpl.builderDoc ? { builderDoc: tpl.builderDoc as object } : {}),
        },
      });
      await this.chatter.log(tx, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: row.id,
        workspaceId: opts.workspaceId,
        actorId: opts.actorId,
        actorName: await this.nameOf(opts.actorId),
        typeKey: 'org_document.created',
        payload: { title: row.title },
      });
      await this.jobs.enqueue(tx, {
        type: DOCUMENTS_GENERATE_JOB,
        payload: { documentId: row.id },
        uniqueKey: docGenKey(row.id),
      });
      return row;
    });
    return { id: created.id };
  }

  /**
   * Отменить неприменённые документы действия (отзыв заявления, отмена действия).
   * ИЗДАННЫЙ документ (подписан/зарегистрирован) не трогается — по нему кадровик
   * издаёт приказ об отмене (v1 — полуручной путь); возвращаем счётчик таких.
   */
  async systemCancelForHrAction(hrActionId: string, actorId: string): Promise<{ cancelled: number; issuedLeft: number }> {
    const docs = await this.db.orgDocument.findMany({
      where: { hrActionId },
      select: { id: true, status: true, workspaceId: true, title: true, documentId: true, processInstanceId: true },
    });
    let cancelled = 0;
    let issuedLeft = 0;
    for (const doc of docs) {
      if (['draft', 'in_review', 'rejected'].includes(doc.status)) {
        const claimed = await this.db.orgDocument.updateMany({
          where: { id: doc.id, status: doc.status },
          data: { status: 'cancelled' },
        });
        if (claimed.count === 0) continue;
        cancelled += 1;
        await this.approvals.cancelForRef(ORG_DOCUMENT_REF_TYPE, doc.id).catch(() => undefined);
        if (doc.processInstanceId && this.processes?.cancelInstanceProgrammatic) {
          await this.processes.cancelInstanceProgrammatic(doc.processInstanceId, actorId).catch(() => undefined);
        }
        if (doc.documentId) await this.docs.systemSetMode(doc.documentId, 'edit').catch(() => undefined);
        await this.chatter
          .log(null, {
            refType: ORG_DOCUMENT_REF_TYPE,
            refId: doc.id,
            workspaceId: doc.workspaceId,
            actorId,
            actorName: await this.nameOf(actorId),
            typeKey: 'org_document.cancelled',
            payload: { title: doc.title },
          })
          .catch(() => undefined);
      } else if (['signed', 'registered', 'active'].includes(doc.status)) {
        issuedLeft += 1;
      }
    }
    return { cancelled, issuedLeft };
  }

  /**
   * Зафиксировать ВРУЧЕНИЕ (специальный режим — ст. 61 п. 3, ст. 65 ТК РК:
   * лично, отказ актом, заказное письмо с треком). Пишется один раз; после
   * фиксации документ считается доведённым до работника — субъект видит его,
   * КЭДО пишет личную запись-архив.
   */
  async fixDelivery(
    userId: string,
    documentId: string,
    dto: { method: string; trackNumber?: string; deliveredAt?: string },
  ): Promise<OrgDocumentDto> {
    const row = await this.documentOrThrow(documentId);
    await this.requireManager(userId, row.workspaceId);
    if (row.deliveredAt) throw new BadRequestException('Вручение уже зафиксировано');
    if (!['signed', 'registered', 'active'].includes(row.status)) {
      throw new BadRequestException('Вручение фиксируется у подписанного документа');
    }
    const deliveredAt = dto.deliveredAt ? new Date(dto.deliveredAt) : new Date();
    const claimed = await this.db.orgDocument.updateMany({
      where: { id: row.id, deliveredAt: null },
      data: {
        deliveredAt,
        deliveryMethod: dto.method,
        deliveryTrackNumber: dto.trackNumber ?? null,
      },
    });
    if (claimed.count === 0) throw new BadRequestException('Вручение уже зафиксировано');
    const methodLabel =
      dto.method === 'in_person'
        ? 'лично под роспись'
        : dto.method === 'refusal_act'
          ? 'отказ — составлен акт'
          : 'заказным письмом с уведомлением';
    // Свой кадровый typeKey (категория «Кадры» в журнале), а не org_document.filed:
    // «Документ подшит: вручение…» — это про место в деле, здесь же юридический
    // факт вручения работнику (ст. 61 п. 3), и трек-номер обязан остаться в следе.
    await this.chatter
      .log(null, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: row.id,
        workspaceId: row.workspaceId,
        actorId: userId,
        actorName: await this.nameOf(userId),
        typeKey: 'hr.delivery_fixed',
        payload: {
          methodLabel: `${methodLabel} — «${row.title}»`,
          trackSuffix: dto.trackNumber ? ` · трек ${dto.trackNumber}` : '',
        },
      })
      .catch(() => undefined);
    await this.hr?.onDocumentDelivered(row.id).catch(() => undefined);
    return this.get(userId, row.id);
  }

  /** Режим доставки (гибрид): electronic | paper | hybrid — Менеджер+ */
  async setDeliveryMode(userId: string, documentId: string, deliveryMode: string): Promise<OrgDocumentDto> {
    const row = await this.documentOrThrow(documentId);
    await this.requireManager(userId, row.workspaceId);
    await this.db.orgDocument.update({ where: { id: row.id }, data: { deliveryMode } });
    return this.get(userId, row.id);
  }

  /** Заказать PDF-отпечаток текущего содержимого (идемпотентно, контентный ключ у движка). */
  async requestPdf(documentId: string): Promise<{ ready: boolean }> {
    const row = await this.documentOrThrow(documentId);
    // Загруженный PDF: файл и есть отпечаток, снимать нечего — честное «готово».
    if (!row.builderDoc && !row.documentId && row.pdfFileId) return { ready: true };
    // Блочный документ: отпечаток собирает наш PDF-рендер, живой файл core/docs не нужен
    const canSnapshot = row.builderDoc ? this.pdfRender.enabled : !!row.documentId && this.docs.enabled;
    if (!canSnapshot) return { ready: false };
    await this.jobs.enqueue(null, {
      type: DOCUMENTS_PDF_JOB,
      payload: { documentId: row.id },
      uniqueKey: `doc:pdf:${row.id}:${row.fileId ?? 'na'}`,
    });
    return { ready: false };
  }

  // ============================================================
  // Вспомогательное
  // ============================================================

  /**
   * Сторона документа. ОДНО определение на сервис: и создание, и правка обязаны
   * отвечать одинаково — пока проверка стояла только на создании, тот же uuid уезжал
   * в документ через PATCH, и рендер печатал персональные данные постороннего.
   */
  private async assertSubject(
    userId: string,
    workspaceId: string,
    role: WorkspaceRole | null,
    subjectUserId: string | null,
  ): Promise<void> {
    if (!subjectUserId || subjectUserId === userId) return;
    if (!this.isManager(role)) throw new ForbiddenException('Заводить документ на другого может Менеджер+');
    const subjectRole = await this.roleOf(subjectUserId, workspaceId);
    if (!subjectRole || subjectRole === 'contractor') {
      throw new BadRequestException('Сторона документа должна работать в организации');
    }
  }

  /**
   * Привязка КОНТРАГЕНТА к документу. ОДНО определение на сервис (правило «проверка
   * с создания дублируется на правку» — ровно на нём ловились ИИН постороннего в
   * PATCH): контрагент — только у видов «С контрагентами», живёт в ЭТОЙ организации,
   * при привязке не в архиве, контакт принадлежит ему. Принадлежность и жизнь
   * проверяет сервис «Контрагенты» — второго толкования этих правил быть не должно.
   */
  private async assertCounterpartyBinding(
    workspaceId: string,
    category: DocCategory | string,
    counterpartyId: string | null,
    contactId: string | null,
  ): Promise<void> {
    if (!counterpartyId) {
      if (contactId) throw new BadRequestException('Контактное лицо указывается вместе с контрагентом');
      return;
    }
    if (category !== 'external') {
      throw new BadRequestException('Контрагент указывается только у документов «С контрагентами»');
    }
    await this.counterparties.assertUsable(workspaceId, counterpartyId);
    if (contactId) await this.counterparties.assertContactUsable(counterpartyId, contactId);
  }

  /**
   * Значения формы — только ОБЪЯВЛЕННЫЕ ключи и только примитивы (плюс период дат).
   *
   * Объявление берётся у ШАБЛОНА, а у свободного документа — из его собственного
   * `formFields`: иначе в документе без шаблона нельзя было ввести дату календарём.
   *
   * Эти значения уходят в рендер отдельным слоем и в анкету запуска маршрута, поэтому
   * свободный JSON здесь означал две дыры разом: ключ «Организация» подменял РЕКВИЗИТЫ
   * в готовом документе (слой потребителя ложился поверх групп реестра), а ключ вида
   * `_subprocessDepth` — служебные переменные движка процессов.
   */
  private async sanitizeFields(
    raw: Record<string, unknown>,
    templateId: string | null,
    ownFormFields?: unknown,
  ): Promise<Record<string, unknown>> {
    // Объявление формы: у документа по шаблону — в шаблоне, у свободного — своё.
    // Нет ни того ни другого → значения не принимаем вовсе (прежнее поведение).
    let spec: DocFormFieldDto[] = [];
    if (templateId) {
      const tpl = await this.db.docTemplate.findUnique({
        where: { id: templateId },
        select: { fields: true },
      });
      spec = (tpl?.fields ?? []) as unknown as DocFormFieldDto[];
    } else if (Array.isArray(ownFormFields)) {
      spec = ownFormFields as DocFormFieldDto[];
    }
    if (spec.length === 0) return {};
    const declared = new Map(
      spec
        .filter((f) => typeof f?.key === 'string' && !f.key.startsWith('_'))
        .map((f) => [f.key, f.kind] as const),
    );
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw ?? {})) {
      if (!declared.has(key)) continue;
      if (value === null || value === undefined) continue;
      if (typeof value === 'object') {
        // Объекты подменяли группы шаблона целиком — режутся. Единственная узкая
        // дверь: строго валидный период {from,to} на ОБЪЯВЛЕННОМ daterange-поле.
        if (declared.get(key) === 'daterange' && isDocDateRangeValue(value)) {
          out[key] = { from: value.from, to: value.to };
        }
        continue;
      }
      out[key] = typeof value === 'string' ? value.slice(0, DOC_LIMITS.maxFieldValueLength) : value;
    }
    return out;
  }

  /** Право менять содержимое файла карточки (резолвер движка файлов) */
  async canEditFile(userId: string, documentId: string): Promise<boolean> {
    const row = await this.db.orgDocument.findUnique({ where: { id: documentId } });
    if (!row) return false;
    const role = await this.roleOf(userId, row.workspaceId);
    if (!role || role === 'contractor') return false;
    return this.canEdit(userId, row, role);
  }

  /**
   * Вправе ли человек отправить ЭТОТ документ на решение. Зовёт движок согласований
   * через резолвер: он единственный проход, через который заводится любая заявка, и
   * правил предметной области он не знает.
   */
  async canRequestApproval(
    userId: string,
    doc: { workspaceId: string; createdById: string; status: string },
  ): Promise<boolean> {
    const role = await this.roleOf(userId, doc.workspaceId);
    if (!role || role === 'contractor') return false;
    return doc.createdById === userId || this.isManager(role);
  }

  /**
   * Отпечаток содержимого, под которым принимается решение. Берём sha живого файла
   * карточки: именно его видит решающий и именно его позже подпишет `core/sign`.
   */
  async contentFingerprint(doc: { fileId: string | null }): Promise<string | null> {
    if (!doc.fileId) return null;
    const file = await this.db.fileObject.findUnique({
      where: { id: doc.fileId },
      select: { sha256: true },
    });
    return file?.sha256 ?? null;
  }

  /** Файл шаблона обязан принадлежать тому, кто его прикрепляет (иначе чужой fileId). */
  private async assertOwnFile(userId: string, fileId: string): Promise<void> {
    const file = await this.db.fileObject.findUnique({
      where: { id: fileId },
      select: { uploaderId: true, status: true },
    });
    if (!file || file.status !== 'ready') throw new NotFoundException('Файл не найден');
    if (file.uploaderId !== userId) throw new ForbiddenException('Это не ваш файл');
  }

  /** Получатель гранта обязан принадлежать ЭТОЙ организации (иначе доступ утечёт наружу). */
  private async assertPrincipalOfWorkspace(
    workspaceId: string,
    dto: DocTemplateGrantInput,
  ): Promise<void> {
    if (dto.principalType === 'user') {
      const role = await this.roleOf(dto.principalId, workspaceId);
      if (!role || role === 'contractor') throw new BadRequestException('Этот человек не работает в организации');
      return;
    }
    const table =
      dto.principalType === 'department'
        ? this.db.staffDepartment
        : dto.principalType === 'position'
          ? this.db.staffPosition
          : this.db.staffBranch;
    const found = await (table as { count(args: unknown): Promise<number> }).count({
      where: { id: dto.principalId, workspaceId },
    });
    if (found === 0) throw new BadRequestException('Такого подразделения нет в организации');
  }

  /**
   * «Коллеги по отделу» — люди, с которыми зритель делит хотя бы один отдел ЭТОЙ
   * организации.
   *
   * ЕДИНСТВЕННОЕ определение на сервис: и карточка (`canView`), и реестр
   * (`visibilityWhere`) обязаны отвечать одинаково. Пока определений было два,
   * документ коллеги открывался по прямой ссылке, но в списке не находился —
   * человеку это выглядит как поломка, а не как правило доступа.
   *
   * Оси оргструктуры берём у движка прав (`principalsOf`): в них уже развёрнуты
   * РОДИТЕЛЬСКИЕ отделы (closure проекции StaffModule). Своего обхода назначений
   * здесь быть не должно — ровно на двух разъехавшихся копиях такого обхода в
   * Задачнике и Календаре платформа уже теряла гейт.
   *
   * Отделы сужаются до ЭТОЙ организации: человек состоит в отделах нескольких
   * организаций, и без сужения общий отдел в организации А открывал бы документы
   * организации Б.
   */
  private async departmentCoworkerIds(userId: string, workspaceId: string): Promise<string[]> {
    const myDepartments = this.access.principalIdsOfType(
      await this.access.principalsOf(userId),
      'department',
    );
    if (myDepartments.length === 0) return [];
    const here = await this.db.staffDepartment.findMany({
      where: { id: { in: myDepartments }, workspaceId },
      select: { id: true },
    });
    if (here.length === 0) return [];
    // Обратная сторона той же проекции: `department:<id>#member@user`. Один индексный
    // запрос по прямому индексу (resourceType, resourceId, relation) — списочному пути
    // нельзя ни `check()` в цикле, ни `listObjects` с его молчаливой обрезкой.
    const members = await this.db.relationTuple.findMany({
      where: {
        resourceType: 'department',
        resourceId: { in: here.map((d) => d.id) },
        relation: 'member',
        subjectType: 'user',
        subjectRelation: '',
      },
      select: { subjectId: true },
    });
    return [...new Set(members.map((m) => m.subjectId))];
  }

  /**
   * Видимость документов: автор, сторона и управляющие видят всегда, остальное решает
   * настройка ВИДА. Условие уходит в SQL одним `OR` — прав в цикле здесь быть не может.
   */
  private async visibilityWhere(
    userId: string,
    workspaceId: string,
    role: WorkspaceRole,
  ): Promise<Record<string, unknown>> {
    if (this.isManager(role)) return {};
    // Архивные виды НЕ отфильтрованы намеренно. Архив вида — это жизненный цикл
    // СПРАВОЧНИКА («больше не заводим по нему новое»), а не отзыв доступа: так он
    // устроен и в остальной экосистеме (счёт финансов с историей, лот после окна
    // продаж, деактивированная организация). «Новое не предлагаем» уже обеспечено
    // в других местах — `availableTemplates`, `typeOrThrow`, `templateOrThrow`, — а
    // `archiveType` прямо обещает, что история остаётся, и пускает в архив только
    // вид, у которого не осталось документов в работе: то есть ровно подписанные и
    // зарегистрированные записи. Фильтр здесь означал бы, что уборка справочника
    // ТИХО выносит прошлогодние приказы из реестра команды — как раз тогда, когда
    // в них и лезут. Сузить видимость по-прежнему можно явно: `visibility` вида.
    const openTypes = await this.db.docType.findMany({
      where: { workspaceId, visibility: { in: ['team', 'department'] } },
      select: { id: true, visibility: true },
    });
    const teamTypeIds = openTypes.filter((t) => t.visibility === 'team').map((t) => t.id);
    const depTypeIds = openTypes.filter((t) => t.visibility === 'department').map((t) => t.id);
    // Коллег тянем, только если в организации ЕСТЬ вид «отдел сотрудника»: иначе это
    // два лишних запроса на каждый показ реестра ради условия, которое не пригодится.
    const coworkerIds = depTypeIds.length ? await this.departmentCoworkerIds(userId, workspaceId) : [];
    // Документы, по которым этот человек решает или уже решил. Без них согласующий
    // видел в стопке «Подписать», а сам документ ему отвечал 403 — он мог только
    // подписать вслепую. Список берём у движка решений: адресность живёт там.
    const decidingIds = await this.decidableDocumentIds(userId, workspaceId);
    // Адресат кампании ознакомления видит её предмет (иначе задание «ознакомьтесь»
    // ведёт в 403).
    const campaignDocIds = await this.campaignSubjectDocumentIds(userId, workspaceId);
    return {
      OR: [
        { createdById: userId },
        // СТОРОНА документа видит его С МОМЕНТА ОТПРАВКИ ЕЙ, а не с черновика
        // (решение ревью КЭДО): приказ об увольнении не светится субъекту, пока
        // работодатель его готовит и согласует. «Дошёл до человека» — это статус
        // ≥ подписан ЛИБО зафиксированное вручение; адресат шага и подписант
        // покрыты decidingIds, свои заявления — веткой createdById.
        {
          subjectUserId: userId,
          OR: [
            { status: { in: ['signed', 'registered', 'active', 'archived'] } },
            { deliveredAt: { not: null } },
          ],
        },
        ...(decidingIds.length ? [{ id: { in: decidingIds } }] : []),
        ...(campaignDocIds.length ? [{ id: { in: campaignDocIds } }] : []),
        ...(teamTypeIds.length ? [{ docTypeId: { in: teamTypeIds } }] : []),
        // «Отдел сотрудника»: вид открыт тем, кто работает в одном отделе со СТОРОНОЙ
        // документа. Оба условия — одной строкой SQL (implicit AND в Prisma).
        ...(depTypeIds.length && coworkerIds.length
          ? [{ docTypeId: { in: depTypeIds }, subjectUserId: { in: coworkerIds } }]
          : []),
      ],
    };
  }

  /** Документы-предметы кампаний ознакомления, где зритель — адресат */
  private async campaignSubjectDocumentIds(userId: string, workspaceId: string): Promise<string[]> {
    const rows = await this.db.docCampaignTarget.findMany({
      where: { userId, campaign: { workspaceId } },
      select: { campaign: { select: { orgDocumentId: true } } },
      take: 500,
    });
    return [...new Set(rows.map((r) => r.campaign.orgDocumentId))];
  }

  private async canView(
    userId: string,
    row: {
      id: string;
      createdById: string;
      subjectUserId: string | null;
      docTypeId: string;
      workspaceId: string;
      status: string;
      deliveredAt: Date | null;
    },
    role: WorkspaceRole,
  ): Promise<boolean> {
    if (this.isManager(role)) return true;
    if (row.createdById === userId) return true;
    // СТОРОНА видит документ «с момента отправки ей» — ровно то же правило, что в
    // visibilityWhere (урок «реестр и карточка отвечают одинаково»): черновик
    // приказа об увольнении субъекту не светится; адресат шага покрыт isDecider.
    if (
      row.subjectUserId === userId &&
      (['signed', 'registered', 'active', 'archived'].includes(row.status) || row.deliveredAt !== null)
    ) {
      return true;
    }
    // Участник маршрута видит предмет своего решения — иначе он подписывает вслепую.
    if (await this.isDecider(userId, row.id)) return true;
    // Адресат кампании ознакомления видит её предмет.
    const asTarget = await this.db.docCampaignTarget.count({
      where: { userId, campaign: { orgDocumentId: row.id } },
    });
    if (asTarget > 0) return true;
    const type = await this.db.docType.findUnique({
      where: { id: row.docTypeId },
      select: { visibility: true },
    });
    if (type?.visibility === 'team') return true;
    if (type?.visibility === 'department' && row.subjectUserId) {
      const coworkers = await this.departmentCoworkerIds(userId, row.workspaceId);
      return coworkers.includes(row.subjectUserId);
    }
    return false;
  }

  /** Документы организации, по которым человек решает или решал (адресность — у движка) */
  private async decidableDocumentIds(userId: string, workspaceId: string): Promise<string[]> {
    return this.approvals.refIdsInvolving(userId, ORG_DOCUMENT_REF_TYPE, workspaceId);
  }

  /** Он адресат (или уже решил) по ЭТОМУ документу */
  private async isDecider(userId: string, documentId: string): Promise<boolean> {
    return this.approvals.isInvolvedInRef(userId, ORG_DOCUMENT_REF_TYPE, documentId);
  }

  private canEdit(
    userId: string,
    row: { createdById: string; status: string },
    role: WorkspaceRole,
  ): boolean {
    if (!DOC_EDITABLE_STATUSES.includes(row.status as DocStatus)) return false;
    return row.createdById === userId || this.isManager(role);
  }

  /** Шаблоны, у которых есть ОПУБЛИКОВАННЫЙ маршрут (триггер «Документ отправлен»). */
  private async routedTemplateIds(workspaceId: string): Promise<Set<string>> {
    const rows = await this.db.processTrigger.findMany({
      // Архивный процесс маршрутом не считается: его триггер остаётся в таблице, и
      // без этой сверки карточка шаблона обещала маршрут, которого уже нет.
      where: { workspaceId, type: 'document', enabled: true, definition: { status: 'active' } },
      select: { config: true },
    });
    const ids = new Set<string>();
    for (const r of rows) {
      const templateId = ((r.config ?? {}) as { templateId?: string }).templateId;
      if (templateId) ids.add(templateId);
    }
    return ids;
  }

  /**
   * Живой маршрут шаблона: триггер «Документ отправлен» ОПУБЛИКОВАННОГО процесса.
   *
   * Статус определения проверяем здесь, а не только по флагу триггера: архив процесса
   * строку триггера не снимает, и без этой сверки шаблон выглядел бы «с маршрутом»,
   * а запуск молча не происходил бы.
   */
  private async findRoute(workspaceId: string, templateId: string | null) {
    if (!templateId) return null;
    const triggers = await this.db.processTrigger.findMany({
      where: {
        workspaceId,
        type: 'document',
        enabled: true,
        definition: { status: 'active' },
      },
    });
    return (
      triggers.find((t) => ((t.config ?? {}) as { templateId?: string }).templateId === templateId) ?? null
    );
  }

  /** Запустить найденный маршрут документа (предмет маршрута — сам документ). */
  private async startRoute(
    documentId: string,
    actorId: string,
    trigger: { definitionId: string; config: unknown },
  ): Promise<void> {
    const row = await this.documentOrThrow(documentId);
    if (!this.processes) return;
    const nodeId = ((trigger.config ?? {}) as { nodeId?: string }).nodeId;
    const instanceId = await this.processes.startInstanceProgrammatic(
      trigger.definitionId,
      actorId,
      {
        ...(row.fields as Record<string, unknown>),
        // Служебные ключи движка: по ним ноды решения понимают, что ПРЕДМЕТ маршрута —
        // документ, а не сам запуск процесса. Санитайзер внешних стартов такие ключи
        // отбрасывает, поэтому подделать их вебхуком нельзя.
        _subjectRefType: ORG_DOCUMENT_REF_TYPE,
        _subjectRefId: row.id,
        _subjectTitle: row.title,
        // КЭДО: адресат «Сторона документа» у нод решения (работник знакомится с
        // приказом О СЕБЕ, кто бы ни запускал маршрут) + действие для ноды hr.apply.
        ...(row.subjectUserId ? { _subjectUserId: row.subjectUserId } : {}),
        ...(row.hrActionId ? { _hrActionId: row.hrActionId } : {}),
      },
      'event',
      nodeId,
    );
    if (instanceId) {
      await this.db.orgDocument.update({
        where: { id: row.id },
        data: { processInstanceId: instanceId },
      });
    }
  }

  private async typeOrThrow(workspaceId: string, typeId: string) {
    const row = await this.db.docType.findFirst({ where: { id: typeId, workspaceId, archivedAt: null } });
    if (!row) throw new NotFoundException('Вид документа не найден');
    return row;
  }

  private async templateOrThrow(workspaceId: string, templateId: string) {
    const row = await this.db.docTemplate.findFirst({
      where: { id: templateId, workspaceId, archivedAt: null },
    });
    if (!row) throw new NotFoundException('Шаблон не найден');
    return row;
  }

  async documentOrThrow(documentId: string) {
    const row = await this.db.orgDocument.findUnique({ where: { id: documentId } });
    if (!row) throw new NotFoundException('Документ не найден');
    return row;
  }

  private async nameOf(userId: string): Promise<string> {
    const u = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    return fullName(u);
  }

  /** Контрагенты и контакты страницы — двумя батчами (без N+1), из их сервиса */
  private async counterpartyRefs(
    rows: { counterpartyId: string | null; counterpartyContactId: string | null }[],
  ): Promise<{
    lites: Map<string, CounterpartyLiteDto>;
    contacts: Map<string, { id: string; name: string; position: string | null; phone: string | null }>;
  }> {
    const [lites, contacts] = await Promise.all([
      this.counterparties.litesFor(rows.map((r) => r.counterpartyId).filter((v): v is string => !!v)),
      this.counterparties.contactRefsFor(
        rows.map((r) => r.counterpartyContactId).filter((v): v is string => !!v),
      ),
    ]);
    return { lites, contacts };
  }

  private async namesOf(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    if (!unique.length) return new Map();
    const rows = await this.db.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(rows.map((r) => [r.id, fullName(r)]));
  }

  // ---- сериализация ----

  private serializeType(
    row: {
      id: string;
      workspaceId: string;
      name: string;
      category: string;
      numberFormat: string | null;
      visibility: string;
      signatureLevel: string;
      toPersonalFile: boolean;
      specialDelivery: boolean;
      retentionYears: number | null;
      libraryKey: string | null;
      sortOrder: number;
      createdAt: Date;
    },
    templatesCount: number,
  ): DocTypeDto {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      category: row.category as DocTypeDto['category'],
      numberFormat: row.numberFormat,
      visibility: row.visibility as DocTypeDto['visibility'],
      signatureLevel: row.signatureLevel as DocTypeDto['signatureLevel'],
      toPersonalFile: row.toPersonalFile,
      specialDelivery: row.specialDelivery,
      retentionYears: row.retentionYears,
      libraryKey: row.libraryKey,
      sortOrder: row.sortOrder,
      templatesCount,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private serializeTemplate(
    row: {
      id: string;
      workspaceId: string;
      docTypeId: string;
      name: string;
      description: string | null;
      kind: string;
      builderDoc: unknown;
      documentId: string | null;
      fileId: string | null;
      fields: unknown;
      selfService: boolean;
      status: string;
      version: number;
      libraryKey: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
    type: { name: string; category: string; signatureLevel?: string },
    hasRoute: boolean,
  ): DocTemplateDto {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      docTypeId: row.docTypeId,
      docTypeName: type.name,
      category: type.category as DocCategory,
      signatureLevel: (type.signatureLevel ?? 'none') as DocTemplateDto['signatureLevel'],
      name: row.name,
      description: row.description,
      kind: (row.kind ?? 'docx') as 'docx' | 'builder',
      builderDoc: (row.builderDoc ?? null) as DocTemplateDto['builderDoc'],
      documentId: row.documentId,
      fileId: row.fileId,
      fields: (row.fields ?? []) as DocFormFieldDto[],
      selfService: row.selfService,
      status: row.status as 'draft' | 'published',
      version: row.version,
      hasRoute,
      libraryKey: row.libraryKey,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private serializeDocument(
    row: {
      id: string;
      workspaceId: string;
      docTypeId: string;
      templateId: string | null;
      title: string;
      status: string;
      number: string | null;
      numberedAt: Date | null;
      subjectUserId: string | null;
      counterpartyId: string | null;
      counterpartyContactId: string | null;
      createdById: string;
      documentId: string | null;
      fileId: string | null;
      pdfFileId: string | null;
      builderDoc: unknown;
      fields: unknown;
      formFields: unknown;
      approvalRequestId: string | null;
      processInstanceId: string | null;
      parentDocumentId: string | null;
      hrActionId: string | null;
      deliveryMode: string;
      deliveredAt: Date | null;
      deliveryMethod: string | null;
      deliveryTrackNumber: string | null;
      signedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    },
    type: { name: string; category: string },
    template: { name: string; fields?: unknown } | null,
    names: Map<string, string>,
    cpx?: {
      lites: Map<string, CounterpartyLiteDto>;
      contacts: Map<string, { id: string; name: string; position: string | null; phone: string | null }>;
    },
  ): OrgDocumentDto {
    const contact = row.counterpartyContactId ? cpx?.contacts.get(row.counterpartyContactId) : null;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      docTypeId: row.docTypeId,
      docTypeName: type.name,
      category: type.category as DocCategory,
      templateId: row.templateId,
      templateName: template?.name ?? null,
      title: row.title,
      status: row.status as DocStatus,
      number: row.number,
      numberedAt: row.numberedAt?.toISOString() ?? null,
      subjectUserId: row.subjectUserId,
      subjectName: row.subjectUserId ? (names.get(row.subjectUserId) ?? null) : null,
      counterparty: (row.counterpartyId ? cpx?.lites.get(row.counterpartyId) : null) ?? null,
      counterpartyContact: contact
        ? ({ id: contact.id, name: contact.name, position: contact.position } satisfies OrgDocumentContactRef)
        : null,
      createdById: row.createdById,
      createdByName: names.get(row.createdById) ?? null,
      documentId: row.documentId,
      fileId: row.fileId,
      pdfFileId: row.pdfFileId,
      builderDoc: (row.builderDoc ?? null) as OrgDocumentDto['builderDoc'],
      fields: (row.fields ?? {}) as Record<string, unknown>,
      // Форма: у документа по шаблону — из шаблона, у свободного — своя
      formFields: ((row.templateId ? template?.fields : row.formFields) ?? []) as unknown as DocFormFieldDto[],
      approvalRequestId: row.approvalRequestId,
      processInstanceId: row.processInstanceId,
      parentDocumentId: row.parentDocumentId,
      hrActionId: row.hrActionId,
      deliveryMode: row.deliveryMode,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      deliveryMethod: row.deliveryMethod,
      deliveryTrackNumber: row.deliveryTrackNumber,
      signedAt: row.signedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}


