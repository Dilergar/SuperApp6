import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import { ORG_DOCUMENT_REF_TYPE, driveNameKey } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { JobDiscardError, JobsRegistry } from '../../core/jobs/jobs.registry';
import { FilesService } from '../../core/files/files.service';
import { DocsService } from '../../core/docs/docs.service';
import { DocsRenditionService } from '../../core/docs/docs-rendition.service';
import { TemplateRenderService } from '../../core/templates/template-render.service';
import { TemplateCompileError, TemplateDataError } from '../../core/templates/template.types';
import { DriveService } from '../drive/drive.service';
import { AccessService } from '../../core/access/access.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { DocumentsService } from './documents.service';
import {
  DOCUMENTS_FILE_JOB,
  DOCUMENTS_FILE_PROFILE,
  DOCUMENTS_GENERATE_JOB,
  DOCUMENTS_PDF_JOB,
  DOCUMENTS_QUEUE,
  DOCX_MIME_TYPE,
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
    private readonly files: FilesService,
    private readonly docs: DocsService,
    private readonly rendition: DocsRenditionService,
    private readonly templates: TemplateRenderService,
    private readonly drive: DriveService,
    private readonly access: AccessService,
    private readonly chatter: ChatterService,
    private readonly documents: DocumentsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(DOCUMENTS_GENERATE_JOB, (p) => this.generate(String(p.documentId)), {
      queue: DOCUMENTS_QUEUE,
      queueConcurrency: 3,
      maxAttempts: 4,
      leaseMs: 5 * 60 * 1000,
    });
    this.registry.register(DOCUMENTS_PDF_JOB, (p) => this.snapshotPdf(String(p.documentId)), {
      queue: DOCUMENTS_QUEUE,
      maxAttempts: 5,
      leaseMs: 10 * 60 * 1000,
    });
    this.registry.register(DOCUMENTS_FILE_JOB, (p) => this.fileToDrive(String(p.documentId)), {
      queue: DOCUMENTS_QUEUE,
      maxAttempts: 5,
      leaseMs: 5 * 60 * 1000,
    });
  }

  // ============================================================
  // Сборка документа по шаблону
  // ============================================================

  /**
   * Заполнить бланк шаблона данными: группы реестра `core/templates` (Организация,
   * Сотрудник) + значения формы подачи. Результат — новый .docx карточки; повторный
   * заход пересобирает содержимое ЖИВОГО файла на месте, поэтому id вложения и
   * открытая вкладка редактора остаются рабочими.
   */
  private async generate(documentId: string): Promise<void> {
    const doc = await this.db.orgDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new JobDiscardError('документ удалён');
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
      await withTempFile(name, bytes, (filePath) =>
        this.files.replaceContent({ fileId: doc.fileId!, sourcePath: filePath, actorId: doc.createdById }),
      );
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

  /** Значения формы подачи под группой «Документ» + сами поля россыпью */
  private documentValues(doc: {
    title: string;
    number: string | null;
    createdAt: Date;
    fields: unknown;
  }): Record<string, unknown> {
    const fields = (doc.fields ?? {}) as Record<string, unknown>;
    return {
      ...fields,
      Документ: {
        Название: doc.title,
        Номер: doc.number ?? '',
        Дата: doc.createdAt,
      },
    };
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
  private async fileToDrive(documentId: string): Promise<void> {
    const doc = await this.db.orgDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new JobDiscardError('документ удалён');
    if (!doc.fileId) throw new JobDiscardError('у документа нет файла');
    if (doc.registryNodeId && (doc.personalNodeId || !(await this.wantsPersonal(doc.docTypeId)))) return;

    const type = await this.db.docType.findUniqueOrThrow({ where: { id: doc.docTypeId } });
    const space = await this.drive.getOrCreateSpace('workspace', doc.workspaceId);
    if (!space.rootId) throw new JobDiscardError('у диска организации нет корня');

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
      // Актор — АВТОР документа: файл ингестился под ним (uploaderId), и для Диска он
      // «свой». Подставить 'system' нельзя — тот же метод счёл бы файл чужим и полез
      // бы делать копию (или ответил 404), а нам нужен один файл в двух местах.
      const node = await this.drive.placeFile(doc.createdById, {
        spaceId: space.id,
        parentId: typeFolder.id,
        fileId: doc.fileId,
        name: this.fileName(doc),
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

  private fileName(doc: { number: string | null; title: string }): string {
    const base = doc.number ? `${doc.number} ${doc.title}` : doc.title;
    return `${base}.docx`.replace(/[\\/:*?"<>|]/g, '-');
  }
}

/** Временный файл под инжест собранных байтов (движок файлов принимает путь) */
async function withTempFile<T>(
  name: string,
  bytes: Buffer,
  fn: (filePath: string) => Promise<T>,
): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sa6-doc-'));
  const filePath = path.join(dir, name.replace(/[\\/]/g, '-'));
  await fsp.writeFile(filePath, bytes);
  try {
    return await fn(filePath);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export { DocumentsService };
