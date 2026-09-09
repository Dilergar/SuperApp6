import { Injectable, Logger } from '@nestjs/common';
import {
  HR_LIBRARY,
  HR_LIBRARY_MAP,
  type HrLibraryInstallInput,
  type HrLibraryItem,
  type HrLibraryItemDto,
} from '@superapp/shared';
import { SOURCE_LOCALE, coerceLocale, type Locale } from '@superapp/i18n';
import { DatabaseService } from '../../shared/database/database.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { badRequest, notFound } from '../../shared/errors/api-error';
import { ChatterService } from '../../core/chatter/chatter.service';
import { DocumentsService } from '../documents/documents.service';
import { ProcessesService } from '../processes/processes.service';
import { HrService } from './hr.service';
import { HR_MEMBER_REF_TYPE } from './hr.constants';

/**
 * Библиотека кадровых бланков РК (Этап 3 КЭДО). Каталог живёт В КОДЕ
 * (`hr-library.ts` в shared); установка = мастер: вид + builder-шаблон
 * (опубликованный) + ОПУБЛИКОВАННЫЙ маршрут с проставленным подписантом.
 *
 * Подписанта мастер спрашивает ОДИН раз и проставляет во все шаги: маршрут-
 * черновик, который менеджер забыл донастроить, — это действие, которое
 * никогда не применится.
 *
 * ЯЗЫК СОБРАННОГО МАРШРУТА — язык ИСТОЧНИКА: имя маршрута, подписи нод и
 * заголовки шагов ложатся в БД и переживают смену языка того, кто нажал
 * «Установить» (docs/i18n.md). Переводятся они при чтении — реестром нод и
 * каталогом, а не этой строкой.
 *
 * ЯЗЫК БУМАГИ — свой: формулировки бланков записаны по-русски (`item.language`),
 * поэтому имя вида и имя шаблона, которые ложатся рядом с бумагой и печатаются
 * вместе с ней, тоже берутся в этом языке. Название и описание в мастере
 * установки — наоборот, интерфейс: они в языке зрителя.
 */
@Injectable()
export class HrLibraryService {
  private readonly logger = new Logger(HrLibraryService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly chatter: ChatterService,
    private readonly documents: DocumentsService,
    private readonly processes: ProcessesService,
    private readonly hr: HrService,
    private readonly i18n: I18nService,
  ) {}

  /** Слово в языке источника — снимок, который ложится в документ маршрута */
  private src(key: string, values?: Record<string, string | number>): string {
    return this.i18n.translateFor(SOURCE_LOCALE, key, values);
  }

  /** Ветка каталога бланка: слов в самом каталоге бланков нет (docs/i18n.md) */
  private itemKey(item: { key: string }, leaf: string): string {
    return `hr.library.item.${item.key}.${leaf}`;
  }

  /** Слово ЭКРАНА (мастер установки) — в языке запроса */
  private itemText(item: { key: string }, leaf: string): string {
    return this.i18n.translate(this.itemKey(item, leaf));
  }

  /** Слово БУМАГИ (имя вида, имя шаблона, подписи полей формы) — в языке бланка */
  private paperText(item: HrLibraryItem, leaf: string): string {
    return this.i18n.translateFor(this.languageOf(item), this.itemKey(item, leaf));
  }

  private languageOf(item: HrLibraryItem): Locale {
    return coerceLocale(item.language, SOURCE_LOCALE);
  }

  async list(viewerId: string, workspaceId: string): Promise<HrLibraryItemDto[]> {
    await this.hr.requireManager(viewerId, workspaceId);
    const installs = await this.db.docTemplateLibraryInstall.findMany({ where: { workspaceId } });
    const byKey = new Map(installs.map((i) => [i.libraryKey, i]));
    return HR_LIBRARY.map((item) => {
      const inst = byKey.get(item.key);
      return {
        key: item.key,
        // Витрина мастера — ИНТЕРФЕЙС: слово в языке зрителя
        title: this.itemText(item, 'title'),
        description: this.itemText(item, 'description'),
        category: item.docType.category,
        signatureLevel: item.docType.signatureLevel,
        version: item.version,
        installed: !!inst,
        installedVersion: inst?.version ?? null,
        templateId: inst?.templateId ?? null,
        updateAvailable: !!inst && inst.version < item.version,
      };
    });
  }

