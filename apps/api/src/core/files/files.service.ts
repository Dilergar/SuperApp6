import { HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../../shared/errors/api-error';
import * as fs from 'fs';
import * as nodePath from 'path';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { fromBuffer as fileTypeFromBuffer, fromFile as fileTypeFromFile } from 'file-type';
import {
  FILE_LIMITS,
  FILE_PROFILES,
  EVIDENCE_FILE_PROFILES,
  EXEC_EXT_BLACKLIST,
  HR_ERROR_CODES,
  TEAM_WORKSPACE_ROLES,
  isEvidenceProfile,
  isSystemManagedProfile,
  fileExtension,
  fileKindFromMime,
  isInlineMime,
  DRIVE_NODE_REF_TYPE,
  type FileDownloadUrl,
  type FileDto,
  type FileInitResult,
  type FilePartUrl,
  type FileProfileSpec,
  type FileUsageDto,
  type FileOwnerType,
  type CompleteFileInput,
  type InitFileInput,
  type AttachmentFileView, uuidv7, opaqueIdTail } from '@superapp/shared';
import { resolveIsoValues } from '@superapp/i18n';
import { DatabaseService } from '../../shared/database/database.service';
import { appTmpPath } from '../../shared/fs/temp-file.util';
import { I18nService } from '../../shared/i18n/i18n.service';
import { EventBusService } from '../../shared/events/event-bus.service';
import { FilesUrlService } from './files-url.service';
import { FilesRefRegistry } from './files-ref.registry';
import { FilesScanHook } from './files-scan.hook';
import { FilesPipelineService } from './files-pipeline.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { EntitlementsQuotaService } from '../entitlements/entitlements.quota.service';
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
/**
 * Ключ объекта в хранилище: `<xx>/<yy>/<id>` по ХВОСТУ id (случайная часть). Голова UUIDv7 —
 * время: шардирование по ней свалило бы все файлы одного периода в один каталог / префикс.
 */
export function fileStorageKey(id: string): string {
  const tail = opaqueIdTail(id, 4);
  return `${tail.slice(0, 2)}/${tail.slice(2, 4)}/${id}`;
}

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
    private readonly i18n: I18nService,
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
    private readonly entitlements: EntitlementsService,
    private readonly quota: EntitlementsQuotaService,
  ) {}

  onModuleInit(): void {
    this.logger.log(`Files engine: driver "${this.driver.name}"`);
  }

  // ============================================================
  // Загрузка (Slack v2: init → байты → complete)
  // ============================================================

  async init(userId: string, dto: InitFileInput): Promise<FileInitResult> {
    // Профили доказательств (core/sign) — СЛУЖЕБНЫЕ: их создаёт только сам движок
    // подписи headless-инжестом. Через HTTP они закрыты, потому что не считаются в
    // квоту и не подлежат уборке: иначе любой клиент, подставив profile в тело
    // запроса, получил бы бесконечное вечное хранилище.
    if (isEvidenceProfile(dto.profile)) {
      throw badRequest('files.serviceProfile');
    }
    const spec = this.profileSpec(dto.profile);

    const ext = fileExtension(dto.name);
    if (ext && EXEC_EXT_BLACKLIST.includes(ext)) {
      throw badRequest('files.executablesForbidden');
    }
    const mime = dto.mime.toLowerCase();
    if (spec.allowedMime && !spec.allowedMime.includes(mime)) {
      throw badRequest('files.typeNotAllowed');
    }
    if (dto.size > spec.maxSize) {
      throw badRequest('files.tooLarge', { mb: Math.floor(spec.maxSize / (1024 * 1024)) });
    }
    // Драйвер без multipart (local) физически умеет принять байты только одним запросом,
    // поэтому щедрый профиль (Диск — 2 ГБ) на нём упирается в потолок такого запроса.
    // Без этой проверки init выдал бы transport:'api', а multer оборвал бы загрузку
    // молча на 200 МБ — «загрузилось и пропало».
    if (!this.driver.supportsMultipart && dto.size > FILE_LIMITS.apiSingleRequestMax) {
      throw badRequest('files.partsOnly', { mb: Math.floor(FILE_LIMITS.apiSingleRequestMax / (1024 * 1024)) });
    }

    // Владелец: по умолчанию сам пользователь; организация — по членству (не Подрядчик)
    let ownerType: FileOwnerType = 'user';
    let ownerId = userId;
    if (dto.ownerWorkspaceId) {
      if (!(await this.isWorkspaceMember(userId, dto.ownerWorkspaceId))) {
        throw forbidden('files.notInWorkspace');
      }
      ownerType = 'workspace';
      ownerId = dto.ownerWorkspaceId;
    }

    await this.assertQuota(ownerType, ownerId, dto.size);

    const transport = dto.size > FILE_LIMITS.apiTransportMax && this.driver.supportsMultipart ? 'multipart' : 'api';

    const id = uuidv7();
    const storageKey = fileStorageKey(id);
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
      if (!row || row.status === 'deleted') throw notFound('files.notFound');
      if (row.uploaderId !== userId) throw forbidden('files.uploaderOnlyComplete');
      if (row.status !== 'uploading') throw conflict('files.alreadyComplete');
      if (row.uploadId) throw badRequest('files.awaitsMultipart');

      const spec = this.profileSpec(row.profile);
      if (tmp.size > spec.maxSize) {
        await this.markFailed(fileId, 'the size limit was exceeded');
        throw new ApiError(HttpStatus.PAYLOAD_TOO_LARGE, { code: 'files.tooLargeForProfile' });
      }

      const detected = await fileTypeFromFile(tmp.path).catch(() => undefined);
      const sniffError = this.validateMagicBytes(row.mime, detected?.mime);
      if (sniffError) {
        await this.markFailed(fileId, sniffError);
        throw badRequest(sniffError);
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
    if (!row || row.status === 'deleted') throw notFound('files.notFound');
    if (row.uploaderId !== userId) throw forbidden('files.uploaderOnlyContinue');
    if (row.status !== 'uploading' || !row.uploadId) {
      throw badRequest('files.notMultipart');
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
    if (!row || row.status === 'deleted') throw notFound('files.notFound');
    if (row.uploaderId !== userId) throw forbidden('files.uploaderOnlyComplete');
    if (row.status === 'ready') throw conflict('files.alreadyComplete');
    if (row.status !== 'uploading') throw conflict('files.uploadNotActive');

    const spec = this.profileSpec(row.profile);
    let finalSize: bigint;
    let sha256 = row.sha256;

    if (row.uploadId) {
      // multipart: собрать объект, проверить размер и сигнатуру
      if (!dto.parts?.length) throw badRequest('files.noParts');
      await this.driver.completeMultipart(row.storageKey, row.uploadId, dto.parts);
      const size = await this.driver.size(row.storageKey);
      if (size == null) throw badRequest('files.storageNoConfirm');
      if (size > spec.maxSize) {
        await this.driver.delete(row.storageKey).catch(() => undefined);
        await this.markFailed(fileId, 'the size limit was exceeded');
        throw new ApiError(HttpStatus.PAYLOAD_TOO_LARGE, { code: 'files.tooLargeForProfile' });
      }
      finalSize = BigInt(size);
      const head = await this.readHead(row.storageKey, 4100);
      const detected = head.length ? await fileTypeFromBuffer(head).catch(() => undefined) : undefined;
      const sniffError = this.validateMagicBytes(row.mime, detected?.mime);
      if (sniffError) {
        await this.driver.delete(row.storageKey).catch(() => undefined);
        await this.markFailed(fileId, sniffError);
        throw badRequest(sniffError);
      }
      // sha256 всего объекта для multipart не считаем в запросе (v1); клиент мог прислать свой
      sha256 = dto.sha256 ?? sha256;
    } else {
      // api: байты должен был принести putContent (sha256 проставлен там)
      if (!row.sha256) throw badRequest('files.bytesMissing');
      if (dto.sha256 && dto.sha256.toLowerCase() !== row.sha256.toLowerCase()) {
        throw badRequest('files.checksumMismatch');
      }
      const size = await this.driver.size(row.storageKey);
      if (size == null) throw badRequest('files.objectMissing');
      finalSize = BigInt(size);
    }

    // Пустой объект «ready» неотдаваем (range 0>=0 → 416) и бессмыслен — режем здесь.
    if (finalSize <= BigInt(0)) {
      await this.driver.delete(row.storageKey).catch(() => undefined);
      await this.markFailed(fileId, 'the file is empty');
      throw badRequest('files.empty');
    }
    // Квота проверяется по ФАКТИЧЕСКОМУ размеру: init считал заявленный (клиент мог
    // соврать size=1 и залить 200 МБ). Байты ещё НЕ в fileQuotaUsage — учёт ниже в tx.
    if (await this.overQuota(row.ownerType as FileOwnerType, row.ownerId, Number(finalSize))) {
      await this.driver.delete(row.storageKey).catch(() => undefined);
      await this.markFailed(fileId, 'the storage quota was exceeded');
      await this.assertQuota(row.ownerType as FileOwnerType, row.ownerId, Number(finalSize)); // бросает 402
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
      // Квота — списание в ТОЙ ЖЕ транзакции (fail-closed; гонка после предпроверки → 402 и откат)
      const owner = { type: row.ownerType as FileOwnerType, id: row.ownerId };
      await this.entitlements.consume(tx, owner, 'files.storageBytes', Number(finalSize));
      await this.entitlements.consume(tx, owner, 'files.count', 1);
      // Джобы фоновой обработки — в ТОЙ ЖЕ транзакции (transactional outbox): коммит
      // ready = джоб есть, откат (проигранная гонка на клейме) не оставляет джоба-сироту.
      if (needsPipeline) await this.pipeline.enqueue(tx, fileId);
      await this.scanHook.enqueue(tx, fileId);
      return true;
    });
    if (!claimed) throw conflict('files.alreadyComplete');

    const fresh = await this.getRowWithVariants(fileId);
    const payload = this.eventPayload(fresh.row);
    this.events.emit('file.uploaded', payload, 'files');
    this.events.emit('file.ready', payload, 'files');
    return this.serializeFile(fresh.row, fresh.variants);
  }

  async abort(userId: string, fileId: string): Promise<void> {
    const row = await this.db.fileObject.findUnique({ where: { id: fileId } });
    if (!row || row.status === 'deleted') throw notFound('files.notFound');
    if (row.uploaderId !== userId) throw forbidden('files.uploaderOnlyCancel');
    if (row.status !== 'uploading') throw conflict('files.uploadAlreadyDone');

    // Клеймим статус ПЕРЕД удалением байтов: иначе конкурентный complete() успеет
    // объявить файл ready, а abort уже снёс его байты (TOCTOU → «ready» без объекта).
    const claimed = await this.db.fileObject.updateMany({
      where: { id: fileId, status: 'uploading' },
      data: { status: 'failed', error: 'cancelled by the user', uploadId: null },
    });
    if (claimed.count !== 1) throw conflict('files.uploadAlreadyDone');
    if (row.uploadId) await this.driver.abortMultipart(row.storageKey, row.uploadId);
    await this.driver.delete(row.storageKey).catch(() => undefined);
  }

  /**
   * Серверный (headless) инжест локального файла БЕЗ HTTP-контракта — для файлов,
   * которые породил сам бэкенд (запись звонка из LiveKit Egress; будущие импорты).
   * Тот же конвейер, что init→putContent→complete: профиль/whitelist/magic-bytes/
   * sha256/квота по факту, транзакция ready+quota, события file.*, антивирус,
   * медиа-конвейер. ИСХОДНИК НЕ ПОТРЕБЛЯЕТСЯ (копия во временный файл): вызывающий
   * может безопасно ретраить и сам удаляет источник после успеха.
   */
  async ingestLocalFile(opts: {
    path: string;
    name: string;
    mime: string;
    profile: string;
    /** Загрузивший (uploaderId) и владелец по умолчанию */
    ownerUserId: string;
    /**
     * Владелец-организация: снимок-веха документа организации обязана числиться (и
     * тратить квоту) за организацией, а не за тем, кто случайно закрыл вкладку последним.
     * Членство здесь НЕ перепроверяется — вызывающий движок работает headless и берёт
     * владение из уже существующей строки-родителя.
     */
    ownerType?: FileOwnerType;
    ownerId?: string;
    /**
     * АВТОимя: файл назвала платформа, а не человек («Звонок · 11 сент. 14:30»,
     * «Договор (в3).docx»). В строке остаётся имя в языке ИСТОЧНИКА (поиск, фолбэк),
     * а рядом ложится ключ каталога с параметрами — и человек получает файл с именем
     * НА СВОЁМ языке, в том числе при скачивании (docs/i18n.md).
     */
    autoName?: { key: string; params?: Record<string, string | number> };
  }): Promise<FileDto> {
    const ownerType: FileOwnerType = opts.ownerType ?? 'user';
    const ownerId = ownerType === 'user' ? (opts.ownerId ?? opts.ownerUserId) : opts.ownerId ?? '';
    if (!ownerId) throw badRequest('files.ownerMissing');
    const spec = this.profileSpec(opts.profile);
    const ext = fileExtension(opts.name);
    if (ext && EXEC_EXT_BLACKLIST.includes(ext)) {
      throw badRequest('files.executablesForbidden');
    }
    const mime = opts.mime.toLowerCase();
    if (spec.allowedMime && !spec.allowedMime.includes(mime)) {
      throw badRequest('files.typeNotAllowed');
    }

    const stat = await fs.promises.stat(opts.path);
    if (stat.size <= 0) throw badRequest('files.empty');
    if (stat.size > spec.maxSize) {
      throw new ApiError(HttpStatus.PAYLOAD_TOO_LARGE, {
        code: 'files.tooLarge',
        params: { mb: Math.floor(spec.maxSize / (1024 * 1024)) },
      });
    }
    // Доказательства подписания места «не занимают»: человек их не выбирал и удалить
    // не может, а срок хранения у них — срок хранения документа. Списать это на его
    // 15 ГБ значило бы и считать неверно, и однажды потерять доказательство из-за
    // переполнения чужой квоты.
    const countsToQuota = !isEvidenceProfile(opts.profile);
    if (countsToQuota) await this.assertQuota(ownerType, ownerId, stat.size);

    const detected = await fileTypeFromFile(opts.path).catch(() => undefined);
    const sniffError = this.validateMagicBytes(mime, detected?.mime);
    if (sniffError) throw badRequest(sniffError);
    const sha256 = await this.sha256File(opts.path);

    // putFromFile ПОТРЕБЛЯЕТ вход (rename) — работаем с копией, исходник не трогаем
    const id = uuidv7();
    const tmpCopy = `${opts.path}.ingest-${opaqueIdTail(id, 12)}`;
    await fs.promises.copyFile(opts.path, tmpCopy);
    const storageKey = fileStorageKey(id);
    let bytesStored = false;
    try {
      await this.driver.putFromFile(storageKey, tmpCopy, mime);
      bytesStored = true;
    } finally {
      if (!bytesStored) await fs.promises.unlink(tmpCopy).catch(() => undefined);
    }

    const needsPipeline = spec.makeVariants && ['image', 'video', 'audio'].includes(fileKindFromMime(mime));
    try {
      const row = await this.db.$transaction(async (tx) => {
        const created = await tx.fileObject.create({
          data: {
            id,
            ownerType,
            ownerId,
            uploaderId: opts.ownerUserId,
            profile: opts.profile,
            kind: fileKindFromMime(mime),
            name: opts.name,
            mime,
            size: BigInt(stat.size),
            sha256,
            status: 'ready',
            readyAt: new Date(),
            visibility: spec.visibility,
            publicToken: spec.visibility === 'public' ? randomBytes(24).toString('base64url') : null,
            storageDriver: this.driver.name,
            storageKey,
            meta: { pipeline: needsPipeline ? 'pending' : 'done', ...(opts.autoName ? { autoName: opts.autoName } : {}) },
          },
        });
        if (countsToQuota) {
          await this.entitlements.consume(tx, { type: ownerType, id: ownerId }, 'files.storageBytes', stat.size);
          await this.entitlements.consume(tx, { type: ownerType, id: ownerId }, 'files.count', 1);
        }
        // Джобы обработки/скана — в транзакции создания файла (transactional outbox).
        if (needsPipeline) await this.pipeline.enqueue(tx, id);
        await this.scanHook.enqueue(tx, id);
        return created;
      });

      const payload = this.eventPayload(row);
      this.events.emit('file.uploaded', payload, 'files');
      this.events.emit('file.ready', payload, 'files');
      return this.serializeFile(row, []);
    } catch (err) {
      // Байты уже в сторе, а строка не встала — прибираем, чтобы не копить сирот
      await this.driver.delete(storageKey).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Синтетический файл канарейки стирания (core/lifecycle): та же строка, те же байты в
   * хранилище и та же квота владельцу, что у готового файла `ingestLocalFile`, — без
   * конвейера (медиа, антивирус), сверки магических байт и событий `file.*` (посев не
   * рассылает эффектов наружу). Только для посевов канарейки.
   */
  async createCanaryFile(opts: {
    profile: string;
    ownerType: FileOwnerType;
    ownerId: string;
    uploaderId: string;
    name: string;
    mime: string;
    content: string;
  }): Promise<{ id: string; storageKey: string }> {
    const spec = this.profileSpec(opts.profile);
    const id = uuidv7();
    const storageKey = fileStorageKey(id);
    const tmp = appTmpPath(`canary-file-${id}`);
    await fs.promises.writeFile(tmp, opts.content);
    try {
      await this.driver.putFromFile(storageKey, tmp, opts.mime);
    } finally {
      await fs.promises.unlink(tmp).catch(() => undefined);
    }
    const size = Buffer.byteLength(opts.content);
    try {
      await this.db.$transaction(async (tx) => {
        await tx.fileObject.create({
          data: {
            id,
            ownerType: opts.ownerType,
            ownerId: opts.ownerId,
            uploaderId: opts.uploaderId,
            profile: opts.profile,
            kind: fileKindFromMime(opts.mime),
            name: opts.name,
            mime: opts.mime,
            size: BigInt(size),
            sha256: createHash('sha256').update(opts.content).digest('hex'),
            status: 'ready',
            readyAt: new Date(),
            visibility: spec.visibility,
            publicToken: spec.visibility === 'public' ? randomBytes(24).toString('base64url') : null,
            storageDriver: this.driver.name,
            storageKey,
            meta: { pipeline: 'done', canary: true },
          },
        });
        if (!isEvidenceProfile(opts.profile)) {
          await this.entitlements.consume(tx, { type: opts.ownerType, id: opts.ownerId }, 'files.storageBytes', size);
          await this.entitlements.consume(tx, { type: opts.ownerType, id: opts.ownerId }, 'files.count', 1);
        }
      });
    } catch (err) {
      await this.driver.delete(storageKey).catch(() => undefined);
      throw err;
    }
    return { id, storageKey };
  }

  /**
   * КОПИЯ файла внутри хранилища — новый FileObject с теми же байтами и, при желании,
   * другим владельцем.
   *
   * Нужна там, где «переложить» нельзя: у движка нет смены владельца, а квота считается
   * владельцу. Диск копирует так чужой файл («Сохранить к себе») и переносит файл между
   * личным пространством и пространством организации.
   *
   * Байты копирует ДРАЙВЕР (у s3 — на стороне хранилища), через приложение они не идут:
   * 2-ГБ файл иначе означал бы «скачать и залить обратно». Права НЕ проверяются — это
   * контракт вызывающего (как у ingestLocalFile): он уже решил, что человек вправе
   * видеть исходник и класть копию туда, куда кладёт.
   */
  async copyFile(opts: {
    fileId: string;
    /** Кто станет uploaderId копии */
    actorId: string;
    ownerType?: FileOwnerType;
    ownerId?: string;
    /** Новое имя (по умолчанию — имя исходника) */
    name?: string;
    /** Профиль копии (по умолчанию — профиль исходника) */
    profile?: string;
  }): Promise<FileDto> {
    const src = await this.db.fileObject.findUnique({ where: { id: opts.fileId } });
    if (!src || src.status !== 'ready') throw notFound('files.notFound');
    if (src.scanStatus === 'infected') throw forbidden('files.infected');

    const ownerType: FileOwnerType = opts.ownerType ?? 'user';
    const ownerId = ownerType === 'user' ? (opts.ownerId ?? opts.actorId) : (opts.ownerId ?? '');
    if (!ownerId) throw badRequest('files.copyOwnerMissing');

    const profile = opts.profile ?? src.profile;
    const spec = this.profileSpec(profile);
    const size = Number(src.size);
    if (size > spec.maxSize) {
      throw new ApiError(HttpStatus.PAYLOAD_TOO_LARGE, {
        code: 'files.tooLarge',
        params: { mb: Math.floor(spec.maxSize / (1024 * 1024)) },
      });
    }
    await this.assertQuota(ownerType, ownerId, size);

    const id = uuidv7();
    const storageKey = fileStorageKey(id);
    await this.driver.copy(src.storageKey, storageKey, src.mime);

    const needsPipeline = spec.makeVariants && ['image', 'video', 'audio'].includes(src.kind);
    try {
      const row = await this.db.$transaction(async (tx) => {
        const created = await tx.fileObject.create({
          data: {
            id,
            ownerType,
            ownerId,
            uploaderId: opts.actorId,
            profile,
            kind: src.kind,
            name: opts.name ?? src.name,
            mime: src.mime,
            size: src.size,
            sha256: src.sha256,
            status: 'ready',
            readyAt: new Date(),
            visibility: spec.visibility,
            publicToken: spec.visibility === 'public' ? randomBytes(24).toString('base64url') : null,
            storageDriver: this.driver.name,
            storageKey,
            // Вердикт антивируса у копии свой: байты те же, но статус исходника мог быть
            // получен под другой политикой (профиль сменился) — пусть решит скан.
            //
            // Разбор исходника (размеры, миниатюрный хэш, дата съёмки, волна) переносим:
            // байты те же, а считать заново либо дорого, либо уже нечем — у копии без
            // вариантов (`makeVariants: false`) конвейер вообще не запустится, и лента
            // «Фото» получила бы снимок без даты и без соотношения сторон.
            meta: {
              ...((src.meta ?? {}) as Record<string, unknown>),
              pipeline: needsPipeline ? 'pending' : 'done',
            },
          },
        });
        await this.entitlements.consume(tx, { type: ownerType, id: ownerId }, 'files.storageBytes', Number(src.size));
        await this.entitlements.consume(tx, { type: ownerType, id: ownerId }, 'files.count', 1);
        if (needsPipeline) await this.pipeline.enqueue(tx, id);
        await this.scanHook.enqueue(tx, id);
        return created;
      });

      const payload = this.eventPayload(row);
      this.events.emit('file.uploaded', payload, 'files');
      this.events.emit('file.ready', payload, 'files');
      return this.serializeFile(row, []);
    } catch (err) {
      await this.driver.delete(storageKey).catch(() => undefined);
      throw err;
    }
  }

  /**
   * ЗАМЕНА СОДЕРЖИМОГО живого файла (движок документов core/docs: редактор сохраняет
   * правки в тот же FileObject). Id файла НЕ меняется — на нём держатся снимок вложения
   * внутри Message.payload, listLinked, ссылки скачивания и все привязки; перевешивание
   * ссылки на новый файл выбросило бы вложение из чата, а осиротевший файл прибрал бы
   * реап. Права здесь НЕ проверяются: это контракт вызывающего движка (у core/docs —
   * WOPI-токен + resolveMode).
   *
   * ИСХОДНИК ПОТРЕБЛЯЕТСЯ: sourcePath переходит во владение движка (rename в хранилище);
   * при любой ошибке движок сам его прибирает — вызывающему чистить нечего.
   *
   * Байты пишутся в НОВЫЙ ключ, а подмена ключа идёт в одной транзакции с size/sha256 —
   * поэтому метаданные не могут разъехаться с байтами ни при каком падении: оборвались
   * до коммита — жива старая пара (ключ+мета), после — новая. Перезапись того же ключа
   * такой гарантии не даёт: упавшая транзакция оставила бы новые байты со старым
   * размером, то есть битые Content-Length и Range на каждой последующей выдаче.
   */
  async replaceContent(opts: {
    fileId: string;
    sourcePath: string;
    /** Кто сохранил — только для события (право проверил вызывающий движок) */
    actorId: string;
  }): Promise<{ size: number; sha256: string; previousSha256: string | null; changed: boolean }> {
    let consumed = false;
    try {
      const row = await this.db.fileObject.findUnique({ where: { id: opts.fileId } });
      if (!row || row.status !== 'ready') throw notFound('files.notFoundOrNotReady');
      // Публичные раздаются вечной ссылкой с Cache-Control: immutable — заменённые байты
      // жили бы в кэшах браузеров и CDN сколь угодно долго. Документом может стать
      // только приватный файл.
      if (row.visibility !== 'private') throw badRequest('files.publicNotEditable');
      if (row.scanStatus === 'infected') throw forbidden('files.markedInfected');

      const spec = this.profileSpec(row.profile);
      const stat = await fs.promises.stat(opts.sourcePath);
      if (stat.size <= 0) throw badRequest('files.emptyContent');
      if (stat.size > spec.maxSize) {
        throw new ApiError(HttpStatus.PAYLOAD_TOO_LARGE, {
          code: 'files.tooLarge',
          params: { mb: Math.floor(spec.maxSize / (1024 * 1024)) },
        });
      }

      // Формат не меняется: тот же MIME и та же сигнатура (редактор сохраняет документ
      // в родном формате). Сюда же упрётся попытка подсунуть под видом правки чужой тип.
      const detected = await fileTypeFromFile(opts.sourcePath).catch(() => undefined);
      const sniffError = this.validateMagicBytes(row.mime, detected?.mime);
      if (sniffError) throw badRequest(sniffError);

      const sha256 = await this.sha256File(opts.sourcePath);
      const delta = stat.size - Number(row.size);
      if (delta > 0) await this.assertQuota(row.ownerType as FileOwnerType, row.ownerId, delta);

      const newId = uuidv7();
      const newKey = fileStorageKey(newId);
      await this.driver.putFromFile(newKey, opts.sourcePath, row.mime);
      consumed = true;

      // Производные (PDF-отпечаток, извлечённый текст, миниатюры) относятся к СТАРЫМ
      // байтам — после замены они врут и должны исчезнуть вместе с подменой ключа.
      const staleVariants = await this.db.fileVariant.findMany({
        where: { fileId: row.id },
        select: { storageKey: true },
      });

      let swapped = false;
      try {
        swapped = await this.db.$transaction(async (tx) => {
          const res = await tx.fileObject.updateMany({
            // storageKey в условии = оптимистичная блокировка: параллельная замена
            // (второй PutFile) проигрывает гонку и получает 409 вместо тихой потери правок.
            where: { id: row.id, status: 'ready', storageKey: row.storageKey },
            data: {
              storageKey: newKey,
              size: BigInt(stat.size),
              sha256,
              // Вердикт антивируса относился к прежним байтам: сбрасываем в 'none' и тут
              // же ставим новый скан. Порядок важен — клейм в scanHook.enqueue ищет
              // ровно scanStatus='none', иначе он молча не сработал бы.
              scanStatus: 'none',
              error: null,
            },
          });
          if (res.count !== 1) return false;
          if (delta > 0) {
            await this.entitlements.consume(tx, { type: row.ownerType as FileOwnerType, id: row.ownerId }, 'files.storageBytes', delta);
          } else if (delta < 0) {
            await this.entitlements.release(tx, { type: row.ownerType as FileOwnerType, id: row.ownerId }, 'files.storageBytes', -delta);
          }
          if (staleVariants.length) await tx.fileVariant.deleteMany({ where: { fileId: row.id } });
          await this.scanHook.enqueue(tx, row.id);
          return true;
        });
      } catch (err) {
        await this.driver.delete(newKey).catch(() => undefined);
        throw err;
      }
      if (!swapped) {
        await this.driver.delete(newKey).catch(() => undefined);
        throw conflict('files.changedConcurrently');
      }

      // После коммита прибираем старые байты и протухшие производные. Best-effort:
      // осиротевший объект в хранилище безобиднее потерянных правок, а ночной свип
      // квот всё равно пересчитывает занятое от file_objects.
      await this.driver.delete(row.storageKey).catch(() => undefined);
      for (const v of staleVariants) await this.driver.delete(v.storageKey).catch(() => undefined);

      this.events.emit(
        'file.replaced',
        { fileId: row.id, actorId: opts.actorId, size: stat.size, sha256 },
        'files',
      );
      return {
        size: stat.size,
        sha256,
        previousSha256: row.sha256,
        changed: (row.sha256 ?? '').toLowerCase() !== sha256.toLowerCase(),
      };
    } finally {
      if (!consumed) await fs.promises.unlink(opts.sourcePath).catch(() => undefined);
    }
  }

  /**
   * Сохранить ПРОИЗВОДНУЮ файла, посчитанную чужим движком (core/docs: PDF-отпечаток
   * документа и извлечённый текст под RAG). Ключ варианта живёт рядом с оригиналом;
   * замена содержимого (replaceContent) сносит все варианты — протухшая производная
   * не переживает правку.
   *
   * ИСХОДНИК ПОТРЕБЛЯЕТСЯ (rename в хранилище), как и у остальных путей записи байт.
   */
  async putDerivedVariant(opts: {
    fileId: string;
    kind: string;
    sourcePath: string;
    mime: string;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    const row = await this.db.fileObject.findUnique({
      where: { id: opts.fileId },
      select: { storageKey: true, status: true },
    });
    if (!row || row.status !== 'ready') {
      await fs.promises.unlink(opts.sourcePath).catch(() => undefined);
      throw notFound('files.notFoundOrNotReady');
    }
    const stat = await fs.promises.stat(opts.sourcePath);
    const dir = nodePath.posix.dirname(row.storageKey.split(nodePath.sep).join('/'));
    const ext = opts.mime === 'application/pdf' ? 'pdf' : opts.mime.startsWith('text/') ? 'txt' : 'bin';
    const key = `${dir}/${opts.fileId}_${opts.kind}.${ext}`;
    await this.driver.putFromFile(key, opts.sourcePath, opts.mime);
    await this.db.fileVariant.upsert({
      where: { fileId_kind: { fileId: opts.fileId, kind: opts.kind } },
      create: {
        fileId: opts.fileId,
        kind: opts.kind,
        storageKey: key,
        mime: opts.mime,
        size: BigInt(stat.size),
        meta: (opts.meta ?? {}) as object,
      },
      update: { storageKey: key, mime: opts.mime, size: BigInt(stat.size), meta: (opts.meta ?? {}) as object },
    });
    this.events.emit('file.variant.created', { fileId: opts.fileId, kind: opts.kind, mime: opts.mime }, 'files');
  }

  /** Готовая производная файла (движок документов проверяет, не протухла ли она) */
  async getVariant(fileId: string, kind: string): Promise<{ mime: string; meta: Record<string, unknown> | null } | null> {
    const variant = await this.db.fileVariant.findUnique({
      where: { fileId_kind: { fileId, kind } },
      select: { mime: true, meta: true },
    });
    return variant ? { mime: variant.mime, meta: variant.meta as Record<string, unknown> | null } : null;
  }

  // ============================================================
  // Чтение
  // ============================================================

  async getMeta(viewerId: string, fileId: string): Promise<FileDto> {
    const { row, variants } = await this.getRowWithVariants(fileId);
    if (row.status === 'deleted') throw notFound('files.notFound');
    await this.assertCanView(viewerId, row);
    return this.serializeFile(row, variants);
  }

  async getDownloadUrl(viewerId: string, fileId: string, variantKind?: string): Promise<FileDownloadUrl> {
    const { row, variants } = await this.getRowWithVariants(fileId);
    if (row.status !== 'ready') throw notFound('files.notReadyYet');
    if (row.scanStatus === 'infected') throw forbidden('files.markedInfected');
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

  /**
   * Ссылка на скачивание БЕЗ проверки доступа — системный контракт движка: право
   * человека проверил ВЫЗЫВАЮЩИЙ (тот же договор, что у linkSystemInTx, ingestLocalFile
   * и systemDeleteFile). Проверки самого файла — готовность и вердикт антивируса —
   * остаются: их не может «проверить вызывающий», это свойства файла.
   *
   * Появилось ради гостевых ссылок (core/share-links): там доступ подтверждён токеном
   * ссылки, а пользователя нет вовсе — getDownloadUrl с его viewerId неприменим.
   * Отличие от buildAttachmentViews: тот отдаёт батч «оригинал + превью» для ленты, а
   * здесь нужен ПРОИЗВОЛЬНЫЙ вариант (PDF-отпечаток документа) поштучно.
   */
  async buildSystemDownloadUrl(fileId: string, variantKind?: string): Promise<FileDownloadUrl> {
    const { row, variants } = await this.getRowWithVariants(fileId);
    if (row.status !== 'ready') throw notFound('files.notReadyYet');
    if (row.scanStatus === 'infected') throw forbidden('files.markedInfected');

    const { key, mime, name } = this.targetForVariant(row, this.pickVariant(variants, variantKind));
    const presigned = await this.driver.presignedGet(key, FILE_LIMITS.urlTtlSec, {
      disposition: this.contentDisposition(mime, name),
      mime,
    });
    if (presigned) {
      return { url: presigned, expiresAt: new Date(Date.now() + FILE_LIMITS.urlTtlSec * 1000).toISOString() };
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
    if (row.status !== 'ready') throw notFound('files.notFound');
    if (row.scanStatus === 'infected') throw forbidden('files.markedInfected');

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
      throw notFound('files.notFound');
    }
    if (row.scanStatus === 'infected') throw forbidden('files.markedInfected');

    const variant = variantKind
      ? await this.db.fileVariant.findUnique({ where: { fileId_kind: { fileId: row.id, kind: variantKind } } })
      : null;
    if (variantKind && !variant) throw notFound('files.variantNotFound');
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

  /**
   * Абсолютный путь к байтам на local-драйвере (s3 → null): системные потребители
   * (голосовой движок) читают большой файл прямо с диска, без стрим-копии в tmp.
   * Права вызывающий проверяет сам — это сервисный API, не пользовательский.
   */
  localPathFor(storageKey: string): string | null {
    return this.driver.localPath(storageKey);
  }

  // ============================================================
  // Связи (полиморфика: файл ↔ сущность сервиса)
  // ============================================================

  /**
   * Сервисный API для потребителей.
   *
   * Привязывать можно ТОЛЬКО свой файл (как в linkManyInTx) — иначе привязка сама себе
   * выдаёт права: место наследует доступ, а с появлением core/docs ещё и право менять
   * СОДЕРЖИМОЕ. Без этой проверки достаточно было бы знать чужой fileId, прицепить его
   * к своей задаче — и получить запись в чужой файл. Проверка живёт в движке, а не в
   * договорённости с потребителями: следующий потребитель её просто не напишет.
   *
   * `system: true` — привязка от имени движка, когда право проверено ЧУЖИМ контрактом и
   * актор заведомо не владелец файла (единственный случай — клеймант записи звонка:
   * файл принадлежит включившему запись, а забирает его каждый участник).
   */
  async linkFile(
    actorId: string,
    fileId: string,
    refType: string,
    refId: string,
    role = 'attachment',
    opts: { system?: boolean } = {},
  ): Promise<void> {
    const row = await this.db.fileObject.findUnique({ where: { id: fileId } });
    if (!row || row.status !== 'ready') throw notFound('files.notFound');
    const owns = row.uploaderId === actorId || (row.ownerType === 'user' && row.ownerId === actorId);
    if (!opts.system && !owns) throw forbidden('files.ownFileOnly');
    const resolver = this.registry.get(refType);
    if (!resolver) throw badRequest('files.unknownRefType', { refType });
    this.assertProfileAllowed(refType, [row.profile]);
    if (!(await resolver.canAttach(actorId, refId))) {
      throw forbidden('files.noAttachRight');
    }
    let created = true;
    await this.db.fileLink
      .create({ data: { fileId, refType, refId, role, createdById: actorId } })
      .catch((err: { code?: string }) => {
        if (err?.code !== 'P2002') throw err; // дубль связи — не ошибка
        created = false;
      });
    // Только на НОВОЙ связи: повторная привязка того же файла не должна повторно
    // будить наблюдателей (иначе Диск клал бы одно вложение дважды).
    if (created) await this.registry.notifyLinked(null, { fileId, refType, refId, role, actorId });
  }

  /** Профиль каждого привязываемого файла должен быть разрешён для refType */
  private assertProfileAllowed(refType: string, profiles: string[]): void {
    const allowed = this.registry.options(refType)?.allowedProfiles;
    if (!allowed) return;
    const bad = profiles.find((p) => !allowed.includes(p));
    if (bad) throw badRequest('files.profileNotAllowedHere', { profile: bad });
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
      throw badRequest('files.notAllReady');
    }
    this.assertProfileAllowed(refType, rows.map((r) => r.profile));
    await tx.fileLink.createMany({
      data: fileIds.map((fileId) => ({ fileId, refType, refId, role, createdById: actorId })),
      skipDuplicates: true,
    });
    // Наблюдателей будим ВНУТРИ транзакции вызывающего: джоб, поставленный ими, уедет
    // тем же коммитом (сообщение отправилось ⇒ джоб есть, откатилось ⇒ джоба нет).
    for (const fileId of new Set(fileIds)) {
      await this.registry.notifyLinked(tx, { fileId, refType, refId, role, actorId });
    }
  }

  /**
   * СИСТЕМНАЯ привязка внутри чужой транзакции: без canAttach и без «файл мой».
   * Ставит её сам движок-потребитель, уже проверивший право человека по своему
   * контракту (core/docs пришивает refType='document', чтобы живой черновик под
   * открытым редактором не прибрал реап сирот при удалении исходного сообщения).
   * Требование авторства здесь было бы неверным: документом становится файл, который
   * загрузил кто-то другой — вложение задачи от коллеги.
   */
  async linkSystemInTx(
    tx: Prisma.TransactionClient,
    opts: { fileId: string; refType: string; refId: string; role?: string; createdById: string },
  ): Promise<void> {
    const file = await tx.fileObject.findUnique({
      where: { id: opts.fileId },
      select: { status: true, profile: true },
    });
    if (!file || file.status !== 'ready') throw notFound('files.notFoundOrNotReady');
    this.assertProfileAllowed(opts.refType, [file.profile]);
    await tx.fileLink.createMany({
      data: [
        {
          fileId: opts.fileId,
          refType: opts.refType,
          refId: opts.refId,
          role: opts.role ?? 'attachment',
          createdById: opts.createdById,
        },
      ],
      skipDuplicates: true,
    });
  }

  /**
   * Счётчик привязок ВНУТРИ чужой транзакции (атомарные лимиты вида «≤10 фото у лота»
   * под FOR UPDATE строки сущности). API движка вместо прямого чтения file_links
   * потребителем — закрывает carve-out магазина.
   */
  async countLinkedInTx(
    tx: Prisma.TransactionClient,
    refType: string,
    refId: string,
    role?: string,
  ): Promise<number> {
    return tx.fileLink.count({ where: { refType, refId, ...(role ? { role } : {}) } });
  }

  /**
   * Батч-«вьюхи» вложений для ленты сообщений (перф-ревью 2026-07-18): подписанные
   * ссылки + лёгкая мета БЕЗ пер-файловых проверок доступа — вызывающий уже проверил
   * право на КОНТЕЙНЕР (chat.view у listMessages), а раньше каждая плитка делала
   * 2 HTTP × 4–5 запросов БД (meta+download с резолвером). Стоимость здесь: ОДИН
   * findMany + подпись ссылок (HMAC/presign — чистый CPU, без БД и сети).
   * Модель Slack/Discord: ссылки приходят в теле сообщения; протухшую ссылку клиент
   * добирает обычным GET /files/:id/download.
   */
  async buildAttachmentViews(fileIds: string[]): Promise<Map<string, AttachmentFileView>> {
    const out = new Map<string, AttachmentFileView>();
    const ids = [...new Set(fileIds)];
    if (!ids.length) return out;
    const rows = await this.db.fileObject.findMany({
      where: { id: { in: ids }, status: 'ready' },
      include: { variants: true },
    });
    const expiresAt = new Date(Date.now() + FILE_LIMITS.urlTtlSec * 1000).toISOString();
    for (const row of rows) {
      if (row.scanStatus === 'infected') continue; // выдача заражённых заблокирована и тут
      const meta = (row.meta as Record<string, unknown> | null) ?? {};
      const kinds = new Set(row.variants.map((v) => v.kind));
      try {
        out.set(row.id, {
          url: await this.buildViewUrl(row, row.variants, null),
          thumbUrl: kinds.has('thumb') ? await this.buildViewUrl(row, row.variants, 'thumb') : null,
          mediumUrl: kinds.has('medium') ? await this.buildViewUrl(row, row.variants, 'medium') : null,
          posterUrl: kinds.has('poster') ? await this.buildViewUrl(row, row.variants, 'poster') : null,
          urlExpiresAt: expiresAt,
          durationMs: typeof meta.durationMs === 'number' ? meta.durationMs : null,
          width: typeof meta.width === 'number' ? meta.width : null,
          height: typeof meta.height === 'number' ? meta.height : null,
          waveform: Array.isArray(meta.waveform) ? (meta.waveform as number[]) : null,
        });
      } catch {
        // Сбой подписи одного файла не роняет ленту — клиент доберёт файл фолбэком.
      }
    }
    return out;
  }

  /** Ссылка «как getDownloadUrl», но без проверки доступа (доступ проверил вызывающий). */
  private async buildViewUrl(
    row: FileRow,
    variants: VariantRow[],
    variantKind: string | null,
  ): Promise<string> {
    const { key, mime, name } = this.targetForVariant(
      row,
      this.pickVariant(variants, variantKind ?? undefined),
    );
    const presigned = await this.driver.presignedGet(key, FILE_LIMITS.urlTtlSec, {
      disposition: this.contentDisposition(mime, name),
      mime,
    });
    if (presigned) return presigned;
    return (await this.urls.rawUrl(row.id, variantKind)).url;
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
      throw badRequest('files.notAllReady');
    }
    const byId = new Map(
      rows.map((r) => {
        const { variants, ...row } = r;
        return [r.id, this.serializeFile(row as FileRow, variants as VariantRow[])] as const;
      }),
    );
    return unique.map((id) => byId.get(id) as FileDto);
  }

  /**
   * ID файлов, привязанных к сущности, БЕЗ фильтра статуса (в отличие от listLinked) —
   * для каскадной уборки при удалении сущности-потребителя (Диктофон и т.п.).
   */
  async getLinkedFileIds(refType: string, refId: string): Promise<string[]> {
    const links = await this.db.fileLink.findMany({
      where: { refType, refId },
      select: { fileId: true },
    });
    return [...new Set(links.map((l) => l.fileId))];
  }

  /** Привязки файла — для payload'ов событий движков (потребители фильтруют по refType без своих запросов) */
  async listLinksOfFile(fileId: string): Promise<Array<{ refType: string; refId: string }>> {
    return this.db.fileLink.findMany({
      where: { fileId },
      select: { refType: true, refId: true },
    });
  }

  /**
   * Снять СЛУЖЕБНУЮ связь (anchorOnly) без проверки прав человека и прибрать файл, если
   * настоящих мест у него не осталось. Зовёт движок-владелец якоря, закончив уборку своей
   * сущности (core/docs — архивируя документ): право он проверил по своему контракту.
   */
  async unlinkSystem(fileId: string, refType: string, refId: string): Promise<void> {
    await this.db.fileLink.deleteMany({ where: { fileId, refType, refId } });
    await this.reapOrphan(fileId);
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
    if (!allowed) throw forbidden('files.noUnlinkRight');
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

  /**
   * Файл без единой связи → системный soft-delete (квота не копит невидимое).
   *
   * СЛУЖЕБНЫЕ связи (anchorOnly, напр. 'document' движка документов) местом не считаются:
   * иначе один якорь навсегда превращал бы файл в неприбираемый — удалили сообщение с
   * вложением, а байты и квота висят вечно. Не осталось настоящих мест → зовём хук
   * владельца якоря (он прибирает свою сущность и снимает связь) и досчитываем заново.
   */
  private async reapOrphan(fileId: string): Promise<void> {
    const links = await this.db.fileLink.findMany({
      where: { fileId },
      select: { refType: true, refId: true },
    });
    const anchors = links.filter((l) => this.registry.options(l.refType)?.anchorOnly);
    if (links.length > anchors.length) return; // настоящее место ещё есть

    for (const anchor of anchors) {
      const hook = this.registry.get(anchor.refType)?.onOrphaned;
      if (!hook) continue;
      try {
        await hook(anchor.refId);
      } catch (err) {
        // Не смогли — файл просто остаётся жить: лучше лишние байты, чем снесённый
        // документ, чью сущность не удалось привести в согласованное состояние.
        this.logger.warn(
          `onOrphaned ${anchor.refType}:${anchor.refId} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    const remaining = await this.db.fileLink.count({ where: { fileId } });
    // Сбой уборки не валит удаление места: осиротевший файл доберёт ночной `sweepOrphanReady` —
    // но сбой обязан быть виден (молчаливый catch прятал утечку квоты)
    if (remaining === 0) {
      await this.systemSoftDelete(fileId).catch((err: unknown) => this.logger.warn(`orphan reap of ${fileId} failed (the nightly sweep retries): ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // ============================================================
  // Удаление / квоты
  // ============================================================

  async softDelete(userId: string, fileId: string): Promise<void> {
    const row = await this.db.fileObject.findUnique({ where: { id: fileId } });
    if (!row || row.status === 'deleted') throw notFound('files.notFound');
    // Доказательства подписания (core/sign) не удаляет НИКТО — в том числе тот, кто
    // их «загрузил». Загрузившим движок записывает самого подписанта, то есть ровно
    // того, у кого есть мотив отказаться от своей подписи; без этой стены он сносил
    // бы контейнер CMS и замороженную копию обычной ручкой, а крон ретеншна через
    // неделю стирал бы и байты — доказывать подпись стало бы нечем.
    if (isEvidenceProfile(row.profile)) {
      throw forbidden('files.signProofUndeletable');
    }
    // Производные файлы под управлением сервиса (штампованная копия подписи):
    // системная уборка их трогает, руками — нельзя. Загрузившим у штампа числится
    // ОТПРАВИТЕЛЬ, поэтому без этой стены он сносил бы обычной ручкой файл, на
    // который смотрят `SignRequest.stampedFileId`, узел реестра на Диске и кнопка
    // «Скачать документ со штампами» у контрагента.
    if (isSystemManagedProfile(row.profile)) {
      throw forbidden('files.systemFile');
    }
    // КЭДО: место вправе ЗАПРЕТИТЬ удаление (подписанный кадровый документ, личный
    // архив сотрудника) — спрашиваем предикат у каждой привязки, а не полагаемся
    // на то, что «до такого файла руками не доберутся».
    if (await this.deletionBlocked(fileId)) {
      // Ключ каталога + СВОЙ машинный код КЭДО: фразу подберёт фильтр в языке
      // запроса, а `details.code` остаётся тем, по которому ветвятся клиенты.
      throw forbidden('files.hrSigned', undefined, { code: HR_ERROR_CODES.signedDocProtected });
    }
    const isOwner =
      row.uploaderId === userId || (row.ownerType === 'user' && row.ownerId === userId);
    if (!isOwner) throw forbidden('files.deleteByOwner');
    await this.doSoftDelete(row);
  }

  /**
   * refType'ы, чья привязка МОЖЕТ запретить удаление файла (`blocksDeletion`), — для
   * отчётов уборки: файл под такой привязкой каскад пропускает, и «хвостом» он не считается.
   */
  deletionGuardedRefTypes(): string[] {
    return this.registry.typesWithDeletionGuard();
  }

  /**
   * Запрещает ли какое-то из МЕСТ файла его удаление (`blocksDeletion` в
   * FileRefResolver). Направление знания обычное: движок спрашивает реестр,
   * про кадровые документы и личные архивы он не знает ничего.
   */
  private async deletionBlocked(fileId: string): Promise<boolean> {
    // Спрашиваем ТОЛЬКО у тех refType, у кого предикат вообще есть: иначе выборка
    // упиралась в потолок строк, и защищающая привязка, оказавшись сто первой,
    // молча переставала защищать (у файла-документа привязок бывают десятки).
    const guarded = this.registry.typesWithDeletionGuard();
    if (guarded.length === 0) return false;
    const links = await this.db.fileLink.findMany({
      where: { fileId, refType: { in: guarded } },
      select: { refType: true, refId: true },
    });
    for (const link of links) {
      const resolver = this.registry.get(link.refType);
      if (!resolver?.blocksDeletion) continue;
      try {
        if (await resolver.blocksDeletion(link.refId)) return true;
      } catch {
        // Предикат упал — считаем, что запрет действует (fail-closed: потерять
        // кадровый документ хуже, чем не удалить обычный файл прямо сейчас)
        return true;
      }
    }
    return false;
  }

  /**
   * Soft-delete без проверки «кто удаляет» — для системной уборки (осиротевшие файлы,
   * заменённый аватар). Право уже проверено на уровне сущности вызывающим сервисом.
   */
  private async systemSoftDelete(fileId: string): Promise<void> {
    const row = await this.db.fileObject.findUnique({ where: { id: fileId } });
    if (!row || row.status === 'deleted') return;
    // Системная уборка доказательств тоже не касается: у контейнера CMS вообще нет
    // привязок, и любой путь «файл осиротел → прибрать» вынес бы его молча.
    if (isEvidenceProfile(row.profile)) return;
    // КЭДО: системные пути (удаление узла Диска навсегда, каскады) тоже не
    // уничтожают подписанный кадровый документ — тихий пропуск, файл живёт
    // дальше своими остальными местами (карточка документа, личный архив).
    if (await this.deletionBlocked(fileId)) return;
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
      if (res.count !== 1) throw conflict('files.alreadyChanged');
      // Симметрия с ingestLocalFile: доказательства подписания квоту не занимали,
      // значит и списывать при удалении нечего — иначе владелец «худеет» на байты,
      // которые ему никогда не начисляли, и учёт врёт до ночной сверки.
      if (prevStatus === 'ready' && !isEvidenceProfile(row.profile)) {
        const owner = { type: row.ownerType as FileOwnerType, id: row.ownerId };
        await this.entitlements.release(tx, owner, 'files.storageBytes', Number(row.size));
        await this.entitlements.release(tx, owner, 'files.count', 1);
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
   * (аватар/лого/фото товара) живут ссылкой, не FileLink, и ноль привязок для них норма.
   * Возвращает число прибранных.
   */
  async sweepOrphanReady(graceMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - graceMs);
    // Доказательства подписания (core/sign) реап НЕ ТРОГАЕТ никогда: их срок хранения
    // равен сроку хранения самого документа (приказ № 279-НК — до 75 лет), а привязка
    // у них появляется отдельным шагом. «Час без привязки» не повод стирать то, что
    // доказывает подпись, — отсюда фильтр по EVIDENCE_FILE_PROFILES ниже.
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT fo."id" FROM "file_objects" fo
      WHERE fo."status" = 'ready'
        AND fo."visibility" = 'private'
        AND fo."created_at" < ${cutoff}
        AND fo."profile" <> ALL(${EVIDENCE_FILE_PROFILES}::text[])
        AND NOT EXISTS (SELECT 1 FROM "file_links" fl WHERE fl."file_id" = fo."id")
      LIMIT 200`;
    let reaped = 0;
    for (const r of rows) {
      await this.systemSoftDelete(r.id).catch(() => undefined);
      reaped++;
    }
    return reaped;
  }

  /**
   * Удалить файл БЕЗ проверки прав — вызывает сервис, которому файл принадлежит «домом».
   *
   * Единственный такой потребитель сегодня — Диск: у него узел это дом файла, и
   * окончательное удаление узла обязано погасить байты везде, где на них ссылались
   * (вложение в чате покажет «файл удалён»). Ровно так же ведут себя Google Drive и
   * OneDrive/Teams. Право человека проверил вызывающий по своему контракту — тот же
   * договор, что у ingestLocalFile и replaceContent.
   */
  async systemDeleteFile(fileId: string): Promise<void> {
    await this.systemSoftDelete(fileId);
  }

  /**
   * Удалить ВСЕ файлы владельца — каскад окончательного удаления организации. Тот же
   * системный путь, что у Диска: доказательства подписи и файлы под защищающей привязкой
   * (личный архив КЭДО — `blocksDeletion`) тихо пропускаются и живут дальше своими
   * местами. Пачками по id (курсор), идемпотентно: повторный прогон доберёт остаток.
   * Байты уходят ночной физической зачисткой soft-deleted. Права проверяет вызывающий.
   * `deadline` прошёл — возврат с `done: false` (каскад продолжит следующим заходом).
   * `rows` — число пройденных файлов (защищённые пропуски тоже в счёте).
   */
  async systemDeleteAllOwnedBy(ownerType: FileOwnerType, ownerId: string, opts: { deadline?: number | null } = {}): Promise<{ rows: number; done: boolean }> {
    let seen = 0;
    let after: string | undefined;
    for (;;) {
      if (opts.deadline && Date.now() > opts.deadline) return { rows: seen, done: false };
      const rows = await this.db.fileObject.findMany({
        where: { ownerType, ownerId, status: { not: 'deleted' }, ...(after ? { id: { gt: after } } : {}) },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 200,
      });
      if (rows.length === 0) break;
      for (const r of rows) {
        await this.systemSoftDelete(r.id);
        seen++;
      }
      after = rows[rows.length - 1].id;
    }
    return { rows: seen, done: true };
  }

  async getUsage(userId: string): Promise<FileUsageDto> {
    return this.getUsageFor('user', userId);
  }

  /**
   * Занятое место ЛЮБОГО владельца, включая организацию («занято 12 из 100 ГБ» на
   * Диске организации). Права проверяет вызывающий: движок не знает, кому позволено
   * видеть расход места организации, — это решает её сервис по роли.
   */
  async getUsageFor(ownerType: FileOwnerType, ownerId: string): Promise<FileUsageDto> {
    // Счётчики и потолок — из движка тарифов: потолок зависит от ступени владельца
    const subject = { type: ownerType, id: ownerId };
    const [counters, limit] = await Promise.all([this.quota.peekAll(subject), this.entitlements.valueOf(subject, 'files.storageBytes')]);
    return {
      ownerType,
      ownerId,
      bytesUsed: counters.get('files.storageBytes')?.used ?? 0,
      filesCount: counters.get('files.count')?.used ?? 0,
      limitBytes: typeof limit === 'number' ? limit : null,
    };
  }

  // ============================================================
  // Доступ
  // ============================================================

  private async assertCanView(viewerId: string, row: FileRow): Promise<void> {
    if (await this.canView(viewerId, row)) return;
    throw forbidden('files.noAccess');
  }

  /**
   * Публичный предикат «виден ли файл» по id — для движков-потребителей (core/docs
   * считает им ПРОСМОТР: объединение по всем привязкам, ровно как обычная выдача файла).
   */
  async canViewFile(viewerId: string, fileId: string): Promise<boolean> {
    const row = await this.db.fileObject.findUnique({ where: { id: fileId } });
    if (!row || row.status === 'deleted') return false;
    return this.canView(viewerId, row);
  }

  /**
   * Может ли пользователь менять СОДЕРЖИМОЕ файла через конкретную привязку. Отдельный
   * предикат: canAttach у мессенджера требует авторства сообщения, а общий документ в
   * чате правят все участники (п.7 грилла). Резолвер без canEditContent откатывается
   * на canAttach — движок расширяется, поведение остальных потребителей не меняется.
   *
   * ВАЖНО: спрашивается ровно ОДНА привязка — та, через которую человек пришёл. Право
   * править НЕ объединяется по всем местам файла, иначе «переслал документ в свой чат»
   * тихо раздавал бы право менять чужой файл.
   */
  async canEditContentVia(userId: string, refType: string, refId: string): Promise<boolean> {
    const resolver = this.registry.get(refType);
    if (!resolver) return false;
    try {
      return resolver.canEditContent
        ? await resolver.canEditContent(userId, refId)
        : await resolver.canAttach(userId, refId);
    } catch (err) {
      this.logger.warn(`resolver ${refType}.canEditContent failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** Есть ли у файла привязка к этой сущности (место, откуда пришёл человек, — настоящее) */
  async hasLink(fileId: string, refType: string, refId: string): Promise<boolean> {
    const link = await this.db.fileLink.findFirst({
      where: { fileId, refType, refId },
      select: { id: true },
    });
    return !!link;
  }

  private async canView(viewerId: string, row: FileRow): Promise<boolean> {
    if (row.visibility === 'public') return true;
    if (row.uploaderId === viewerId) return true;
    if (row.ownerType === 'user' && row.ownerId === viewerId) return true;

    // Наследование от привязанных сущностей (Salesforce ContentDocumentLink)
    const links = await this.db.fileLink.findMany({ where: { fileId: row.id }, take: 50 });

    // «Файл организации виден всей команде» — верно ровно до тех пор, пока у файла нет
    // МЕСТА с собственными правами. Появился узел на Диске организации — решает папка:
    // иначе папка «Зарплаты», открытая только руководителям, оставалась бы доступной
    // любому стажёру по прямой ссылке, и весь смысл закрытой папки пропадал бы.
    // Файлы действующих сервисов (лоты, вложения задач) узлов Диска не имеют, поэтому
    // для них правило работает как раньше.
    //
    // Спрашиваем ОТДЕЛЬНЫМ точечным запросом, а не ищем в `links`: та выборка обрезана
    // потолком в 50 строк, и у файла с длинным хвостом привязок связь Диска могла в неё
    // не попасть — закрытая папка снова открылась бы всей команде.
    //
    // Типы таких мест объявляют себя сами (`scopedPlace` в реестре), а не перечислены
    // здесь именами: кроме узла Диска это карточка документа организации, у которой
    // вид бывает «только управляющим» — а файл при этом принадлежит организации.
    const scoped = this.registry.scopedPlaceTypes();
    const onScopedPlace =
      scoped.length > 0 &&
      (await this.db.fileLink.count({ where: { fileId: row.id, refType: { in: scoped } } })) > 0;
    if (!onScopedPlace && row.ownerType === 'workspace' && (await this.isWorkspaceMember(viewerId, row.ownerId))) {
      return true;
    }

    for (const link of links) {
      const resolver = this.registry.get(link.refType);
      if (!resolver) continue;
      try {
        if (await resolver.canView(viewerId, link.refId)) return true;
      } catch (err) {
        this.logger.warn(`resolver ${link.refType} failed: ${err instanceof Error ? err.message : err}`);
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

  /** Предпроверка ДО загрузки байтов (дешёвый ранний отказ 402); авторитетно — `consume` в tx. */
  private async assertQuota(ownerType: FileOwnerType, ownerId: string, addBytes: number): Promise<void> {
    await this.entitlements.assertQuotaHeadroom({ type: ownerType, id: ownerId }, 'files.storageBytes', addBytes);
  }

  /** Превысит ли добавление addBytes квоту владельца (учитывает уже занятое; null-потолок = без ограничения) */
  private async overQuota(ownerType: FileOwnerType, ownerId: string, addBytes: number): Promise<boolean> {
    const state = await this.entitlements.quotaState({ type: ownerType, id: ownerId }, 'files.storageBytes');
    return state.limit !== null && state.used + addBytes > state.limit;
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

    if (detected && EXEC_SNIFF_MIME.has(detected)) return 'files.executablesForbidden';

    const family = (m: string) => m.split('/')[0];
    if (family(declared) === 'image' || family(declared) === 'video') {
      if (!detected) return 'files.sniffNotDeclared';
      if (family(detected) !== family(declared)) return 'files.sniffTypeMismatch';
      return null;
    }
    if (family(declared) === 'audio') {
      if (!detected) return 'files.sniffNotAudio';
      if (family(detected) !== 'audio' && !AUDIO_CONTAINER_MIME.has(detected)) {
        return 'files.sniffAudioMismatch';
      }
      return null;
    }
    if (declared === 'application/pdf') {
      return detected === 'application/pdf' ? null : 'files.sniffNotPdf';
    }
    if (family(declared) === 'text') {
      // у настоящего текста нет бинарной сигнатуры
      return detected ? 'files.sniffNotText' : null;
    }
    if (declared.startsWith('application/vnd.openxmlformats') || declared === 'application/msword'
      || declared === 'application/vnd.ms-excel' || declared === 'application/vnd.ms-powerpoint') {
      if (detected && detected !== declared && !OFFICE_SNIFF_OK.has(detected)
        && !detected.startsWith('application/vnd.openxmlformats')) {
        return 'files.sniffNotOffice';
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
    if (!row) throw notFound('files.notFound');
    const { variants, ...rest } = row;
    return { row: rest as FileRow, variants: variants as VariantRow[] };
  }

  /**
   * Имя варианта. Расширение — по НАСТОЯЩЕМУ MIME варианта: прежняя карта знала
   * только картинки, и PDF-отпечаток docx-документа звался «…_pdf.bin». Это не
   * косметика: `bin` стоит в чёрном списке исполняемых расширений, и заморозка
   * такого варианта движком подписи (профиль sign_subject идёт через обычный
   * инжест) падала «Исполняемые файлы запрещены» — отправить контрагенту или
   * подписать документ, собранный из docx-шаблона, было невозможно вовсе; у
   * загруженных PDF и builder-документов файл сам PDF, и путь варианта не
   * задействован — поэтому дыра не была видна. Совпадение kind с расширением
   * («pdf» + .pdf) суффикс не дублирует: «Договор.pdf», а не «Договор_pdf.pdf».
   */
  private variantName(originalName: string, kind: string, mime: string): string {
    const base = originalName.replace(/\.[^.]+$/, '');
    const ext =
      mime === 'image/webp'
        ? 'webp'
        : mime === 'image/jpeg'
          ? 'jpg'
          : mime === 'application/pdf'
            ? 'pdf'
            : mime === 'text/plain'
              ? 'txt'
              : 'bin';
    return kind === ext ? `${base}.${ext}` : `${base}_${kind}.${ext}`;
  }

  /** Найти вариант в наборе (404, если запрошен, но отсутствует); null = оригинал */
  private pickVariant(variants: VariantRow[], variantKind?: string | null): VariantRow | null {
    if (!variantKind) return null;
    const v = variants.find((x) => x.kind === variantKind);
    if (!v) throw notFound('files.variantNotFound');
    return v;
  }

  /** Ключ/mime/имя для отдачи: вариант или оригинал (единый источник для всех раздач) */
  private targetForVariant(
    row: FileRow,
    variant: Pick<VariantRow, 'kind' | 'mime' | 'storageKey'> | null,
  ): { key: string; mime: string; name: string } {
    return variant
      ? { key: variant.storageKey, mime: variant.mime, name: this.variantName(row.name, variant.kind, variant.mime) }
      : { key: row.storageKey, mime: row.mime, name: this.displayName(row) };
  }

  /**
   * Имя файла для ЧЕЛОВЕКА. Назвал платформа (`meta.autoName`) — собираем из каталога
   * в языке ЗАПРОСА (и дату в нём — правилами зрителя); назвал человек — отдаём как
   * есть. Так казахоязычный сотрудник скачивает «Қоңырау · 11 қыркүйек 14:30», а не
   * английскую строку, запечённую при записи.
   */
  displayName(row: { name: string; meta?: unknown }): string {
    const meta = (row.meta ?? null) as { autoName?: { key?: unknown; params?: unknown } } | null;
    const key = typeof meta?.autoName?.key === 'string' ? meta.autoName.key : null;
    if (!key || !this.i18n.has(key)) return row.name;
    const raw = (meta?.autoName?.params ?? {}) as Record<string, unknown>;
    const values: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' || typeof v === 'number') values[k] = v;
    }
    return this.i18n.translate(key, resolveIsoValues(this.i18n.format(), values));
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
      name: this.displayName(row),
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
