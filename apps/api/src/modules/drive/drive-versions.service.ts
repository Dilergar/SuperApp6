import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { DRIVE_LIMITS, DRIVE_NODE_REF_TYPE, type DriveVersionDto } from '@superapp/shared';
import { ChatterService } from '../../core/chatter/chatter.service';
import { FilesService } from '../../core/files/files.service';
import { DatabaseService } from '../../shared/database/database.service';
import { DriveService } from './drive.service';

/** Роль связи файла-снимка: отдельная от 'attachment', иначе версии попадали бы в вложения */
const VERSION_LINK_ROLE = 'version';

/**
 * Версии обычных файлов Диска.
 *
 * У офисных документов версии свои — их режет core/docs по вехам правки, и дублировать
 * их здесь нельзя (иначе одна правка давала бы две истории). Здесь — ручной снимок:
 * «сохранить как версию» перед заменой файла и возврат назад.
 *
 * Снимок делается КОПИЕЙ НА СТОРОНЕ ХРАНИЛИЩА (FilesService.copyFile): байты не идут
 * через приложение, поэтому версия 300-МБ файла стоит один вызов CopyObject.
 */
@Injectable()
export class DriveVersionsService {
  private readonly logger = new Logger(DriveVersionsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    private readonly drive: DriveService,
    private readonly chatter: ChatterService,
  ) {}

  async list(userId: string, nodeId: string): Promise<DriveVersionDto[]> {
    await this.drive.requireNode(userId, nodeId, 'viewer');
    const rows = await this.db.driveNodeVersion.findMany({
      where: { nodeId },
      orderBy: { versionNo: 'desc' },
    });
    return rows.map((v) => ({
      id: v.id,
      versionNo: v.versionNo,
      fileId: v.fileId,
      size: Number(v.size),
      sha256: v.sha256,
      createdById: v.createdById,
      createdAt: v.createdAt.toISOString(),
    }));
  }

  /**
   * Снимок текущего содержимого файла как новой версии.
   *
   * `protectVersionId` — версия, которую ретеншн трогать не имеет права: её сейчас
   * возвращают, и удалить её посреди возврата значит потерять именно то, ради чего
   * человек нажал кнопку.
   */
  async snapshot(userId: string, nodeId: string, opts: { protectVersionId?: string } = {}): Promise<DriveVersionDto> {
    const { node } = await this.drive.requireNode(userId, nodeId, 'editor');
    if (node.kind !== 'file' || !node.fileId) throw new BadRequestException('Версии есть только у файлов');
    const space = await this.drive.loadSpace(node.spaceId);

    const copy = await this.files.copyFile({
      fileId: node.fileId,
      actorId: userId,
      ownerType: space.ownerType as 'user' | 'workspace',
      ownerId: space.ownerId,
      name: node.name,
    });

    // Номер версии: «последний + 1» под защитой unique(nodeId, versionNo). Два
    // одновременных снимка получат один номер, и проигравший просто возьмёт следующий —
    // это дешевле отдельного счётчика и не может выдать двум версиям один номер.
    let version: Awaited<ReturnType<typeof this.db.driveNodeVersion.create>> | null = null;
    for (let attempt = 0; attempt < 3 && !version; attempt++) {
      const last = await this.db.driveNodeVersion.findFirst({
        where: { nodeId: node.id },
        orderBy: { versionNo: 'desc' },
        select: { versionNo: true },
      });
      try {
        version = await this.db.driveNodeVersion.create({
          data: {
            nodeId: node.id,
            versionNo: (last?.versionNo ?? 0) + 1,
            fileId: copy.id,
            size: BigInt(copy.size),
            sha256: copy.sha256,
            createdById: userId,
          },
        });
      } catch (e: unknown) {
        if ((e as { code?: string })?.code !== 'P2002') throw e;
      }
    }
    if (!version) throw new BadRequestException('Не удалось сохранить версию, попробуйте ещё раз');

    // Снимок обязан иметь связь, иначе реап сирот движка снесёт его через сутки как
    // «приватный файл без единого места».
    await this.db.$transaction((tx) =>
      this.files.linkSystemInTx(tx, {
        fileId: copy.id,
        refType: DRIVE_NODE_REF_TYPE,
        refId: node.id,
        role: VERSION_LINK_ROLE,
        createdById: userId,
      }),
    );

    await this.applyRetention(node.id, opts.protectVersionId);
    await this.logChatter(userId, node, space, 'drive.version_saved', { versionNo: version.versionNo });

    return {
      id: version.id,
      versionNo: version.versionNo,
      fileId: version.fileId,
      size: Number(version.size),
      sha256: version.sha256,
      createdById: version.createdById,
      createdAt: version.createdAt.toISOString(),
    };
  }