  /**
   * Установить бланк: вид (или переиспользовать одноимённый живой) + шаблон
   * (published) + маршрут (published, с принятыми предупреждениями). Повторная
   * установка того же ключа = обновление шаблона новой версией каталога
   * (поданные документы не трогаются — у них снимок builderDoc).
   */
  async install(actorId: string, workspaceId: string, dto: HrLibraryInstallInput): Promise<HrLibraryItemDto> {
    await this.hr.requireManager(actorId, workspaceId);
    const item = HR_LIBRARY_MAP[dto.key];
    if (!item) throw notFound('hr.libraryItemNotFound');
    if (dto.signerPositionId) {
      const pos = await this.db.staffPosition.findFirst({
        where: { id: dto.signerPositionId, workspaceId },
        select: { id: true },
      });
      if (!pos) throw badRequest('hr.librarySignerPositionNotFound');
    }
    if (dto.signerUserId) {
      const role = await this.hr.roleOf(dto.signerUserId, workspaceId);
      if (!role || role === 'contractor') throw badRequest('hr.librarySignerNotEmployed');
    }

    const existing = await this.db.docTemplateLibraryInstall.findUnique({
      where: { workspaceId_libraryKey: { workspaceId, libraryKey: item.key } },
    });

    // 1) Вид: одноимённый живой переиспользуем (виды — справочник организации,
    // дубль имени запрещён партиальным уникумом)
    const docTypeName = this.paperText(item, 'docType');
    const templateName = this.paperText(item, 'template');
    let docType = await this.db.docType.findFirst({
      where: { workspaceId, name: docTypeName, archivedAt: null },
    });
    if (!docType) {
      const created = await this.documents.createType(actorId, workspaceId, {
        name: docTypeName,
        category: item.docType.category,
        numberFormat: item.docType.numberFormat,
        visibility: item.docType.visibility,
        signatureLevel: item.docType.signatureLevel,
        toPersonalFile: item.docType.toPersonalFile,
        specialDelivery: item.docType.specialDelivery ?? false,
        retentionYears: item.docType.retentionYears ?? null,
      });
      docType = await this.db.docType.findUniqueOrThrow({ where: { id: created.id } });
    }
    await this.db.docType.update({ where: { id: docType.id }, data: { libraryKey: item.key } });

    // 2) Шаблон: при обновлении правим установленный, иначе создаём и публикуем
    let templateId = existing?.templateId ?? null;
    const liveTemplate = templateId
      ? await this.db.docTemplate.findFirst({ where: { id: templateId, workspaceId, archivedAt: null } })
      : null;
    if (liveTemplate) {
      await this.db.docTemplate.update({
        where: { id: liveTemplate.id },
        data: {
          builderDoc: item.builderDoc as object,
          fields: this.formFields(item) as object[],
          selfService: item.template.selfService,
          language: this.languageOf(item),
          version: { increment: 1 },
        },
      });
      templateId = liveTemplate.id;
    } else {
      const created = await this.documents.createTemplate(actorId, workspaceId, {
        docTypeId: docType.id,
        name: templateName,
        description: this.itemText(item, 'description'),
        kind: 'builder',
        // Язык БУМАГИ у библиотечного бланка свой: тексты ТК РК записаны по-русски
        language: this.languageOf(item),
        builderDoc: item.builderDoc as never,
        fields: this.formFields(item) as never,
        selfService: item.template.selfService,
      });
      templateId = created.id;
      await this.documents.publishTemplate(actorId, workspaceId, templateId);
    }
    await this.db.docTemplate.update({ where: { id: templateId! }, data: { libraryKey: item.key } });

    // 3) Запись установки — ДО сборки маршрута: если маршрут не опубликуется,
    // повторная установка обязана найти уже созданный шаблон, а не завести
    // второй (вид переиспользуется по имени, а шаблон — только по этой записи).
    await this.db.docTemplateLibraryInstall.upsert({
      where: { workspaceId_libraryKey: { workspaceId, libraryKey: item.key } },
      update: { version: item.version, docTypeId: docType.id, templateId: templateId! },
      create: {
        workspaceId,
        libraryKey: item.key,
        version: item.version,
        docTypeId: docType.id,
        templateId: templateId!,
        processId: null,
        installedById: actorId,
      },
    });

    // 4) Маршрут: существующий опубликованный оставляем; нет — собираем и публикуем
    let processId = existing?.processId ?? null;
    const liveProcess = processId
      ? await this.db.processDefinition.findFirst({ where: { id: processId, workspaceId, status: 'active' } })
      : null;
    if (!liveProcess) {
      processId = await this.buildAndPublishRoute(actorId, workspaceId, item, templateId!, dto);
      await this.db.docTemplateLibraryInstall.update({
        where: { workspaceId_libraryKey: { workspaceId, libraryKey: item.key } },
        data: { processId },
      });
    }

    await this.chatter
      .log(null, {
        refType: 'workspace',
        refId: workspaceId,
        workspaceId,
        actorId,
        actorName: await this.hr.nameOf(actorId),
        typeKey: 'hr.library_installed',
        // Вечная запись хроники хранит КЛЮЧ бланка: слово к нему подберёт читатель
        payload: { titleKey: this.itemKey(item, 'title') },
      })
      .catch(() => undefined);

    const list = await this.list(actorId, workspaceId);
    return list.find((i) => i.key === item.key)!;
  }

