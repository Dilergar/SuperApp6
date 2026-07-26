import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import {
  DOCS_LIMITS,
  documentFormatForFile,
  fileExtension,
  formatTimeRange,
  type DocsStatusDto,
  type DocumentAccess,
  type DocumentDto,
  type DocumentFromFileInput,
  type DocumentOpenDto,
  type DocumentOpenInput,
  type DocumentUpdateInput,
  type FileOwnerType,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { AccessService } from '../access/access.service';
import { FilesService } from '../files/files.service';
import { FilesRefRegistry } from '../files/files-ref.registry';
import { ChatterService, type ChatterLogInput } from '../chatter/chatter.service';
import { ChatterRefRegistry } from '../chatter/chatter-ref.registry';
import { DocsEditorClient } from './docs-editor.client';
import { DocsRouterService } from './docs-router.service';
import { DocsTokenService } from './docs-token.service';
import { DocsVersionsService } from './docs-versions.service';
import { DocsRenditionService } from './docs-rendition.service';

type DocumentRow = NonNullable<Awaited<ReturnType<DatabaseService['document']['findUnique']>>>;
type SessionRow = NonNullable<Awaited<ReturnType<DatabaseService['documentSession']['findUnique']>>>;

/** Место, через которое человек пришёл к документу (кнопка на вложении задачи/чата) */
export interface DocsPlaceCtx {
  refType: string;
  refId: string;
}

/** Проверенный контекст запроса WOPI-клиента */
export interface WopiContext {
  doc: DocumentRow;
  userId: string;
  canWrite: boolean;
}

/**
 * Несовпадение блокировки. По протоколу отвечаем 409 и ОБЯЗАТЕЛЬНО заголовком
 * X-WOPI-Lock с текущей строкой — по нему клиент понимает, чья блокировка.
 */
export class WopiLockConflict extends Error {
  constructor(readonly currentLock: string) {
    super('WOPI lock mismatch');
  }
}

/** Файл изменился вне редактора → 409 + тело {"COOLStatusCode": 1010} */
export class WopiTimestampConflict extends Error {
  constructor() {
    super('WOPI timestamp mismatch');
  }
}

/**
 * Движок документов (core/docs) — 12-й платформенный. Ядро: документ = ЖИВОЙ файл
 * core/files, который WOPI-клиент (Collabora) мутирует на месте; вехи-версии — снимки.
 * Здесь живут: разбор токена, права (resolveMode), сессии-блокировки и приём правок.
 */
@Injectable()
export class DocsService implements OnModuleInit {
  private readonly logger = new Logger(DocsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly files: FilesService,
    private readonly filesRegistry: FilesRefRegistry,
    private readonly editor: DocsEditorClient,
    private readonly router: DocsRouterService,
    private readonly tokens: DocsTokenService,
    private readonly versions: DocsVersionsService,
    private readonly rendition: DocsRenditionService,
    private readonly chatter: ChatterService,
    private readonly chatterRegistry: ChatterRefRegistry,
    private readonly events: EventBusService,
  ) {}

  onModuleInit(): void {
    // Живой черновик пришит к документу связью refType='document' — иначе удаление
    // сообщения с вложением прибрало бы файл сиротой прямо под открытым редактором.
    // canView здесь смотрит ТОЛЬКО на явные гранты документа: наследование «от места»
    // считает сам движок файлов, обходя привязки, и вызов его отсюда закольцевался бы.
    this.filesRegistry.register(
      'document',
      {
        canView: (viewerId, documentId) => this.canViewByGrant(viewerId, documentId),
        // Прикреплять файлы «к документу» руками нельзя: единственную связь ставит движок
        // при оживлении файла (linkSystemInTx).
        canAttach: async () => false,
        // У файла не осталось настоящих мест (удалили сообщение, сняли вложение) —
        // документу тоже конец: архивируем, гасим выданные пропуска и снимаем якорь,
        // после чего движок файлов доводит уборку до конца и возвращает квоту.
        onOrphaned: (documentId) => this.archive(documentId),
      },
      // Связь служебная: она держит черновик под открытым редактором, но местом файла
      // не является и не имеет права делать его вечным.
      { anchorOnly: true },
    );

    // Хроника САМОГО документа: «кто когда правил» видно и у файла, который не лежит ни
    // в задаче, ни в чате — там это единственное место, где такая история вообще есть.
    this.chatterRegistry.register('document', {
      canView: async (viewerId, documentId) => {
        const doc = await this.db.document.findUnique({ where: { id: documentId } });
        if (!doc) return false;
        return (await this.resolveMode(viewerId, doc)) !== 'none';
      },
    });

    // Снимок-веха: виден тому же, кому виден сам документ. Рекурсии нет — цепочка
    // упирается в гранты документа и в видимость ЖИВОГО файла, но не возвращается сюда.
    this.filesRegistry.register('document_version', {
      canView: async (viewerId, versionId) => {
        const version = await this.db.documentVersion.findUnique({
          where: { id: versionId },
          select: { documentId: true },
        });
        if (!version) return false;
        const doc = await this.db.document.findUnique({ where: { id: version.documentId } });
        if (!doc || doc.deletedAt) return false;
        return this.canViewDocument(viewerId, doc);
      },
      canAttach: async () => false,
    });
  }

  getStatus(): DocsStatusDto {
    return { enabled: this.router.enabled, singleNode: this.router.singleNode };
  }

  // ============================================================
  // Жизненный цикл документа
  // ============================================================

  /**
   * Оживить загруженный файл в документ. Это ЯВНЫЙ акт человека (п.9 грилла), а не
   * побочный эффект загрузки: право менять содержимое файла наследуется от места, и
   * автоматическое оживление превращало бы любое вложение в общий редактируемый
   * документ без ведома приславшего.
   *
   * Идемпотентно: у файла может быть только один документ (fileId @unique), повторный
   * вызов возвращает существующий.
   */
  async createFromFile(userId: string, dto: DocumentFromFileInput): Promise<DocumentDto> {
    if (!this.router.enabled) throw new BadRequestException('Редактор документов не подключен');
    const file = await this.db.fileObject.findUnique({ where: { id: dto.fileId } });
    if (!file || file.status !== 'ready') throw new NotFoundException('Файл не найден');
    // Публичные раздаются вечной ссылкой с immutable-кэшем: заменённые байты жили бы
    // в кэшах браузеров и CDN. Документом может стать только приватный файл.
    if (file.visibility !== 'private') throw new BadRequestException('Публичный файл нельзя сделать документом');
    if (file.scanStatus === 'infected') throw new ForbiddenException('Файл помечен как заражённый');

    const format = documentFormatForFile({ name: file.name, mime: file.mime });
    if (!format) throw new BadRequestException('Этот формат нельзя редактировать');
    this.assertOpenable(Number(file.size));

    const ctx = dto.refType && dto.refId ? { refType: dto.refType, refId: dto.refId } : null;
    const existing = await this.db.document.findUnique({ where: { fileId: file.id } });
    if (existing) return this.serialize(existing, await this.resolveMode(userId, existing, ctx));

    // Оживить может тот, кто вправе менять содержимое через место, откуда пришёл, либо
    // сам загрузивший/владелец файла (документ «из своего файла»).
    const allowed = ctx
      ? await this.canEditViaPlace(userId, file.id, ctx)
      : file.uploaderId === userId || (file.ownerType === 'user' && file.ownerId === userId);
    if (!allowed) {
      // Сюда попадает и тот, кто просто хотел ПОСМОТРЕТЬ: пока файл не оживлён,
      // отдельного просмотрщика у него нет. Оживление раздаёт право правки всем
      // участникам места, поэтому первым его делает тот, кто этим правом обладает.
      throw new ForbiddenException(
        'Открыть этот файл как документ может тот, кто вправе его менять (участник места, куда он приложен, или загрузивший). Скачивание доступно всем, кому виден файл.',
      );
    }

    const title = (dto.title ?? this.titleFromFileName(file.name)).slice(0, DOCS_LIMITS.maxTitleLength);
    // Владелец документа = ВЛАДЕЛЕЦ ФАЙЛА, а не тот, кто нажал «Редактировать». Грант
    // владельца вечен и местом не ограничен, поэтому выдавать его актору нельзя: участник
    // чата, ожививший чужое вложение, сохранял бы право правки и после удаления из чата,
    // а «заморозить в только чтение» позволяло бы ему запереть автора в его же файле.
    const ownerUserId = file.uploaderId || (file.ownerType === 'user' ? file.ownerId : '');
    const created = await this.db.$transaction(async (tx) => {
      const doc = await tx.document.create({
        data: {
          fileId: file.id,
          // Владение наследуется от файла: документ файла организации — документ
          // организации (и квота снимков ложится на неё же).
          ownerType: file.ownerType,
          ownerId: file.ownerId,
          createdById: ownerUserId || userId,
          title,
          ext: format.ext,
          // КАНОНИЧЕСКИЙ MIME формата, а не тот, что прислал клиент: браузеры и мобильные
          // регулярно шлют application/octet-stream на офисных файлах (ровно ради этого
          // у documentFormatForFile есть фолбэк по расширению). Сохранив октет-стрим, мы
          // получили бы документ, который правится, но чьи вехи-снимки не проходят
          // белый список MIME профиля и умирают в dead-letter.
          mime: format.mime,
          editorKind: format.editorKind,
        },
      });
      await this.files.linkSystemInTx(tx, {
        fileId: file.id,
        refType: 'document',
        refId: doc.id,
        role: 'content',
        createdById: userId,
      });
      // Явный шеринг документа людям и Группам живёт в core/access — своей таблицы
      // грантов у движка нет намеренно (гранты на Группу работают из коробки).
      if (ownerUserId) {
        await this.access.grant(
          {
            resourceType: 'document',
            resourceId: doc.id,
            relation: 'owner',
            subjectType: 'user',
            subjectId: ownerUserId,
          },
          tx,
        );
      }
      return doc;
    });

    this.logger.log(`документ ${created.id} создан из файла ${file.id} (${format.ext})`);
    await this.logRevival(userId, created, ctx);
    return this.serialize(created, 'edit');
  }

  /**
   * «Файл стал общим редактируемым документом» — событие, которое участники места
   * обязаны увидеть (риск 3): оживление даёт право правки всем, кто может писать в это
   * место, и оно не должно происходить тихо. Пишем в хронику САМОГО МЕСТА (задачи), а
   * не документа — там её читают люди; для мест без хроники (чат) просто пропускаем.
   */
  private async logRevival(userId: string, doc: DocumentRow, ctx: DocsPlaceCtx | null): Promise<void> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    const actorName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || null;

    // Первая строка собственной истории документа — она есть всегда, даже без места
    await this.chatter.log(null, {
      refType: 'document',
      refId: doc.id,
      actorId: userId,
      actorName,
      typeKey: 'document.created',
      payload: { title: doc.title, documentId: doc.id },
    });
    if (!ctx) return;

    if (this.chatterRegistry.get(ctx.refType)) {
      await this.chatter.log(null, {
        refType: ctx.refType,
        refId: ctx.refId,
        actorId: userId,
        actorName,
        typeKey: 'task.document_created',
        payload: { title: doc.title, documentId: doc.id },
      });
      return;
    }

    // У места нет хроники (сообщение чата) — объявляем событие на шину, плашку в чате
    // ставит мессенджер. Раздача права правки не должна происходить тихо НИГДЕ, а не
    // только там, где хроника уже есть. Шина здесь уместна: потеря плашки не отбирает
    // и не выдаёт прав (они считаются от места на каждом запросе), это уведомление.
    this.events.emit(
      'docs.document.created',
      { documentId: doc.id, title: doc.title, refType: ctx.refType, refId: ctx.refId, actorId: userId, actorName },
      'docs',
    );
  }

  // ============================================================
  // Версии
  // ============================================================

  async listVersions(userId: string, id: string, ctx?: DocsPlaceCtx | null) {
    const doc = await this.loadOrThrow(id);
    if ((await this.resolveMode(userId, doc, ctx)) === 'none') {
      throw new ForbiddenException('Нет доступа к документу');
    }
    return this.versions.list(doc.id);
  }

  /**
   * «Сохранить версию» вручную. Право — как на правку: веха фиксирует ТЕКУЩЕЕ
   * содержимое, и человек, который не может его менять, не должен управлять историей.
   * reason='pre_sign' — отпечаток перед подписанием (такие вехи ретеншн не трогает).
   */
  async createVersion(
    userId: string,
    id: string,
    reason: 'manual' | 'pre_sign',
    ctx?: DocsPlaceCtx | null,
  ): Promise<void> {
    const doc = await this.loadOrThrow(id);
    if ((await this.resolveMode(userId, doc, ctx)) !== 'edit') {
      throw new ForbiddenException('Версию сохраняет тот, кто может редактировать документ');
    }
    await this.versions.createManual(doc.id, userId, reason);
    await this.logDocEvent(userId, doc, 'document.version_saved', {
      versionNo: doc.lastVersionNo + 1,
    });
  }

  /**
   * Вернуть веху как текущее содержимое. Право — как на правку. Пока документ открыт в
   * редакторе, подменять байты под ним нельзя: редактор держит блокировку и своё
   * состояние в памяти, и подмена обернулась бы конфликтом или потерей правок.
   */
  async restoreVersion(
    userId: string,
    id: string,
    versionId: string,
    ctx?: DocsPlaceCtx | null,
  ): Promise<void> {
    const doc = await this.loadOrThrow(id);
    if ((await this.resolveMode(userId, doc, ctx)) !== 'edit') {
      throw new ForbiddenException('Вернуть версию может тот, кто может редактировать документ');
    }
    if (await this.getActiveSession(doc.id)) {
      throw new ConflictException('Документ сейчас открыт в редакторе — закройте его и повторите');
    }
    const versionNo = await this.versions.restore(doc, versionId, userId);
    await this.logDocEvent(userId, doc, 'document.restored', { versionNo });
  }

  /** Короткая запись в хронику самого документа (вне транзакции — best-effort) */
  private async logDocEvent(
    userId: string,
    doc: DocumentRow,
    typeKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    await this.chatter.log(null, {
      refType: 'document',
      refId: doc.id,
      actorId: userId,
      actorName: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || null,
      typeKey,
      payload: { title: doc.title, documentId: doc.id, ...payload },
    });
  }

  /**
   * Ленивая производная (PDF-отпечаток / текст для ИИ). Право — как на просмотр:
   * это то же самое содержимое, только в другом формате.
   */
  async requestRendition(
    userId: string,
    id: string,
    target: 'pdf' | 'text',
    ctx?: DocsPlaceCtx | null,
  ): Promise<{ ready: boolean }> {
    const doc = await this.loadOrThrow(id);
    if ((await this.resolveMode(userId, doc, ctx)) === 'none') {
      throw new ForbiddenException('Нет доступа к документу');
    }
    return this.rendition.request(doc.id, target);
  }

  /** Имя документа по умолчанию — имя файла без расширения */
  private titleFromFileName(name: string): string {
    const ext = fileExtension(name);
    const base = ext ? name.slice(0, -(ext.length + 1)) : name;
    return base.trim() || name;
  }

  async getDocument(userId: string, id: string, ctx?: DocsPlaceCtx | null): Promise<DocumentDto> {
    const doc = await this.loadOrThrow(id);
    const mode = await this.resolveMode(userId, doc, ctx);
    if (mode === 'none') throw new ForbiddenException('Нет доступа к документу');
    return this.serialize(doc, mode);
  }

  /** Переименование и «только чтение» — только владелец документа */
  async update(userId: string, id: string, dto: DocumentUpdateInput): Promise<DocumentDto> {
    const doc = await this.loadOrThrow(id);
    if (!(await this.access.can({ type: 'user', id: userId }, 'document.manage', doc.id))) {
      throw new ForbiddenException('Настройки документа меняет владелец');
    }
    const freezing = dto.mode !== undefined && dto.mode !== doc.mode;
    const updated = await this.db.document.update({
      where: { id: doc.id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.mode !== undefined ? { mode: dto.mode } : {}),
        // Смена режима обязана действовать НЕМЕДЛЕННО, а токены самодостаточны и живут
        // часами: бампаем поколение — все выданные пропуска на этот документ гаснут,
        // редактор переспросит и получит уже «только чтение».
        ...(freezing ? { tokenEpoch: { increment: 1 } } : {}),
      },
    });
    return this.serialize(updated, 'edit');
  }

  /**
   * Закрыть документ навсегда (владелец). Файл при этом НЕ пропадает сам по себе: он
   * остаётся обычным вложением своего места и живёт по правилам движка файлов — пропадает
   * только «документность» (правка в редакторе, история вех).
   */
  async archiveByUser(userId: string, id: string): Promise<void> {
    const doc = await this.loadOrThrow(id);
    if (!(await this.access.can({ type: 'user', id: userId }, 'document.manage', doc.id))) {
      throw new ForbiddenException('Закрыть документ может владелец');
    }
    await this.archive(doc.id);
  }

  /**
   * Архивация — единственная точка конца жизни (кнопка владельца и хук осиротевшего
   * файла). Идемпотентна. Порядок важен: сначала статус и бамп поколения (все выданные
   * пропуска гаснут, authorizeWopi отвечает 404), потом уборка снимков и якоря.
   */
  async archive(documentId: string): Promise<void> {
    const doc = await this.db.document.findUnique({ where: { id: documentId } });
    if (!doc) return;
    if (doc.status === 'active') {
      await this.db.$transaction(async (tx) => {
        await tx.document.updateMany({
          where: { id: doc.id, status: 'active' },
          data: { status: 'archived', tokenEpoch: { increment: 1 } },
        });
        // Открытую сессию закрываем БЕЗ вехи: резать снимок содержимого ровно в тот
        // момент, когда файл уезжает в уборку, — значит создать копию, которую тут же
        // придётся прибирать.
        await tx.documentSession.updateMany({
          where: { documentId: doc.id, status: 'open' },
          data: { status: 'expired', closedAt: new Date() },
        });
        await tx.documentVersion.updateMany({
          where: { documentId: doc.id, status: 'pending' },
          data: { status: 'skipped' },
        });
      });
      this.logger.log(`документ ${doc.id} закрыт (архив)`);
    }

    // Снимки-вехи уходят вместе с документом — кроме подписанных: на них сошлётся ЭЦП,
    // и удалять их нельзя никогда (то же правило, что у ретеншна).
    const versions = await this.db.documentVersion.findMany({
      where: { documentId: doc.id, signed: false },
      select: { id: true },
    });
    for (const v of versions) {
      await this.files.unlinkAllForRef('document_version', v.id).catch(() => undefined);
    }
    await this.files.unlinkSystem(doc.fileId, 'document', doc.id);
  }

  /**
   * Запуск редактора: адрес узла + одноразовая пара «токен + WOPISrc» для form POST.
   *
   * Режим НЕ кладём в WOPISrc: клиент выводит из него ключ документа, и разные WOPISrc
   * дали бы два брокера в памяти редактора на один файл, то есть молча потерянные
   * правки одного из них. Режим живёт в токене и превращается в UserCanWrite.
   */
  async open(userId: string, id: string, dto: DocumentOpenInput): Promise<DocumentOpenDto> {
    const doc = await this.loadOrThrow(id);
    const ctx = dto.refType && dto.refId ? { refType: dto.refType, refId: dto.refId } : null;
    const mode = await this.resolveMode(userId, doc, ctx);
    if (mode === 'none') throw new ForbiddenException('Нет доступа к документу');
    const effective: 'edit' | 'view' = dto.readonly ? 'view' : mode;

    // Размер проверяем и здесь, а не только при оживлении: файл живой и мог вырасти
    // правками с прошлого раза.
    const file = await this.db.fileObject.findUnique({
      where: { id: doc.fileId },
      select: { size: true },
    });
    const size = Number(file?.size ?? 0);
    this.assertOpenable(size);

    // Узел липкий: пока жива правка, все соредакторы обязаны попасть на ТОТ ЖЕ узел.
    const session = await this.getActiveSession(doc.id);
    const base = this.router.resolveBase(doc.id, session?.editorBaseUrl ?? doc.editorBaseUrl);
    if (doc.editorBaseUrl !== base) {
      await this.db.document.update({ where: { id: doc.id }, data: { editorBaseUrl: base } });
    }

    const urlsrc = await this.editor.actionUrl(base, doc.ext, doc.mime);
    const wopiSrc = this.router.wopiSrc(doc.id);
    const { token, expiresAtMs } = this.tokens.issue({
      documentId: doc.id,
      userId,
      canWrite: effective === 'edit',
      epoch: doc.tokenEpoch,
      // Место едет в токене, чтобы authorizeWopi мог перерешать права на каждом запросе
      place: ctx,
    });

    const sep = urlsrc.endsWith('?') || urlsrc.endsWith('&') ? '' : urlsrc.includes('?') ? '&' : '?';
    return {
      documentId: doc.id,
      editorUrl: `${urlsrc}${sep}WOPISrc=${encodeURIComponent(wopiSrc)}&lang=ru-RU`,
      accessToken: token,
      // По протоколу access_token_ttl — МЕТКА ВРЕМЕНИ в мс, а не длительность.
      accessTokenTtl: expiresAtMs,
      mode: effective,
      refreshAt: new Date(expiresAtMs - DOCS_LIMITS.tokenRefreshLeadMin * 60 * 1000).toISOString(),
      warning: this.openWarning(size),
    };
  }

  /**
   * Потолок на ОТКРЫТИЕ в редакторе (скачивание не ограничено никогда). Редактору нужно
   * около 50 МБ памяти на правящего, и слишком большой файл не «медленно откроется», а
   * положит сеанс соседям или покажет человеку белый прямоугольник при полностью зелёном
   * сервере — худший вид отказа. Поэтому отвечаем честно и сразу.
   */
  private assertOpenable(size: number): void {
    if (size > DOCS_LIMITS.openHardLimitBytes) {
      const mb = Math.round(DOCS_LIMITS.openHardLimitBytes / (1024 * 1024));
      throw new BadRequestException(
        `Файл слишком большой для правки в браузере (больше ${mb} МБ) — скачайте его и откройте на компьютере`,
      );
    }
  }

  /** «Жёлтая зона»: открываем, но предупреждаем — иначе долгая загрузка выглядит зависанием */
  private openWarning(size: number): string | null {
    if (size <= DOCS_LIMITS.openSoftLimitBytes) return null;
    return `Файл большой (${Math.round(size / (1024 * 1024))} МБ) — открытие может занять до минуты`;
  }

  private async loadOrThrow(id: string): Promise<DocumentRow> {
    const doc = await this.db.document.findUnique({ where: { id } });
    if (!doc || doc.deletedAt || doc.status !== 'active') throw new NotFoundException('Документ не найден');
    return doc;
  }

  private async serialize(doc: DocumentRow, access: DocumentAccess): Promise<DocumentDto> {
    const live = !!(await this.db.documentSession.findFirst({
      where: { documentId: doc.id, status: 'open', expiresAt: { gt: new Date() } },
      select: { id: true },
    }));
    return {
      id: doc.id,
      fileId: doc.fileId,
      title: doc.title,
      ext: doc.ext,
      mime: doc.mime,
      editorKind: doc.editorKind as DocumentDto['editorKind'],
      mode: doc.mode as DocumentDto['mode'],
      status: doc.status as DocumentDto['status'],
      access,
      ownerType: doc.ownerType as FileOwnerType,
      ownerId: doc.ownerId,
      createdById: doc.createdById,
      lastVersionNo: doc.lastVersionNo,
      lastSavedAt: doc.lastSavedAt?.toISOString() ?? null,
      lastEditorId: doc.lastEditorId,
      live,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  }

  // ============================================================
  // Права
  // ============================================================

  /**
   * Что зритель может с документом. Ключевая асимметрия (риск 3): ПРАВКА наследуется
   * только от той привязки, через которую человек пришёл (ctx), а ПРОСМОТР — как у
   * обычного файла, объединением по всем привязкам. Иначе «переслал документ в свой
   * чат» тихо раздавал бы право менять чужой файл.
   */
  async resolveMode(userId: string, doc: DocumentRow, ctx?: DocsPlaceCtx | null): Promise<DocumentAccess> {
    if (doc.status !== 'active' || doc.deletedAt) return 'none';
    const subject = { type: 'user' as const, id: userId };

    // Владелец («управляет») — единственный, кого не ограничивает «только чтение»:
    // он же его и включил и должен иметь возможность починить документ и разморозить.
    const manages = await this.access.can(subject, 'document.manage', doc.id);
    if (doc.mode === 'readonly' && !manages) {
      return (await this.canViewDocument(userId, doc)) ? 'view' : 'none';
    }
    if (manages) return 'edit';

    if (await this.access.can(subject, 'document.edit', doc.id)) return 'edit';
    if (ctx && (await this.canEditViaPlace(userId, doc.fileId, ctx))) return 'edit';
    if (await this.canViewDocument(userId, doc)) return 'view';
    return 'none';
  }

  /** Правка от места: привязка должна существовать И давать право менять содержимое */
  private async canEditViaPlace(userId: string, fileId: string, ctx: DocsPlaceCtx): Promise<boolean> {
    if (!(await this.files.hasLink(fileId, ctx.refType, ctx.refId))) return false;
    return this.files.canEditContentVia(userId, ctx.refType, ctx.refId);
  }

  /** Просмотр: явный грант ИЛИ обычная видимость файла (объединение по всем привязкам) */
  private async canViewDocument(userId: string, doc: DocumentRow): Promise<boolean> {
    if (await this.canViewByGrant(userId, doc.id)) return true;
    return this.files.canViewFile(userId, doc.fileId);
  }

  /**
   * Только ЯВНЫЕ гранты документа (человеку или Группе). Отдельный предикат нужен,
   * чтобы разорвать кольцо: движок файлов, проверяя доступ, обходит привязки файла и
   * дёргает наш резолвер 'document' — а тот, полези он обратно в canViewFile, звал бы
   * движок файлов снова, и так до переполнения стека.
   */
  private async canViewByGrant(userId: string, documentId: string): Promise<boolean> {
    return this.access.can({ type: 'user', id: userId }, 'document.view', documentId);
  }

  // ============================================================
  // WOPI: контекст запроса
  // ============================================================

  /**
   * Проверка запроса WOPI-клиента. Токен самодостаточный (в БД не лежит), поэтому
   * сверяем подпись+срок, что он выдан именно на этот документ, и что поколение токенов
   * документа не сдвинули (перевод в «только чтение»). Любая осечка — 401: 403 на
   * RefreshLock загоняет COOL в бесконечный цикл ретраев (CollaboraOnline/online#5870).
   *
   * И ГЛАВНОЕ — права ПЕРЕРЕШИВАЮТСЯ здесь на КАЖДОМ запросе (Hard Revoke платформы).
   * Токен живёт часами; полагаться на то, что каждый путь отзыва (убрали из задачи,
   * удалили сообщение, сняли вложение, отозвали грант, удалили документ) не забудет
   * сдвинуть поколение, нельзя — забудет ровно один, и человек ещё полсуток правит и
   * читает чужой файл. Поэтому источник правды один и тот же и для кнопки, и для
   * редактора: resolveMode. Цена — несколько кэшированных проверок доступа на запрос
   * редактора (CheckFileInfo/PutFile ~ раз в полминуты активной правки, RefreshLock —
   * раз в 5 минут), и это несопоставимо дешевле дыры.
   */
  async authorizeWopi(documentId: string, token: string | undefined): Promise<WopiContext> {
    if (!this.router.enabled) throw new NotFoundException('Редактор документов не подключен');
    const verdict = this.tokens.verify(token);
    if (!verdict.ok || !verdict.payload) throw new UnauthorizedException('Токен недействителен');
    const payload = verdict.payload;
    if (payload.d !== documentId) throw new UnauthorizedException('Токен выдан на другой документ');

    const doc = await this.db.document.findUnique({ where: { id: documentId } });
    if (!doc || doc.status !== 'active' || doc.deletedAt) throw new NotFoundException('Документ не найден');
    if (doc.tokenEpoch !== payload.e) throw new UnauthorizedException('Токен отозван');

    const mode = await this.resolveMode(payload.u, doc, this.tokens.placeOf(payload));
    // Доступ пропал совсем — редактор обязан выйти. 401 (а не 403) сознательно: на нём
    // контроллер ещё и закроет брошенную блокировку, а COOL не уйдёт в цикл ретраев.
    if (mode === 'none') throw new UnauthorizedException('Доступ к документу отозван');

    // Право правки могли снять, не трогая просмотр (сняли с задачи роль, документ
    // заморозили): токен на запись мгновенно вырождается в «только чтение».
    return { doc, userId: payload.u, canWrite: payload.m === 'w' && mode === 'edit' };
  }

  /** Метка «последнего изменения» для CheckFileInfo/PutFile-конфликта (риск 7).
   *  Двигается ТОЛЬКО сохранением содержимого — служебные апдейты строки файла
   *  (вердикт антивируса, переименование) её не трогают, иначе редактор получал бы
   *  ложный конфликт 1010 на ровном месте. */
  lastModifiedTime(doc: DocumentRow): string {
    return (doc.lastSavedAt ?? doc.createdAt).toISOString();
  }

  /** CheckFileInfo.Version — обязан меняться при смене содержимого (иначе клиент отдаст кэш) */
  private versionOf(doc: DocumentRow, sha256: string | null): string {
    return sha256 ? sha256.slice(0, 16) : String((doc.lastSavedAt ?? doc.createdAt).getTime());
  }

  // ============================================================
  // WOPI: CheckFileInfo
  // ============================================================

  async checkFileInfo(ctx: WopiContext): Promise<Record<string, unknown>> {
    const file = await this.db.fileObject.findUnique({
      where: { id: ctx.doc.fileId },
      select: { size: true, sha256: true, status: true, scanStatus: true },
    });
    if (!file || file.status !== 'ready') throw new NotFoundException('Файл документа не найден');
    if (file.scanStatus === 'infected') throw new ForbiddenException('Файл помечен как заражённый');

    const user = await this.db.user.findUnique({
      where: { id: ctx.userId },
      select: { firstName: true, lastName: true, avatar: true },
    });
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Пользователь';

    return {
      // BaseFileName ОБЯЗАН содержать расширение: по нему клиент выбирает
      // Writer/Calc/Impress. Без расширения документ просто не откроется.
      BaseFileName: `${ctx.doc.title}.${ctx.doc.ext}`,
      Size: Number(file.size),
      Version: this.versionOf(ctx.doc, file.sha256),
      LastModifiedTime: this.lastModifiedTime(ctx.doc),
      OwnerId: ctx.doc.createdById,
      UserId: ctx.userId,
      UserFriendlyName: name,
      // Имя и аватарка соредактора — то, что рисуется у курсоров в документе
      UserExtraInfo: user?.avatar ? { avatar: user.avatar } : {},
      UserCanWrite: ctx.canWrite,
      ReadOnly: !ctx.canWrite,
      // «Сохранить как» убираем: PutRelativeFile не реализуем (документ живёт в
      // своём месте — задаче/чате, а не в файловом менеджере редактора).
      UserCanNotWriteRelative: true,
      UserCanRename: false,
      SupportsRename: false,
      SupportsUpdate: true,
      SupportsLocks: true,
      SupportsGetLock: true,
      SupportsExtendedLockLength: true,
      // Без PostMessageOrigin postMessage не работает ВООБЩЕ — а это будущее место
      // кнопки «Подписать ЭЦП» и текущий канал «сохранено/закрыто» для страницы.
      PostMessageOrigin: (process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
      IsAdminUser: false,
      DisablePrint: false,
      HideUserList: '',
    };
  }

  // ============================================================
  // WOPI: блокировки (одна сессия на документ, не на пользователя)
  // ============================================================

  /** Живая сессия или null; протухшую закрываем лениво прямо здесь */
  async getActiveSession(documentId: string): Promise<SessionRow | null> {
    const session = await this.db.documentSession.findFirst({
      where: { documentId, status: 'open' },
    });
    if (!session) return null;
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.closeSession(session, 'expired');
      return null;
    }
    return session;
  }

  async getLock(documentId: string): Promise<string> {
    return (await this.getActiveSession(documentId))?.lockValue ?? '';
  }

  /** LOCK и REFRESH_LOCK: одна и та же семантика «взять/продлить», разные заголовки */
  async lock(ctx: WopiContext, lockValue: string): Promise<void> {
    if (!lockValue) throw new WopiLockConflict(await this.getLock(ctx.doc.id));
    const active = await this.getActiveSession(ctx.doc.id);
    if (active) {
      if (active.lockValue !== lockValue) throw new WopiLockConflict(active.lockValue);
      await this.extendSession(active, ctx.userId);
      return;
    }
    const base = this.router.resolveBase(ctx.doc.id, ctx.doc.editorBaseUrl);
    try {
      await this.db.documentSession.create({
        data: {
          documentId: ctx.doc.id,
          lockValue,
          editorBaseUrl: base,
          expiresAt: this.lockDeadline(),
          participantIds: [ctx.userId],
        },
      });
    } catch (err) {
      // Партиальный unique (одна открытая сессия на документ) — гонка двух первых
      // Lock'ов. Проигравший обязан увидеть ЧУЖУЮ строку блокировки, а не свою.
      if ((err as { code?: string })?.code !== 'P2002') throw err;
      const current = await this.getActiveSession(ctx.doc.id);
      if (!current) throw err;
      if (current.lockValue !== lockValue) throw new WopiLockConflict(current.lockValue);
      await this.extendSession(current, ctx.userId);
    }
  }

  /** UNLOCK_AND_RELOCK: меняем строку блокировки, сессию (и её вехи) не рвём */
  async unlockAndRelock(ctx: WopiContext, oldLock: string, newLock: string): Promise<void> {
    const active = await this.getActiveSession(ctx.doc.id);
    if (!active) {
      // Блокировки нет — по протоколу это конфликт с пустой строкой; COOL возьмёт заново.
      throw new WopiLockConflict('');
    }
    if (active.lockValue !== oldLock) throw new WopiLockConflict(active.lockValue);
    await this.db.documentSession.updateMany({
      where: { id: active.id, status: 'open', lockValue: oldLock },
      data: { lockValue: newLock, expiresAt: this.lockDeadline() },
    });
  }

  /**
   * UNLOCK — основной сигнал «правка закончилась». Идемпотентен: повторный Unlock уже
   * закрытой сессии это 200, а не конфликт (иначе клиент застрянет в ретраях).
   */
  async unlock(ctx: WopiContext, lockValue: string): Promise<void> {
    const active = await this.getActiveSession(ctx.doc.id);
    if (!active) return;
    if (active.lockValue !== lockValue) throw new WopiLockConflict(active.lockValue);
    await this.closeSession(active, 'closed');
  }

  /**
   * Токен редактора протух прямо на продлении блокировки: закрываем сессию сами, иначе
   * документ остался бы «занят» до конца срока блокировки, хотя правки уже никто не
   * шлёт. Закрываем ТОЛЬКО по совпадающей строке блокировки — она известна лишь
   * настоящему редактору, и посторонний с мусорным токеном чужую правку не собьёт.
   */
  async closeStaleSession(documentId: string, lockValue: string | undefined): Promise<void> {
    if (!lockValue) return;
    const active = await this.getActiveSession(documentId);
    if (!active || active.lockValue !== lockValue) return;
    await this.closeSession(active, 'expired');
    this.logger.warn(`сессия документа ${documentId} закрыта: токен редактора истёк`);
  }

  private lockDeadline(): Date {
    return new Date(Date.now() + DOCS_LIMITS.lockTtlMin * 60 * 1000);
  }

  private async extendSession(session: SessionRow, userId: string): Promise<void> {
    const participants = session.participantIds.includes(userId)
      ? session.participantIds
      : [...session.participantIds, userId];
    await this.db.documentSession.updateMany({
      where: { id: session.id, status: 'open' },
      data: { expiresAt: this.lockDeadline(), participantIds: participants },
    });
  }

  /**
   * Закрытие сессии — единственная точка (Unlock, жнец, «сохранение при выходе»).
   * Status-guard: закрыть может только тот, кто увидел её открытой, — и ровно он же
   * заказывает веху, в ТОЙ ЖЕ транзакции (иначе два одновременных Unlock'а нарезали бы
   * две версии одного и того же содержимого).
   */
  async closeSession(session: SessionRow, status: 'closed' | 'expired'): Promise<boolean> {
    // Всё, что требует запросов, готовим ДО транзакции: внутри остаются только записи.
    const entries = await this.buildEditEntries(session);
    return this.db.$transaction(async (tx) => {
      const res = await tx.documentSession.updateMany({
        where: { id: session.id, status: 'open' },
        data: { status, closedAt: new Date() },
      });
      if (res.count !== 1) return false;
      await this.versions.requestMilestone(tx, {
        documentId: session.documentId,
        reason: 'session_end',
        authorIds: session.participantIds,
      });
      // Хроника захода правки — В ТОЙ ЖЕ транзакции (контракт core/chatter): либо
      // сессия закрыта и запись есть, либо не случилось ни того, ни другого.
      if (entries.length) await this.chatter.logMany(tx, entries);
      return true;
    });
  }

  /**
   * Записи хроники о заходе правки. ОДНА на заход, а не на сохранение: редактор
   * сохраняет примерно раз в полминуты, и запись на каждое превратила бы чат в ленту
   * «правил… правил… правил…».
   *
   * Пишем в два адреса: в хронику САМОГО документа (она есть и у файла, который не
   * лежит ни в задаче, ни в чате — там это единственное место, где видно, кто что делал)
   * и в место, если у него есть хроника (задача) — оттуда плашка в чат приезжает сама.
   * Плашка в место склеивается: не чаще раза в час на пару «человек + документ».
   */
  private async buildEditEntries(session: SessionRow): Promise<ChatterLogInput[]> {
    const doc = await this.db.document.findUnique({ where: { id: session.documentId } });
    // Правок не было вовсе (открыли и закрыли) — молчим: это не событие.
    if (!doc || !session.lastPutAt) return [];

    const actorId = session.participantIds[0] ?? null;
    const others = Math.max(session.participantIds.length - 1, 0);
    const actor = actorId
      ? await this.db.user.findUnique({
          where: { id: actorId },
          select: { firstName: true, lastName: true },
        })
      : null;
    const name = [actor?.firstName, actor?.lastName].filter(Boolean).join(' ') || 'Кто-то';
    const actorName = others ? `${name} и ещё ${others}` : name;
    const period = formatTimeRange(session.lockedAt, session.lastPutAt);
    const payload = { title: doc.title, documentId: doc.id, period };

    const entries: ChatterLogInput[] = [
      { refType: 'document', refId: doc.id, actorId, actorName, typeKey: 'document.edited', payload },
    ];

    for (const link of await this.files.listLinksOfFile(doc.fileId)) {
      if (link.refType === 'document' || !this.chatterRegistry.get(link.refType)) continue;
      const recent = await this.chatter.hasRecent({
        refType: link.refType,
        refId: link.refId,
        typeKey: 'task.document_edited',
        actorId,
        withinMs: DOCS_LIMITS.chatEditNoticeCooldownMin * 60 * 1000,
        payloadPath: { path: ['documentId'], equals: doc.id },
      });
      if (recent) continue;
      entries.push({
        refType: link.refType,
        refId: link.refId,
        actorId,
        actorName,
        typeKey: 'task.document_edited',
        payload,
      });
    }
    return entries;
  }

  // ============================================================
  // WOPI: PutFile
  // ============================================================

  /**
   * Приём правок. Порядок проверок (блокировка → внеполосное изменение → байты)
   * выбран так, чтобы дорогая замена содержимого случалась последней.
   *
   * ВАЖНО: bodyPath ПОТРЕБЛЯЕТСЯ движком файлов (replaceContent), вызывающий его не
   * переиспользует; при отказе на любой ранней проверке файл чистит контроллер.
   */
  async putFile(
    ctx: WopiContext,
    opts: {
      bodyPath: string;
      lock: string | undefined;
      clientTimestamp?: string | null;
      isExitSave?: boolean;
    },
  ): Promise<{ lastModifiedTime: string; version: string }> {
    if (!ctx.canWrite) throw new ForbiddenException('Документ открыт только для чтения');

    let session = await this.getActiveSession(ctx.doc.id);
    // Блокировка живая, а запрос пришёл без неё или с чужой — по протоколу это конфликт.
    // Пропускать «без блокировки» нельзя: именно так посторонний держатель валидного
    // токена подменил бы содержимое целиком, ни разу не спросив блокировку.
    if (session && session.lockValue !== (opts.lock ?? '')) {
      throw new WopiLockConflict(session.lockValue);
    }
    if (!session && opts.lock) {
      // Блокировка протухла (сеть, простой, рестарт), а правки в редакторе есть.
      // Протокол разрешает ответить 409 «файл не заблокирован», но это лишний круг
      // «потеряли-переспросили» ровно там, где на кону несохранённая работа человека:
      // токен валиден, строку блокировки клиент помнит — принимаем её обратно.
      await this.lock(ctx, opts.lock);
      session = await this.getActiveSession(ctx.doc.id);
    }

    // Внеполосное изменение (риск 7): клиент присылает ту метку, которую видел. Если
    // наша НОВЕЕ — документ успели сохранить мимо этого редактора, и его правки затёрли
    // бы чужие. Обратный случай (клиентская новее) — часы/кэш, не конфликт.
    if (opts.clientTimestamp) {
      const client = Date.parse(opts.clientTimestamp);
      const ours = Date.parse(this.lastModifiedTime(ctx.doc));
      if (Number.isFinite(client) && ours > client) throw new WopiTimestampConflict();
    }

    const result = await this.files.replaceContent({
      fileId: ctx.doc.fileId,
      sourcePath: opts.bodyPath,
      actorId: ctx.userId,
    });

    const savedAt = new Date();
    const doc = await this.db.document.update({
      where: { id: ctx.doc.id },
      data: { lastSavedAt: savedAt, lastEditorId: ctx.userId },
    });
    if (session) {
      const participants = session.participantIds.includes(ctx.userId)
        ? session.participantIds
        : [...session.participantIds, ctx.userId];
      await this.db.documentSession.updateMany({
        where: { id: session.id, status: 'open' },
        data: {
          lastPutAt: savedAt,
          participantIds: participants,
          // «Сохранение при выходе» — подсказка, а не гарантия: срезаем срок
          // блокировки, чтобы жнец добил сессию через минуты, а не через полчаса.
          ...(opts.isExitSave
            ? {
                exitSaveSeen: true,
                expiresAt: new Date(Date.now() + DOCS_LIMITS.exitSaveGraceMin * 60 * 1000),
              }
            : {}),
        },
      });
    }

    return {
      lastModifiedTime: this.lastModifiedTime(doc),
      version: this.versionOf(doc, result.sha256),
    };
  }

  /**
   * Байты документа для GetFile (заражённые режет сам движок файлов) + ТА ЖЕ строка
   * версии, что отдаёт CheckFileInfo: по протоколу X-WOPI-ItemVersion обязан совпадать
   * с полем Version, иначе клиент считает выданное содержимое протухшим.
   */
  async openContent(ctx: WopiContext) {
    const file = await this.db.fileObject.findUnique({
      where: { id: ctx.doc.fileId },
      select: { sha256: true },
    });
    const stream = await this.files.openRawStream(ctx.doc.fileId, null);
    return { ...stream, version: this.versionOf(ctx.doc, file?.sha256 ?? null) };
  }
}
