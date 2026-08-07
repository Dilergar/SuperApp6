import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DEFAULT_DOC_NUMBER_FORMAT,
  DOC_EDITABLE_STATUSES,
  DOC_GRANT_PRINCIPAL_TYPES,
  DOC_LIMITS,
  DOC_ROUTABLE_STATUSES,
  ORG_DOCUMENT_REF_TYPE,
  WORKSPACE_ROLE_RANK,
  formatDocNumber,
  type CreateDocTemplateInput,
  type CreateDocTypeInput,
  type CreateOrgDocumentInput,
  type DocCategory,
  type DocFormFieldDto,
  type DocStatus,
  type DocTemplateDto,
  type AvailableTemplateDto,
  type DocTemplateGrantDto,
  type DocTemplateGrantInput,
  type OrgDocumentListDto,
  type DocTypeDto,
  type ListOrgDocumentsInput,
  type OrgDocumentDto,
  type UpdateDocTemplateInput,
  type UpdateDocTypeInput,
  type UpdateOrgDocumentInput,
  type WorkspaceRole,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RolesService } from '../../core/roles/roles.service';
import { AccessService } from '../../core/access/access.service';
import { principalSubjectRelation } from '../../core/access/access-schema';
import { DocsService } from '../../core/docs/docs.service';
import { ApprovalsService } from '../../core/approvals/approvals.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { JobsService } from '../../core/jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { fullName } from '../../shared/utils/user-name';
import { DOCUMENTS_FILE_JOB, DOCUMENTS_GENERATE_JOB, DOCUMENTS_PDF_JOB } from './documents.constants';

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
    private readonly chatter: ChatterService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
    private readonly approvals: ApprovalsService,
  ) {}

  /** Ставится на bootstrap модулем — см. DocumentsModule (разрыв цикла с Процессами). */
  private processes: ProcessesStarter | null = null;
  setProcessesService(svc: ProcessesStarter | null): void {
    this.processes = svc;
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
    const row = await this.db.docType.create({
      data: {
        workspaceId,
        name: dto.name,
        category: dto.category ?? 'general',
        numberFormat: dto.numberFormat ?? DEFAULT_DOC_NUMBER_FORMAT,
        visibility: dto.visibility ?? 'managers',
        toPersonalFile: dto.toPersonalFile ?? false,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
    return this.serializeType(row, 0);
  }

  async updateType(
    userId: string,
    workspaceId: string,
    typeId: string,
    dto: UpdateDocTypeInput,
  ): Promise<DocTypeDto> {
    await this.requireManager(userId, workspaceId);
    const type = await this.typeOrThrow(workspaceId, typeId);
    const row = await this.db.docType.update({
      where: { id: type.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.numberFormat !== undefined ? { numberFormat: dto.numberFormat } : {}),
        ...(dto.visibility !== undefined ? { visibility: dto.visibility } : {}),
        ...(dto.toPersonalFile !== undefined ? { toPersonalFile: dto.toPersonalFile } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
      include: { _count: { select: { templates: true } } },
    });
    return this.serializeType(row, row._count.templates);
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
      where: { docTypeId: type.id, status: { in: ['draft', 'in_review'] } },
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
    if (!tpl.fileId) throw new BadRequestException('У шаблона нет бланка — загрузите файл документа');
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
      fields: (r.fields ?? []) as unknown as DocFormFieldDto[],
    }));
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

    const subjectUserId = dto.subjectUserId ?? userId;
    await this.assertSubject(userId, workspaceId, role, subjectUserId);

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
          createdById: userId,
          fields: fields as object,
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
        uniqueKey: `doc:gen:${row.id}`,
      });
      return row;
    });
    return this.get(userId, created.id);
  }

  async list(userId: string, workspaceId: string, q: ListOrgDocumentsInput): Promise<OrgDocumentListDto> {
    const role = await this.requireTeam(userId, workspaceId);
    const where = await this.visibilityWhere(userId, workspaceId, role);
    const filters: Record<string, unknown>[] = [where];
    if (q.docTypeId) filters.push({ docTypeId: q.docTypeId });
    if (q.status) filters.push({ status: q.status });
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
    const names = await this.namesOf(rows.flatMap((r) => [r.subjectUserId, r.createdById]));
    return {
      items: rows.map((r) => this.serializeDocument(r, r.docType, r.template, names)),
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
    const names = await this.namesOf([row.subjectUserId, row.createdById]);
    const dto = this.serializeDocument(row, row.docType, row.template, names);
    // Заявку заводит НОДА маршрута, поэтому колонка карточки всегда пуста — спрашиваем
    // живую у движка решений: без неё с карточки не было пути к маршруту согласования.
    dto.approvalRequestId =
      row.approvalRequestId ?? (await this.approvals.activeRequestIdForRef(ORG_DOCUMENT_REF_TYPE, row.id));
    dto.can = {
      edit: this.canEdit(userId, row, role),
      // Ровно те статусы, которые принимает сам `submit`: пока здесь стоял только
      // 'draft', возвращённый на доработку документ правился, но отправить его было
      // нечем — кнопки не было, хотя ручка сработала бы.
      submit: this.canEdit(userId, row, role) && DOC_EDITABLE_STATUSES.includes(row.status as DocStatus),
      cancel:
        (row.createdById === userId || this.isManager(role)) &&
        ['draft', 'in_review', 'rejected'].includes(row.status),
      // Возврат в черновик — только пока по документу никто не решает; живую заявку
      // проверяем здесь же, чтобы кнопка не появлялась там, где ручка откажет.
      withdraw:
        (row.createdById === userId || this.isManager(role)) &&
        row.status === 'in_review' &&
        !(await this.approvals.activeRequestIdForRef(ORG_DOCUMENT_REF_TYPE, row.id)),
      manage: this.isManager(role),
    };
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
    await this.db.orgDocument.update({
      where: { id: row.id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.fields !== undefined ? { fields: (await this.sanitizeFields(dto.fields, row.templateId)) as object } : {}),
        ...(dto.subjectUserId !== undefined ? { subjectUserId: dto.subjectUserId } : {}),
      },
    });
    // Данные формы поменялись — бланк пересобираем: иначе в документе останется
    // старое значение, а человек будет уверен, что отправил новое.
    if (dto.fields !== undefined) {
      await this.jobs.enqueue(null, {
        type: DOCUMENTS_GENERATE_JOB,
        payload: { documentId: row.id },
        uniqueKey: `doc:gen:${row.id}:${Date.now()}`,
      });
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
    if (!row.fileId) throw new BadRequestException('Документ ещё формируется — попробуйте через минуту');

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
    return this.get(userId, row.id);
  }

  async cancel(userId: string, documentId: string): Promise<OrgDocumentDto> {
    const row = await this.documentOrThrow(documentId);
    const role = await this.requireTeam(userId, row.workspaceId);
    if (row.createdById !== userId && !this.isManager(role)) {
      throw new ForbiddenException('Отменить может автор или Менеджер+');
    }
    if (!['draft', 'in_review', 'rejected'].includes(row.status)) {
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
    return this.get(userId, row.id);
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
        uniqueKey: `doc:gen:${row.id}`,
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

  /** Заказать PDF-отпечаток текущего содержимого (идемпотентно, контентный ключ у движка). */
  async requestPdf(documentId: string): Promise<{ ready: boolean }> {
    const row = await this.documentOrThrow(documentId);
    if (!row.documentId || !this.docs.enabled) return { ready: false };
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
   * Значения формы подачи — только ОБЪЯВЛЕННЫЕ шаблоном ключи и только примитивы.
   *
   * Эти значения уходят в рендер отдельным слоем и в анкету запуска маршрута, поэтому
   * свободный JSON здесь означал две дыры разом: ключ «Организация» подменял РЕКВИЗИТЫ
   * в готовом документе (слой потребителя ложился поверх групп реестра), а ключ вида
   * `_subprocessDepth` — служебные переменные движка процессов.
   */
  private async sanitizeFields(
    raw: Record<string, unknown>,
    templateId: string | null,
  ): Promise<Record<string, unknown>> {
    if (!templateId) return {};
    const tpl = await this.db.docTemplate.findUnique({
      where: { id: templateId },
      select: { fields: true },
    });
    const declared = new Set(
      ((tpl?.fields ?? []) as unknown as DocFormFieldDto[])
        .map((f) => f?.key)
        .filter((k): k is string => typeof k === 'string' && !k.startsWith('_')),
    );
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw ?? {})) {
      if (!declared.has(key)) continue;
      if (value === null || value === undefined) continue;
      if (typeof value === 'object') continue; // вложенные объекты подменяли группы целиком
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
    return {
      OR: [
        { createdById: userId },
        { subjectUserId: userId },
        ...(decidingIds.length ? [{ id: { in: decidingIds } }] : []),
        ...(teamTypeIds.length ? [{ docTypeId: { in: teamTypeIds } }] : []),
        // «Отдел сотрудника»: вид открыт тем, кто работает в одном отделе со СТОРОНОЙ
        // документа. Оба условия — одной строкой SQL (implicit AND в Prisma).
        ...(depTypeIds.length && coworkerIds.length
          ? [{ docTypeId: { in: depTypeIds }, subjectUserId: { in: coworkerIds } }]
          : []),
      ],
    };
  }

  private async canView(
    userId: string,
    row: { id: string; createdById: string; subjectUserId: string | null; docTypeId: string; workspaceId: string },
    role: WorkspaceRole,
  ): Promise<boolean> {
    if (this.isManager(role)) return true;
    if (row.createdById === userId || row.subjectUserId === userId) return true;
    // Участник маршрута видит предмет своего решения — иначе он подписывает вслепую.
    if (await this.isDecider(userId, row.id)) return true;
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
      toPersonalFile: boolean;
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
      toPersonalFile: row.toPersonalFile,
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
      documentId: string | null;
      fileId: string | null;
      fields: unknown;
      selfService: boolean;
      status: string;
      version: number;
      createdAt: Date;
      updatedAt: Date;
    },
    type: { name: string; category: string },
    hasRoute: boolean,
  ): DocTemplateDto {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      docTypeId: row.docTypeId,
      docTypeName: type.name,
      category: type.category as DocCategory,
      name: row.name,
      description: row.description,
      documentId: row.documentId,
      fileId: row.fileId,
      fields: (row.fields ?? []) as DocFormFieldDto[],
      selfService: row.selfService,
      status: row.status as 'draft' | 'published',
      version: row.version,
      hasRoute,
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
      createdById: string;
      documentId: string | null;
      fileId: string | null;
      pdfFileId: string | null;
      fields: unknown;
      approvalRequestId: string | null;
      processInstanceId: string | null;
      parentDocumentId: string | null;
      signedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    },
    type: { name: string; category: string },
    template: { name: string } | null,
    names: Map<string, string>,
  ): OrgDocumentDto {
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
      createdById: row.createdById,
      createdByName: names.get(row.createdById) ?? null,
      documentId: row.documentId,
      fileId: row.fileId,
      pdfFileId: row.pdfFileId,
      fields: (row.fields ?? {}) as Record<string, unknown>,
      approvalRequestId: row.approvalRequestId,
      processInstanceId: row.processInstanceId,
      parentDocumentId: row.parentDocumentId,
      signedAt: row.signedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}