  /**
   * Поля формы подачи с подписями в языке БУМАГИ: ключ поля — имя тега
   * («{Form.LeavePeriod}»), слово к нему живёт в каталоге.
   */
  private formFields(item: HrLibraryItem): { key: string; label: string; kind: string; required?: boolean }[] {
    return item.template.fields.map((f) => ({
      key: f.key,
      label: this.paperText(item, `field.${f.key}`),
      kind: f.kind,
      ...(f.required !== undefined ? { required: f.required } : {}),
    }));
  }

  /** Собрать документ-канвас маршрута по декларативной схеме бланка и опубликовать */
  private async buildAndPublishRoute(
    actorId: string,
    workspaceId: string,
    item: HrLibraryItem,
    templateId: string,
    signer: { signerUserId?: string; signerPositionId?: string },
  ): Promise<string | null> {
    const assignee = signer.signerUserId
      ? { assigneeMode: 'member', assigneeUserId: signer.signerUserId }
      : { assigneeMode: 'position', positionId: signer.signerPositionId, rule: 'any' };

    interface Node {
      id: string;
      type: string;
      label?: string;
      config: Record<string, unknown>;
      position?: { x: number; y: number };
    }
    const nodes: Node[] = [];
    const edges: { id: string; from: string; fromPort?: string; to: string; toPort?: string }[] = [];
    let x = 80;
    const step = 280;
    let prev: { id: string; port: string } | null = null;
    let eseq = 0;
    const link = (to: string) => {
      if (prev) edges.push({ id: `e${++eseq}`, from: prev.id, fromPort: prev.port, to, toPort: 'main' });
    };
    const addHuman = (id: string, cfg: Record<string, unknown>, label: string) => {
      nodes.push({ id, type: 'human.approval', label, config: cfg, position: { x: (x += step), y: 160 } });
      link(id);
      edges.push({ id: `e${++eseq}`, from: id, fromPort: 'rejected', to: 'refused', toPort: 'main' });
      prev = { id, port: 'approved' };
    };

    nodes.push({
      id: 'trigger',
      type: 'trigger.document',
      label: this.src('processes.node.trigger.document.title'),
      config: { templateId },
      position: { x, y: 160 },
    });
    prev = { id: 'trigger', port: 'main' };

    const r = item.route;
    if (r.managerApproval) {
      // Заявление согласует РУКОВОДИТЕЛЬ СТОРОНЫ документа — по оргструктуре в момент
      // шага (вершина → владелец), а не подписант организации: поимённый согласующий
      // в 11 бланках был временной заплаткой до появления структуры.
      addHuman(
        'approve',
        {
          kind: 'approval',
          title: this.src('hr.library.step.approveTitle', { name: this.src(this.itemKey(item, 'template')) }),
          assigneeMode: 'subject_manager',
        },
        this.src('hr.library.step.managerApproval'),
      );
    }
    if (r.employerSign) {
      addHuman(
        'sign_employer',
        {
          kind: 'signature',
          signatureLevel: item.docType.signatureLevel,
          title: this.src('hr.library.step.signTitle', { name: this.src(this.itemKey(item, 'template')) }),
          ...assignee,
        },
        this.src('hr.library.step.employerSign'),
      );
    }
    if (r.subjectSign) {
      addHuman(
        'sign_subject',
        {
          kind: 'signature',
          signatureLevel: item.docType.signatureLevel,
          title: this.src('hr.library.step.signTitle', { name: this.src(this.itemKey(item, 'template')) }),
          assigneeMode: 'subject',
        },
        this.src('hr.library.step.subjectSign'),
      );
    }
    if (r.subjectAck) {
      addHuman(
        'ack_subject',
        {
          kind: 'acknowledgement',
          title: this.src('hr.library.step.ackTitle', { name: this.src(this.itemKey(item, 'template')) }),
          assigneeMode: 'subject',
        },
        this.src('hr.library.step.subjectAck'),
      );
    }
    if (r.register) {
      nodes.push({ id: 'register', type: 'doc.register', label: this.src('processes.node.doc.register.title'), config: {}, position: { x: (x += step), y: 160 } });
      link('register');
      prev = { id: 'register', port: 'main' };
    }
    if (r.file) {
      nodes.push({ id: 'file', type: 'doc.file', label: this.src('processes.node.doc.file.title'), config: {}, position: { x: (x += step), y: 160 } });
      link('file');
      prev = { id: 'file', port: 'main' };
    }
    if (r.hrApply) {
      nodes.push({ id: 'apply', type: 'hr.apply', label: this.src('processes.node.hr.apply.title'), config: {}, position: { x: (x += step), y: 160 } });
      link('apply');
      prev = { id: 'apply', port: 'main' };
    }
    nodes.push({ id: 'done', type: 'end', label: this.src('hr.library.step.done'), config: {}, position: { x: (x += step), y: 160 } });
    link('done');
    nodes.push({ id: 'refused', type: 'end', label: this.src('hr.library.step.refused'), config: {}, position: { x: 380, y: 380 } });

    const surface = item.docType.category === 'hr' ? 'documents.hr' : 'documents.general';
    try {
      const def = await this.processes.createDefinition(actorId, workspaceId, {
        name: this.src('hr.library.routeName', { title: this.src(this.itemKey(item, 'title')) }),
        description: this.src('hr.library.routeDescription', { title: this.src(this.itemKey(item, 'title')) }),
        surface,
        document: { nodes, edges, form: [] } as never,
      });
      // Предупреждения правил ТК РК принимаем ПОИМЁННО (мастер собирает маршрут,
      // удовлетворяющий кадровому минимуму; остаточные предупреждения — осознанно).
      const { issues } = await this.processes.validateDefinition(actorId, workspaceId, def.id);
      const warnKeys = [...new Set(issues.filter((i) => i.severity === 'warning' && i.ruleKey).map((i) => i.ruleKey!))];
      await this.processes.publish(actorId, workspaceId, def.id, warnKeys);
      return def.id;
    } catch (e) {
      // Маршрут не собрался (например, ошибка компиляции из-за версии нод) —
      // установка честно падает: бланк без маршрута это действие, которое
      // никогда не применится.
      this.logger.error(`library route "${item.key}": ${(e as Error).message}`);
      throw badRequest('hr.libraryRouteNotPublished', { reason: (e as Error).message });
    }
  }
}