  /**
   * Вернуть версию как текущее содержимое. Текущее содержимое СНАЧАЛА уезжает в
   * историю — возврат обязан быть отменяемым, иначе один клик стирает работу.
   *
   * Порядок шагов несущий: байты возвращаемой версии вычитываются ДО снимка. Иначе
   * снимок добавлял бы в историю ещё одну полную копию, ретеншн по бюджету места
   * вытеснял бы самую старую — а это ровно та версия, которую возвращают, — и дальше
   * `openRawStream` падал бы 404 на уже удалённом файле: возврат не состоялся, а версия
   * потеряна навсегда. Ремня два: сначала читаем, и вдобавок запрещаем ретеншну её
   * трогать (`protectVersionId`).
   */
  async restore(userId: string, nodeId: string, versionId: string): Promise<number> {
    const { node } = await this.drive.requireNode(userId, nodeId, 'editor');
    if (!node.fileId) throw new BadRequestException('У объекта нет файла');
    const version = await this.db.driveNodeVersion.findFirst({ where: { id: versionId, nodeId } });
    if (!version) throw new NotFoundException('Версия не найдена');

    const tmp = path.join(this.tmpDir(), `drive-restore-${randomUUID()}`);
    try {
      const { result } = await this.files.openRawStream(version.fileId, null);
      await pipeline(result.stream, fs.createWriteStream(tmp));

      await this.snapshot(userId, nodeId, { protectVersionId: version.id });
      // replaceContent ПОТРЕБЛЯЕТ исходник и сам прибирает его при любой ошибке
      await this.files.replaceContent({ fileId: node.fileId, sourcePath: tmp, actorId: userId });
    } finally {
      await fs.promises.unlink(tmp).catch(() => undefined);
    }

    const space = await this.drive.loadSpace(node.spaceId);
    await this.logChatter(userId, node, space, 'drive.version_restored', { versionNo: version.versionNo });
    this.logger.log(`узел ${nodeId}: версия ${version.versionNo} возвращена`);
    return version.versionNo;
  }

  /** Файлы-снимки узла — нужны уборке при окончательном удалении */
  async versionFileIds(nodeIds: string[]): Promise<string[]> {
    if (!nodeIds.length) return [];
    const rows = await this.db.driveNodeVersion.findMany({
      where: { nodeId: { in: nodeIds } },
      select: { fileId: true },
    });
    return rows.map((r) => r.fileId);
  }

  /**
   * Ретеншн по БЮДЖЕТУ МЕСТА, а не по числу копий — правило движка документов.
   * Снимок это полная копия файла, поэтому «10 версий» у 300-МБ видео означали бы
   * 3 ГБ на один узел; при этом договор на 200 КБ сохраняет все десять.
   */
  private async applyRetention(nodeId: string, protectVersionId?: string): Promise<void> {
    const rows = await this.db.driveNodeVersion.findMany({
      where: { nodeId },
      orderBy: { versionNo: 'desc' },
      select: { id: true, fileId: true, size: true },
    });
    const doomed: Array<{ id: string; fileId: string }> = [];
    let kept = 0;
    let used = 0;
    for (const v of rows) {
      const size = Number(v.size ?? 0);
      const mustKeep = kept < DRIVE_LIMITS.minVersions || v.id === protectVersionId;
      const fits = kept < DRIVE_LIMITS.keepVersions && used + size <= DRIVE_LIMITS.historyBudgetBytes;
      if (mustKeep || fits) {
        kept++;
        used += size;
        continue;
      }
      doomed.push({ id: v.id, fileId: v.fileId });
    }
    for (const v of doomed) {
      await this.files.unlinkSystem(v.fileId, DRIVE_NODE_REF_TYPE, nodeId).catch(() => undefined);
      await this.files.systemDeleteFile(v.fileId).catch(() => undefined);
      await this.db.driveNodeVersion.delete({ where: { id: v.id } }).catch(() => undefined);
    }
    if (doomed.length) this.logger.log(`ретеншн версий узла ${nodeId}: удалено ${doomed.length}`);
  }

  private async logChatter(
    userId: string,
    node: { id: string; name: string },
    space: { ownerType: string; ownerId: string },
    typeKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    await this.chatter
      .log(null, {
        refType: DRIVE_NODE_REF_TYPE,
        refId: node.id,
        workspaceId: space.ownerType === 'workspace' ? space.ownerId : null,
        actorId: userId,
        actorName: user ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}` : null,
        typeKey,
        payload: { targetName: node.name, ...payload },
      })
      .catch(() => undefined);
  }

  private tmpDir(): string {
    const root = path.resolve(process.cwd(), process.env.FILES_LOCAL_ROOT ?? './storage');
    const dir = path.join(root, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}
