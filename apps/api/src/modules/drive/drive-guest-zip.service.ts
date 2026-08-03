import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { PassThrough } from 'stream';
import { pipeline } from 'stream/promises';
import * as yazl from 'yazl';
import { SHARE_LINK_ERROR_CODES, SHARE_LINK_LIMITS } from '@superapp/shared';
import { FilesService } from '../../core/files/files.service';
import { DatabaseService } from '../../shared/database/database.service';
import type { NodeRow } from './drive.service';

/** Уже сжатое повторно жать бессмысленно — только греть процессор на гостевом пути */
const STORED_KINDS = new Set(['image', 'video', 'audio']);

interface ZipEntry {
  fileId: string;
  /** Путь внутри архива, включая имя файла */
  path: string;
  compress: boolean;
}

/**
 * «Скачать всё» с гостевой страницы папки.
 *
 * Архив собирается ПОТОКОМ прямо в ответ: без временных файлов, без задания в очереди и
 * без ожидания. Цена такого решения — занятое соединение, поэтому у него есть потолки по
 * объёму и числу файлов; выше потолка честно отказываем, а не тянем час.
 *
 * Байты читаются ПО ОДНОМУ файлу за раз (yazl забирает записи по порядку, мы в том же
 * порядке их и наполняем). Открыть тысячу потоков сразу — значит держать тысячу
 * соединений к хранилищу, половина из которых успеет отвалиться по таймауту.
 */
@Injectable()
export class DriveGuestZipService {
  private readonly logger = new Logger(DriveGuestZipService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly files: FilesService,
  ) {}

  async stream(target: NodeRow, res: Response): Promise<void> {
    const { entries, totalBytes } = await this.collect(target);
    if (!entries.length) {
      throw new HttpException(
        { message: 'В папке нечего скачивать', details: { code: SHARE_LINK_ERROR_CODES.refGone } },
        HttpStatus.GONE,
      );
    }
    if (entries.length > SHARE_LINK_LIMITS.zipMaxFiles || totalBytes > SHARE_LINK_LIMITS.zipMaxBytes) {
      throw new HttpException(
        {
          message: 'Папка слишком большая для скачивания одним архивом — скачайте по частям',
          details: {
            code: SHARE_LINK_ERROR_CODES.zipTooLarge,
            maxFiles: SHARE_LINK_LIMITS.zipMaxFiles,
            maxBytes: SHARE_LINK_LIMITS.zipMaxBytes,
            files: entries.length,
            bytes: totalBytes,
          },
        },
        HttpStatus.FORBIDDEN,
      );
    }

    const zip = new yazl.ZipFile();
    // Длину не знаем заранее (сжатие идёт на лету) — отдаём chunked. Браузер покажет
    // прогресс без общего размера, это нормальная цена потоковой сборки.
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(`${target.name}.zip`));
    res.setHeader('Cache-Control', 'private, no-store');
    zip.outputStream.pipe(res);

    // Каждой записи — свой «краник». Сами краники ничего не стоят, сеть открывается
    // только когда до записи доходит очередь.
    const taps = entries.map(() => new PassThrough());
    entries.forEach((e, i) => zip.addReadStream(taps[i], e.path, { compress: e.compress }));
    zip.end();

    /**
     * Гость закрыл вкладку — и всё останавливается.
     *
     * Без этого обрыв приводил к худшему из возможных: ответ мёртв, значит yazl больше
     * не вычитывает краники, значит `pipeline` встаёт в бэкпрешер и НЕ ЗАВЕРШАЕТСЯ —
     * запрос висит вечно, держа открытый поток к хранилищу, а буферы копят весь архив
     * в памяти. Отменённые скачивания — обычное дело, поэтому это не редкий случай.
     */
    let aborted = false;
    res.on('close', () => {
      if (res.writableFinished) return; // штатное завершение, а не обрыв
      aborted = true;
      for (const tap of taps) tap.destroy();
    });

    for (let i = 0; i < entries.length; i++) {
      if (aborted) return;
      try {
        const { result } = await this.files.openRawStream(entries[i].fileId, null);
        if (aborted) {
          result.stream.destroy();
          return;
        }
        await pipeline(result.stream, taps[i]);
      } catch (err) {
        if (aborted) return; // обрыв клиента — не инцидент, писать в лог нечего
        // Файл исчез или хранилище отдало ошибку на середине. Архив уже начал уезжать
        // клиенту, дописать «извините» в него нельзя — рвём соединение, чтобы битый
        // архив не выглядел целым.
        this.logger.warn(`гостевой ZIP: файл ${entries[i].fileId} не отдался: ${msg(err)}`);
        for (const tap of taps) tap.destroy();
        res.destroy();
        return;
      }
    }
  }

  /**
   * Файлы поддерева с путями внутри архива. Папки отдельными записями не кладём: zip
   * создаёт их сам из путей, а пустые всё равно не переживают распаковку на половине
   * систем.
   */
  private async collect(target: NodeRow): Promise<{ entries: ZipEntry[]; totalBytes: number }> {
    const nodes = await this.db.driveNode.findMany({
      where: {
        OR: [{ id: target.id }, { ancestorIds: { has: target.id } }],
        trashedAt: null,
      },
      select: { id: true, name: true, kind: true, fileId: true, ancestorIds: true },
      // Потолок с запасом: папку на сто тысяч узлов мы всё равно откажемся архивировать,
      // но сначала её пришлось бы целиком загрузить в память, чтобы это понять.
      take: SHARE_LINK_LIMITS.zipMaxFiles * 2 + 1,
    });

    const nameById = new Map(nodes.map((n) => [n.id, n.name]));
    const fileIds = nodes.map((n) => n.fileId).filter((id): id is string => !!id);
    // Заражённые и недогруженные не кладём — ровно как в обычной выдаче гостю.
    const usable = fileIds.length
      ? await this.db.fileObject.findMany({
          where: { id: { in: fileIds }, status: 'ready', scanStatus: { not: 'infected' } },
          select: { id: true, size: true, kind: true },
        })
      : [];
    const byFile = new Map(usable.map((f) => [f.id, f]));

    const entries: ZipEntry[] = [];
    let totalBytes = 0;
    for (const node of nodes) {
      if (node.kind !== 'file' || !node.fileId) continue;
      const file = byFile.get(node.fileId);
      if (!file) continue;
      // Путь относительно корня архива: предки НИЖЕ цели плюс собственное имя.
      const from = node.ancestorIds.indexOf(target.id);
      const rel = from === -1 ? [] : node.ancestorIds.slice(from + 1);
      const path = [...rel.map((id) => nameById.get(id) ?? '…'), node.name].map(safeSegment).join('/');
      entries.push({ fileId: node.fileId, path, compress: !STORED_KINDS.has(file.kind) });
      totalBytes += Number(file.size);
    }
    return { entries, totalBytes };
  }
}

/** Имя файла в заголовке: ASCII-запасной вариант плюс UTF-8 по RFC 5987 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Сегмент пути внутри архива: без разделителей и без выхода наверх */
function safeSegment(s: string): string {
  return s.replace(/[/\\]/g, '_').replace(/^\.+$/, '_');
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
