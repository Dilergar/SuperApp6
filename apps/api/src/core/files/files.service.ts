import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  PayloadTooLargeException,
} from '@nestjs/common';
import * as fs from 'fs';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { fromBuffer as fileTypeFromBuffer, fromFile as fileTypeFromFile } from 'file-type';
import {
  FILE_LIMITS,
  FILE_PROFILES,
  FILE_QUOTAS,
  EXEC_EXT_BLACKLIST,
  TEAM_WORKSPACE_ROLES,
  fileExtension,
  fileKindFromMime,
  isInlineMime,
  type FileDownloadUrl,
  type FileDto,
  type FileInitResult,
  type FilePartUrl,
  type FileProfileSpec,
  type FileUsageDto,
  type FileOwnerType,
  type CompleteFileInput,
  type InitFileInput,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { FilesUrlService } from './files-url.service';
import { FilesRefRegistry } from './files-ref.registry';
import { FilesScanHook } from './files-scan.hook';
import { FilesPipelineService } from './files-pipeline.service';
import { STORAGE_DRIVER, StorageDriver, StorageStreamResult } from './storage/storage-driver';

type FileRow = NonNullable<Awaited<ReturnType<DatabaseService['fileObject']['findUnique']>>>;
type VariantRow = NonNullable<Awaited<ReturnType<DatabaseService['fileVariant']['findUnique']>>>;

/** Сигнатуры исполняемых форматов — режем независимо от заявленного MIME */
const EXEC_SNIFF_MIME = new Set([
  'application/x-msdownload',
  'application/x-elf',
  'application/x-executable',
  'application/x-sharedlib',
  'application/x-mach-binary',
  'application/vnd.microsoft.portable-executable',
]);

/** Контейнеры, легитимные для заявленного audio/* (MediaRecorder пишет webm/mp4/ogg) */
const AUDIO_CONTAINER_MIME = new Set([
  'audio/ogg', 'application/ogg', 'audio/opus', 'audio/webm', 'video/webm',
  'audio/mp4', 'video/mp4', 'audio/x-m4a', 'audio/mpeg', 'audio/mp3',
  'audio/wav', 'audio/x-wav', 'audio/vnd.wave',
]);

/** OOXML/старый Office снифаются как zip/x-cfb — это нормально */
const OFFICE_SNIFF_OK = new Set(['application/zip', 'application/x-cfb']);

/**
 * Files Engine (core/files) — 6-й платформенный движок: хранение/загрузка/раздача файлов
 * для всех сервисов. Модель Salesforce (FileObject+FileLink+FileVariant) + драйверный
 * байт-стор (local|s3). Контракт загрузки — Slack v2: init → байты → complete.
 * Доступ: владелец/загрузивший/public + наследование от привязанной сущности (FilesRefRegistry).
 */
@Injectable()
export class FilesService implements OnModuleInit {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventBusService,
    private readonly urls: FilesUrlService,
    private readonly registry: FilesRefRegistry,
    private readonly scanHook: FilesScanHook,
    private readonly pipeline: FilesPipelineService,
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
  ) {}

  onModuleInit(): void {
    this.logger.log(`Files engine: драйвер "${this.driver.name}"`);
  }

  // ============================================================
  // Загрузка (Slack v2: init → байты → complete)
  // ============================================================

  async init(userId: string, dto: InitFileInput): Promise<FileInitResult> {
    const spec = this.profileSpec(dto.profile);

    const ext = fileExtension(dto.name);
    if (ext && EXEC_EXT_BLACKLIST.includes(ext)) {
      throw new BadRequestException('Исполняемые файлы запрещены');
    }
    const mime = dto.mime.toLowerCase();
    if (spec.allowedMime && !spec.allowedMime.includes(mime)) {
      throw new BadRequestException('Такой тип файла не разрешён для этого профиля');
    }
    if (dto.size > spec.maxSize) {
      throw new BadRequestException(
        `Файл слишком большой: лимит профиля ${Math.floor(spec.maxSize / (1024 * 1024))} МБ`,
      );
    }

    // Владелец: по умолчанию сам пользователь; организация — по членству (не Подрядчик)
    let ownerType: FileOwnerType = 'user';
    let ownerId = userId;
    if (dto.ownerWorkspaceId) {
      if (!(await this.isWorkspaceMember(userId, dto.ownerWorkspaceId))) {
        throw new ForbiddenException('Вы не состоите в этой организации');
      }
      ownerType = 'workspace';
      ownerId = dto.ownerWorkspaceId;
    }

    await this.assertQuota(ownerType, ownerId, dto.size);

    const transport = dto.size > FILE_LIMITS.apiTransportMax && this.driver.supportsMultipart ? 'multipart' : 'api';

    const id = randomUUID();
    const storageKey = `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`;
    let uploadId: string | null = null;
    if (transport === 'multipart') {
      uploadId = await this.driver.createMultipart(storageKey, mime);
    }

    const row = await this.db.fileObject.create({
      data: {
        id,
        ownerType,
        ownerId,
        uploaderId: userId,
        profile: dto.profile,
        kind: fileKindFromMime(mime),
        name: dto.name,
        mime,
        size: BigInt(dto.size),
        status: 'uploading',
        visibility: spec.visibility,
        publicToken: spec.visibility === 'public' ? randomBytes(24).toString('base64url') : null,
        storageDriver: this.driver.name,
        storageKey,
        uploadId,
      },
    });

    const result: FileInitResult = { file: this.serializeFile(row, []), transport };
    if (transport === 'multipart') {
      result.partSize = FILE_LIMITS.partSize;
      result.partCount = Math.ceil(dto.size / FILE_LIMITS.partSize);
    }
    return result;
  }

  /** Транспорт "api": байты пришли одним запросом (multer → temp-файл) */
  async putContent(
    userId: string,
    fileId: string,
    tmp: { path: string; size: number },
  ): Promise<FileDto> {
    let tmpConsumed = false;
    try {
      const row = await this.db.fileObject.findUnique({ where: { id: fileId } });
      if (!row || row.status === 'deleted') throw new NotFoundException('Файл не найден');
      if (row.uploaderId !== userId) throw new ForbiddenException('Загрузку завершает только её автор');
      if (row.status !== 'uploading') throw new ConflictException('Файл уже завершён');
      if (row.uploadId) throw new BadRequestException('Этот файл ждёт multipart-загрузку по частям');

      const spec = this.profileSpec(row.profile);
      if (tmp.size > spec.maxSize) {
        await this.markFailed(fileId, 'превышен лимит размера');
        throw new PayloadTooLargeException('Файл больше лимита профиля');
      }

      const detected = await fileTypeFromFile(tmp.path).catch(() => undefined);
      const sniffError = this.validateMagicBytes(row.mime, detected?.mime);
      if (sniffError) {
        await this.markFailed(fileId, sniffError);
        throw new BadRequestException(sniffError);
      }

      const sha256 = await this.sha256File(tmp.path);
      await this.driver.putFromFile(row.storageKey, tmp.path, row.mime); // забирает temp
      tmpConsumed = true;

      const updated = await this.db.fileObject.update({
        where: { id: fileId },
        data: { size: BigInt(tmp.size), sha256 },
      });
      return this.serializeFile(updated, []);
    } finally {
      if (!tmpConsumed) await fs.promises.unlink(tmp.path).catch(() => undefined);
    }
  }

  /** Транспорт "multipart": presigned-ссылки на части (только s3-драйвер) */
  async createParts(userId: string, fileId: string, partNumbers: number[]): Promise<FilePartUrl[]> {
    const row = await this.db.fileObject.findUnique({ where: { id: fileId } });
    if (!row || row.status === 'deleted') throw new NotFoundException('Файл не найден');
    if (row.uploaderId !== userId) throw new ForbiddenException('Загрузку продолжает только её автор');
    if (row.status !== 'uploading' || !row.uploadId) {
      throw new BadRequestException('Файл не в режиме multipart-загрузки');
    }
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.driver.presignPart(row.storageKey, row.uploadId as string, partNumber, FILE_LIMITS.partUrlTtlSec),
      })),
    );
  }

  async complete(userId: string, fileId: string, dto: CompleteFileInput): Promise<FileDto> {
    const row = await this.db.fileObject.findUnique({ where: { id: fileId } });
    if (!row || row.status === 'deleted') throw new NotFoundException('Файл не найден');
    if (row.uploaderId !== userId) throw new ForbiddenException('Загрузку завершает только её автор');
    if (row.status === 'ready') throw new ConflictException('Файл уже завершён');
    if (row.status !== 'uploading') throw new ConflictException('Загрузка не активна');

    const spec = this.profileSpec(row.profile);
    let finalSize: bigint;
    let sha256 = row.sha256;

    if (row.uploadId) {
      // multipart: собрать объект, проверить размер и сигнатуру
      if (!dto.parts?.length) throw new BadRequestException('Не переданы части multipart-загрузки');
      await this.driver.completeMultipart(row.storageKey, row.uploadId, dto.parts);
      const size = await this.driver.size(row.storageKey);
      if (size == null) throw new BadRequestException('Хранилище не подтвердило объект');
      if (size > spec.maxSize) {
        await this.driver.delete(row.storageKey).catch(() => undefined);
        await this.markFailed(fileId, 'превышен лимит размера');
        throw new PayloadTooLargeException('Файл больше лимита профиля');
      }
      finalSize = BigInt(size);
      const head = await this.readHead(row.storageKey, 4100);
      const detected = head.length ? await fileTypeFromBuffer(head).catch(() => undefined) : undefined;
      const sniffError = this.validateMagicBytes(row.mime, detected?.mime);
      if (sniffError) {
        await this.driver.delete(row.storageKey).catch(() => undefined);
        await this.markFailed(fileId, sniffError);
        throw new BadRequestException(sniffError);
      }
      // sha256 всего объекта для multipart не считаем в запросе (v1); клиент мог прислать свой
      sha256 = dto.sha256 ?? sha256;
    } else {
      // api: байты должен был принести putContent (sha256 проставлен там)
      if (!row.sha256) throw new BadRequestException('Байты файла ещё не загружены');
      if (dto.sha256 && dto.sha256.toLowerCase() !== row.sha256.toLowerCase()) {
        throw new BadRequestException('Контрольная сумма не совпала — файл повреждён при передаче');
      }
      const size = await this.driver.size(row.storageKey);
      if (size == null) throw new BadRequestException('Объект не найден в хранилище');
      finalSize = BigInt(size);
    }

    // Пустой объект «ready» неотдаваем (range 0>=0 → 416) и бессмыслен — режем здесь.
    if (finalSize <= BigInt(0)) {
      await this.driver.delete(row.storageKey).catch(() => undefined);
      await this.markFailed(fileId, 'пустой файл');
      throw new BadRequestException('Файл пустой');
    }
    // Квота проверяется по ФАКТИЧЕСКОМУ размеру: init считал заявленный (клиент мог
    // соврать size=1 и залить 200 МБ). Байты ещё НЕ в fileQuotaUsage — учёт ниже в tx.
    if (await this.overQuota(row.ownerType as FileOwnerType, row.ownerId, Number(finalSize))) {
      await this.driver.delete(row.storageKey).catch(() => undefined);
      await this.markFailed(fileId, 'превышена квота хранилища');
      throw new BadRequestException(
        `Недостаточно места в хранилище (лимит ${(FILE_QUOTAS[row.ownerType as FileOwnerType] / (1024 * 1024 * 1024)).toFixed(0)} ГБ)`,
      );
    }

    const needsPipeline = spec.makeVariants && ['image', 'video', 'audio'].includes(row.kind);
    const baseMeta = (row.meta as Record<string, unknown> | null) ?? {};
    const meta = { ...baseMeta, pipeline: needsPipeline ? 'pending' : 'done' };

    const claimed = await this.db.$transaction(async (tx) => {
      const res = await tx.fileObject.updateMany({
        where: { id: fileId, status: 'uploading' },
        data: {
          status: 'ready',
          readyAt: new Date(),
          uploadId: null,
          size: finalSize,
          sha256,
          meta,
        },
      });
      if (res.count !== 1) return false;
      await tx.fileQuotaUsage.upsert({
        where: { ownerType_ownerId: { ownerType: row.ownerType, ownerId: row.ownerId } },
        create: { ownerType: row.ownerType, ownerId: row.ownerId, bytesUsed: finalSize, filesCount: 1 },
        update: { bytesUsed: { increment: finalSize }, filesCount: { increment: 1 } },
      });
      return true;
    });
    if (!claimed) throw new ConflictException('Файл уже завершён');

    const fresh = await this.getRowWithVariants(fileId);
    const payload = this.eventPayload(fresh.row);
    this.events.emit('file.uploaded', payload, 'files');
    this.events.emit('file.ready', payload, 'files');
    this.scanHook.enqueue(fileId);
    if (needsPipeline) {
      this.pipeline.process(fileId).catch((err) =>
        this.logger.warn(`pipeline kickoff ${fileId}: ${err instanceof Error ? err.message : err}`),
      );
    }
    return this.serializeFile(fresh.row, fresh.variants);
  }

  async abort(userId: string, fileId: string): Promise<void> {
    const row = await this.db.fileObject.findUnique({ where: { id: fileId } });
    if (!row || row.status === 'deleted') throw new NotFoundException('Файл не найден');
    if (row.uploaderId !== userId) throw new ForbiddenException('Загрузку отменяет только её автор');
    if (row.status !== 'uploading') throw new ConflictException('Загрузка уже завершена');

    // Клеймим статус ПЕРЕД удалением байтов: иначе конкурентный complete() успеет
    // объявить файл ready, а abort уже снёс его байты (TOCTOU → «ready» без объекта).
    const claimed = await this.db.fileObject.updateMany({
      where: { id: fileId, status: 'uploading' },
      data: { status: 'failed', error: 'отменена пользователем', uploadId: null },
    });
    if (claimed.count !== 1) throw new ConflictException('Загрузка уже завершена');
    if (row.uploadId) await this.driver.abortMultipart(row.storageKey, row.uploadId);
    await this.driver.delete(row.storageKey).catch(() => undefined);
  }

  // ============================================================
  // Чтение
  // ============================================================

  async getMeta(viewerId: string, fileId: string): Promise<FileDto> {
    const { row, variants } = await this.getRowWithVariants(fileId);
    if (row.status === 'deleted') throw new NotFoundException('Файл не найден');
    await this.assertCanView(viewerId, row);
    return this.serializeFile(row, variants);
  }

  async getDownloadUrl(viewerId: string, fileId: string, variantKind?: string): Promise<FileDownloadUrl> {
    const { row, variants } = await this.getRowWithVariants(fileId);
    if (row.status !== 'ready') throw new NotFoundException('Файл не найден или ещё не готов');
    if (row.scanStatus === 'infected') throw new ForbiddenException('Файл помечен как заражённый');
    await this.assertCanView(viewerId, row);

    const { key, mime, name } = this.targetForVariant(row, this.pickVariant(variants, variantKind));

    const presigned = await this.driver.presignedGet(key, FILE_LIMITS.urlTtlSec, {
      disposition: this.contentDisposition(mime, name),
      mime,
    });
    if (presigned) {
      return {
        url: presigned,
        expiresAt: new Date(Date.now() + FILE_LIMITS.urlTtlSec * 1000).toISOString(),
      };
    }
    return this.urls.rawUrl(fileId, variantKind ?? null);
  }

  /** Байты для HMAC-роута /files/raw/:id (подпись проверяет контроллер) */
  async openRawStream(
    fileId: string,
    variantKind: string | null,
    range?: { start: number; end?: number },
  ): Promise<{ result: StorageStreamResult; mime: string; name: string }> {
    const { row, variants } = await this.getRowWithVariants(fileId);
    if (row.status !== 'ready') throw new NotFoundException('Файл не найден');
    if (row.scanStatus === 'infected') throw new ForbiddenException('Файл помечен как заражённый');

    const { key, mime, name } = this.targetForVariant(row, this.pickVariant(variants, variantKind));
    const result = await this.driver.getStream(key, range);
    return { result, mime, name };
  }

  /** Публичная раздача по вечному токену: локально — стрим, s3 — redirect */
  async resolvePublic(
    token: string,
    variantKind: string | null,
  ): Promise<
    | { mode: 'redirect'; url: string; cacheControl: string }
    | { mode: 'stream'; fileId: string; key: string; mime: string; name: string }
  > {
    const row = await this.db.fileObject.findUnique({ where: { publicToken: token } });
    if (!row || row.status !== 'ready' || row.visibility !== 'public') {
      throw new NotFoundException('Файл не найден');
    }
    if (row.scanStatus === 'infected') throw new ForbiddenException('Файл помечен как заражённый');

    const variant = variantKind
      ? await this.db.fileVariant.findUnique({ where: { fileId_kind: { fileId: row.id, kind: variantKind } } })
      : null;
    if (variantKind && !variant) throw new NotFoundException('Вариант файла не найден');
    const { key, mime, name } = this.targetForVariant(row, variant);

    // Драйвер сам решает, умеет ли отдавать байты напрямую (публичный CDN-URL /
    // presigned GET) — движок больше не зашивает знание про конкретный драйвер.
    const direct = this.driver.publicObjectUrl(key);
    if (direct) {
      return {
        mode: 'redirect',
        url: direct,
        cacheControl: `public, max-age=${FILE_LIMITS.publicCacheMaxAgeSec}, immutable`,
      };
    }
    const presigned = await this.driver.presignedGet(key, FILE_LIMITS.urlTtlSec, {
      disposition: this.contentDisposition(mime, name),
      mime,
    });
    if (presigned) return { mode: 'redirect', url: presigned, cacheControl: 'private, max-age=300' };
    return { mode: 'stream', fileId: row.id, key, mime, name };
  }

  /** Стрим по готовому ключу (публичный роут; ключ уже разрешён resolvePublic) */
  async openKeyStream(
    key: string,
    range?: { start: number; end?: number },
  ): Promise<StorageStreamResult> {
    return this.driver.getStream(key, range);
  }

  // ============================================================
  // Связи (полиморфика: файл ↔ сущность сервиса)
  // ============================================================

  /** Сервисный API для потребителей (REST в v1 нет — резолверов ещё ноль) */
  async linkFile(
    actorId: string,
    fileId: string,
    refType: string,
    refId: string,
    role = 'attachment',
  ): Promise<void> {
    const row = await this.db.fileObject.findUnique({ where: { id: fileId } });
    if (!row || row.status !== 'ready') throw new NotFoundException('Файл не найден');
    const resolver = this.registry.get(refType);
    if (!resolver) throw new BadRequestException(`Неизвестный тип привязки: ${refType}`);
    this.assertProfileAllowed(refType, [row.profile]);
    if (!(await resolver.canAttach(actorId, refId))) {
      throw new ForbiddenException('Нет прав прикреплять файлы к этой сущности');
    }
    await this.db.fileLink
      .create({ data: { fileId, refType, refId, role, createdById: actorId } })
      .catch((err: { code?: string }) => {
        if (err?.code !== 'P2002') throw err; // дубль связи — не ошибка
      });
  }

  /** Профиль каждого привязываемого файла должен быть разрешён для refType */
  private assertProfileAllowed(refType: string, profiles: string[]): void {
    const allowed = this.registry.options(refType)?.allowedProfiles;
    if (!allowed) return;
    const bad = profiles.find((p) => !allowed.includes(p));
    if (bad) throw new BadRequestException(`Файл профиля «${bad}» нельзя прикрепить сюда`);
  }

  /**
   * Линковка ВНУТРИ чужой транзакции (сущность ещё не закоммичена — резолвер её не
   * найдёт; напр. attachment-сообщение). Файлы РЕ-валидируются здесь же под транзакцией
   * (ready + uploader + профиль): предвалидация вызывающего (getOwnedReadyFiles) идёт
   * ДО tx, и файл мог быть soft-delete'нут в окне — иначе в сообщение попадёт битая ссылка.
   */
  async linkManyInTx(
    tx: Prisma.TransactionClient,
    actorId: string,
    fileIds: string[],
    refType: string,
    refId: string,
    role = 'attachment',
  ): Promise<void> {
    if (!fileIds.length) return;
    const rows = await tx.fileObject.findMany({
      where: { id: { in: [...new Set(fileIds)] }, status: 'ready', uploaderId: actorId },
      select: { id: true, profile: true },
    });
    if (rows.length !== new Set(fileIds).size) {
      throw new BadRequestException('Не все файлы готовы или принадлежат вам');
    }
    this.assertProfileAllowed(refType, rows.map((r) => r.profile));
    await tx.fileLink.createMany({
      data: fileIds.map((fileId) => ({ fileId, refType, refId, role, createdById: actorId })),
      skipDuplicates: true,
    });
  }

  /**
   * Батч-чтение вложений набора сущностей (обложки лотов / вложения задач — без N+1).
   * Доступ гейтит вызывающий сервис. Только ready-файлы; порядок = порядок привязки.
   */
  async listLinked(refType: string, refIds: string[], role = 'attachment'): Promise<Map<string, FileDto[]>> {
    const result = new Map<string, FileDto[]>();
    if (!refIds.length) return result;
    const links = await this.db.fileLink.findMany({
      where: { refType, refId: { in: refIds }, role },
      orderBy: { createdAt: 'asc' },
      include: { file: { include: { variants: true } } },
    });
    for (const link of links) {
      const f = link.file as (FileRow & { variants: VariantRow[] }) | null;
      if (!f || f.status !== 'ready') continue;
      const { variants, ...row } = f;
      const dto = this.serializeFile(row as FileRow, variants);
      const arr = result.get(link.refId) ?? [];
      arr.push(dto);
      result.set(link.refId, arr);
    }
    return result;
  }

  /**
   * Файлы готовы и принадлежат загрузившему (предвалидация attach-потоков сервисов).
   * Бросает 400, если хоть один не найден/не готов/чужой. Порядок = порядок fileIds.
   */
  async getOwnedReadyFiles(userId: string, fileIds: string[]): Promise<FileDto[]> {
    const unique = [...new Set(fileIds)];
    const rows = await this.db.fileObject.findMany({
      where: { id: { in: unique }, status: 'ready', uploaderId: userId },
      include: { variants: true },
    });
    if (rows.length !== unique.length) {
      throw new BadRequestException('Не все файлы готовы или принадлежат вам');
    }
    const byId = new Map(
      rows.map((r) => {
        const { variants, ...row } = r;
        return [r.id, this.serializeFile(row as FileRow, variants as VariantRow[])] as const;
      }),
    );
    return unique.map((id) => byId.get(id) as FileDto);
  }

  /** Отвязать конкретную связь. Возвращает true, если связь реально была снята. */
  async unlinkFile(actorId: string, fileId: string, refType: string, refId: string, role = 'attachment'): Promise<boolean> {
    const link = await this.db.fileLink.findUnique({
      where: { fileId_refType_refId_role: { fileId, refType, refId, role } },
    });
    if (!link) return false;
    const row = await this.db.fileObject.findUnique({ where: { id: fileId } });
    const resolver = this.registry.get(refType);
    const allowed =
      link.createdById === actorId ||
      (row && row.uploaderId === actorId) ||
      (row && row.ownerType === 'user' && row.ownerId === actorId) ||
      (resolver ? await resolver.canAttach(actorId, refId) : false);
    if (!allowed) throw new ForbiddenException('Нет прав отвязать файл');
    const deleted = await this.db.fileLink.deleteMany({ where: { id: link.id } });
    return deleted.count > 0;
  }

  /**
   * Отвязать связь и, если это была ПОСЛЕДНЯЯ связь файла, прибрать сироту (К-5).
   * Единая точка для потребителей: reap только когда связь реально снята (иначе
   * чужой/непривязанный fileId мог бы удалить непричастный файл) и системным
   * soft-delete (удаляющий ≠ загрузивший — Forbidden больше не роняет уборку).
   */
  async unlinkAndReap(actorId: string, fileId: string, refType: string, refId: string, role = 'attachment'): Promise<void> {
    const removed = await this.unlinkFile(actorId, fileId, refType, refId, role);
    if (removed) await this.reapOrphan(fileId);
  }

  /**
   * Снять ВСЕ связи сущности (её удаляют — авторизацию сделал вызывающий сервис) и
   * прибрать осиротевшие файлы. Закрывает утечку квоты при удалении лота/задачи/чата,
   * где полиморфный FileLink не каскадится вместе со строкой сущности.
   */
  async unlinkAllForRef(refType: string, refId: string, role?: string): Promise<void> {
    return this.unlinkAllForRefs(refType, [refId], role);
  }

  async unlinkAllForRefs(refType: string, refIds: string[], role?: string): Promise<void> {
    if (!refIds.length) return;
    const where = { refType, refId: { in: [...new Set(refIds)] }, ...(role ? { role } : {}) };
    const links = await this.db.fileLink.findMany({ where, select: { fileId: true } });
    if (!links.length) return;
    const fileIds = [...new Set(links.map((l) => l.fileId))];
    await this.db.fileLink.deleteMany({ where });
    for (const fileId of fileIds) await this.reapOrphan(fileId);
  }

  /** Файл без единой связи → системный soft-delete (квота не копит невидимое) */
  private async reapOrphan(fileId: string): Promise<void> {
    const remaining = await this.db.fileLink.count({ where: { fileId } });
    if (remaining === 0) await this.systemSoftDelete(fileId).catch(() => undefined);
  }

  // ============================================================
  // Удаление / квоты
  // ============================================================

  async softDelete(userId: string, fileId: string): Promise<void> {
    const row = await this.db.fileObject.findUnique({ where: { id: fileId } });
    if (!row || row.status === 'deleted') throw new NotFoundException('Файл не найден');
    const isOwner =
      row.uploaderId === userId || (row.ownerType === 'user' && row.ownerId === userId);
    if (!isOwner) throw new ForbiddenException('Удалить файл может владелец или загрузивший');
    await this.doSoftDelete(row);
  }

  /**
   * Soft-delete без проверки «кто удаляет» — для системной уборки (осиротевшие файлы,
   * заменённый аватар). Право уже проверено на уровне сущности вызывающим сервисом.
   */
  private async systemSoftDelete(fileId: string): Promise<void> {
    const row = await this.db.fileObject.findUnique({ where: { id: fileId } });
    if (!row || row.status === 'deleted') return;
    await this.doSoftDelete(row);
  }

  private async doSoftDelete(row: FileRow): Promise<void> {
    if (row.uploadId) await this.driver.abortMultipart(row.storageKey, row.uploadId);

    const prevStatus = row.status;
    await this.db.$transaction(async (tx) => {
      const res = await tx.fileObject.updateMany({
        where: { id: row.id, status: prevStatus },
        data: { status: 'deleted', deletedAt: new Date(), uploadId: null },
      });
      if (res.count !== 1) throw new ConflictException('Файл уже изменён — повторите');
      if (prevStatus === 'ready') {
        await tx.fileQuotaUsage.updateMany({
          where: { ownerType: row.ownerType, ownerId: row.ownerId },
          data: { bytesUsed: { decrement: row.size }, filesCount: { decrement: 1 } },
        });
      }
    });
    this.events.emit('file.deleted', this.eventPayload(row), 'files');
  }

  /**
   * Прибрать заменённый публичный файл (аватар/лого), который хранится ССЫЛКОЙ, а не
   * привязкой FileLink: старый URL → publicToken → файл. Реапится только если файл
   * действительно наш (owner), публичный и ready. Внешние URL (без нашего токена) и
   * повторное сохранение той же ссылки — no-op. Иначе каждая смена аватара копит квоту.
   */
  async reapReplacedPublicFile(
    ownerType: FileOwnerType,
    ownerId: string,
    oldUrl: string | null | undefined,
    newUrl: string | null | undefined,
  ): Promise<void> {
    const oldToken = this.publicTokenFromUrl(oldUrl);
    if (!oldToken) return;
    if (newUrl && this.publicTokenFromUrl(newUrl) === oldToken) return; // та же картинка
    const row = await this.db.fileObject.findUnique({ where: { publicToken: oldToken } });
    if (!row || row.status !== 'ready' || row.visibility !== 'public') return;
    if (row.ownerType !== ownerType || row.ownerId !== ownerId) return;
    await this.systemSoftDelete(row.id).catch(() => undefined);
  }

  /** Достать publicToken из нашей вечной ссылки (/public-files/:token[?...]) */
  private publicTokenFromUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    const m = /\/public-files\/([^/?#]+)/.exec(url);
    return m ? m[1] : null;
  }

  /**
   * Прибрать «ready»-файлы без единой привязки старше грейса (safety net уборки сирот:
   * забытые загрузки, окна краша между unlink и reap). Только ПРИВАТНЫЕ — публичные
   * (аватар/лого/фото товара) живут ссылкой, не FileLink, и零-link для них норма.
   * Возвращает число прибранных.
   */
  async sweepOrphanReady(graceMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - graceMs);
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT fo."id" FROM "file_objects" fo
      WHERE fo."status" = 'ready'
        AND fo."visibility" = 'private'
        AND fo."created_at" < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM "file_links" fl WHERE fl."file_id" = fo."id")
      LIMIT 200`;
    let reaped = 0;
    for (const r of rows) {
      await this.systemSoftDelete(r.id).catch(() => undefined);
      reaped++;
    }
    return reaped;
  }

  async getUsage(userId: string): Promise<FileUsageDto> {
    const usage = await this.db.fileQuotaUsage.findUnique({
      where: { ownerType_ownerId: { ownerType: 'user', ownerId: userId } },
    });
    return {
      ownerType: 'user',
      ownerId: userId,
      bytesUsed: usage ? Number(usage.bytesUsed) : 0,
      filesCount: usage?.filesCount ?? 0,
      limitBytes: FILE_QUOTAS.user,
    };
  }

  // ============================================================
  // Доступ
  // ============================================================

  private async assertCanView(viewerId: string, row: FileRow): Promise<void> {
    if (await this.canView(viewerId, row)) return;
    throw new ForbiddenException('Нет доступа к файлу');
  }

  private async canView(viewerId: string, row: FileRow): Promise<boolean> {
    if (row.visibility === 'public') return true;
    if (row.uploaderId === viewerId) return true;
    if (row.ownerType === 'user' && row.ownerId === viewerId) return true;
    if (row.ownerType === 'workspace' && (await this.isWorkspaceMember(viewerId, row.ownerId))) return true;

    // Наследование от привязанных сущностей (Salesforce ContentDocumentLink)
    const links = await this.db.fileLink.findMany({ where: { fileId: row.id }, take: 50 });
    for (const link of links) {
      const resolver = this.registry.get(link.refType);
      if (!resolver) continue;
      try {
        if (await resolver.canView(viewerId, link.refId)) return true;
      } catch (err) {
        this.logger.warn(`resolver ${link.refType} упал: ${err instanceof Error ? err.message : err}`);
      }
    }
    return false;
  }

  /** Член организации по UserRole (только командные роли; Подрядчик изолирован) */
  private async isWorkspaceMember(userId: string, workspaceId: string): Promise<boolean> {
    const role = await this.db.userRole.findFirst({
      where: {
        userId,
        context: 'workspace',
        tenantId: workspaceId,
        isActive: true,
        role: { in: [...TEAM_WORKSPACE_ROLES] },
      },
      select: { id: true },
    });
    return !!role;
  }

  // ============================================================
  // Внутреннее
  // ============================================================

  private profileSpec(profile: string): FileProfileSpec {
    return FILE_PROFILES[profile] ?? FILE_PROFILES.generic;
  }

  private async assertQuota(ownerType: FileOwnerType, ownerId: string, addBytes: number): Promise<void> {
    if (await this.overQuota(ownerType, ownerId, addBytes)) {
      const limitGb = (FILE_QUOTAS[ownerType] / (1024 * 1024 * 1024)).toFixed(0);
      throw new BadRequestException(`Недостаточно места в хранилище (лимит ${limitGb} ГБ)`);
    }
  }

  /** Превысит ли добавление addBytes квоту владельца (учитывает уже занятое) */
  private async overQuota(ownerType: FileOwnerType, ownerId: string, addBytes: number): Promise<boolean> {
    const usage = await this.db.fileQuotaUsage.findUnique({
      where: { ownerType_ownerId: { ownerType, ownerId } },
    });
    const used = usage ? Number(usage.bytesUsed) : 0;
    return used + addBytes > FILE_QUOTAS[ownerType];
  }

  private async markFailed(fileId: string, reason: string): Promise<void> {
    await this.db.fileObject
      .updateMany({ where: { id: fileId, status: 'uploading' }, data: { status: 'failed', error: reason } })
      .catch(() => undefined);
  }

  /**
   * Сверка заявленного MIME с реальной сигнатурой (magic bytes). Ловит и polyglot-XSS
   * («картинка», которая на деле HTML), и переименованные .exe.
   */
  private validateMagicBytes(declaredMime: string, detectedMime: string | undefined): string | null {
    const declared = declaredMime.toLowerCase();
    const detected = detectedMime?.toLowerCase();

    if (detected && EXEC_SNIFF_MIME.has(detected)) return 'Исполняемые файлы запрещены';

    const family = (m: string) => m.split('/')[0];
    if (family(declared) === 'image' || family(declared) === 'video') {
      if (!detected) return 'Содержимое не похоже на заявленный тип файла';
      if (family(detected) !== family(declared)) return 'Содержимое не соответствует заявленному типу';
      return null;
    }
    if (family(declared) === 'audio') {
      if (!detected) return 'Содержимое не похоже на аудио';
      if (family(detected) !== 'audio' && !AUDIO_CONTAINER_MIME.has(detected)) {
        return 'Содержимое не соответствует заявленному аудио';
      }
      return null;
    }
    if (declared === 'application/pdf') {
      return detected === 'application/pdf' ? null : 'Содержимое не является PDF';
    }
    if (family(declared) === 'text') {
      // у настоящего текста нет бинарной сигнатуры
      return detected ? 'Содержимое не соответствует заявленному текстовому типу' : null;
    }
    if (declared.startsWith('application/vnd.openxmlformats') || declared === 'application/msword'
      || declared === 'application/vnd.ms-excel' || declared === 'application/vnd.ms-powerpoint') {
      if (detected && detected !== declared && !OFFICE_SNIFF_OK.has(detected)
        && !detected.startsWith('application/vnd.openxmlformats')) {
        return 'Содержимое не соответствует документу Office';
      }
      return null;
    }
    return null; // прочие типы — без строгой проверки (blacklist расширений уже отработал)
  }

  private sha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  private async readHead(key: string, bytes: number): Promise<Buffer> {
    try {
      const { stream } = await this.driver.getStream(key, { start: 0, end: bytes - 1 });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    } catch {
      return Buffer.alloc(0);
    }
  }

  private async getRowWithVariants(fileId: string): Promise<{ row: FileRow; variants: VariantRow[] }> {
    const row = await this.db.fileObject.findUnique({
      where: { id: fileId },
      include: { variants: true },
    });
    if (!row) throw new NotFoundException('Файл не найден');
    const { variants, ...rest } = row;
    return { row: rest as FileRow, variants: variants as VariantRow[] };
  }

  private variantName(originalName: string, kind: string, mime: string): string {
    const base = originalName.replace(/\.[^.]+$/, '');
    const ext = mime === 'image/webp' ? 'webp' : mime === 'image/jpeg' ? 'jpg' : 'bin';
    return `${base}_${kind}.${ext}`;
  }

  /** Найти вариант в наборе (404, если запрошен, но отсутствует); null = оригинал */
  private pickVariant(variants: VariantRow[], variantKind?: string | null): VariantRow | null {
    if (!variantKind) return null;
    const v = variants.find((x) => x.kind === variantKind);
    if (!v) throw new NotFoundException('Вариант файла не найден');
    return v;
  }

  /** Ключ/mime/имя для отдачи: вариант или оригинал (единый источник для всех раздач) */
  private targetForVariant(
    row: FileRow,
    variant: Pick<VariantRow, 'kind' | 'mime' | 'storageKey'> | null,
  ): { key: string; mime: string; name: string } {
    return variant
      ? { key: variant.storageKey, mime: variant.mime, name: this.variantName(row.name, variant.kind, variant.mime) }
      : { key: row.storageKey, mime: row.mime, name: row.name };
  }

  contentDisposition(mime: string, name: string): string {
    const type = isInlineMime(mime) ? 'inline' : 'attachment';
    const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    const encoded = encodeURIComponent(name).replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16));
    return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
  }

  private eventPayload(row: FileRow): Record<string, unknown> {
    return {
      fileId: row.id,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      uploaderId: row.uploaderId,
      profile: row.profile,
      kind: row.kind,
      mime: row.mime,
      size: Number(row.size),
      name: row.name,
    };
  }

  serializeFile(row: FileRow, variants: VariantRow[]): FileDto {
    return {
      id: row.id,
      ownerType: row.ownerType as FileOwnerType,
      ownerId: row.ownerId,
      uploaderId: row.uploaderId,
      profile: row.profile,
      kind: row.kind as FileDto['kind'],
      name: row.name,
      mime: row.mime,
      size: Number(row.size),
      sha256: row.sha256,
      status: row.status as FileDto['status'],
      visibility: row.visibility as FileDto['visibility'],
      publicUrl:
        row.visibility === 'public' && row.publicToken && row.status === 'ready'
          ? this.urls.publicUrl(row.publicToken)
          : null,
      scanStatus: row.scanStatus as FileDto['scanStatus'],
      meta: (row.meta as Record<string, unknown> | null) ?? null,
      variants: variants.map((v) => ({
        kind: v.kind as FileDto['variants'][number]['kind'],
        mime: v.mime,
        size: Number(v.size),
        meta: (v.meta as Record<string, unknown> | null) ?? null,
      })),
      createdAt: row.createdAt.toISOString(),
      readyAt: row.readyAt ? row.readyAt.toISOString() : null,
    };
  }
}
