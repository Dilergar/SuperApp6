import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import * as yazl from 'yazl';
import { DatabaseService } from '../../shared/database/database.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { badRequest, notFound } from '../../shared/errors/api-error';
import { FilesService } from '../../core/files/files.service';
import { SignProtocolService } from '../../core/sign/sign-protocol.service';
import { HrService } from './hr.service';
import { fullName } from '../../shared/utils/user-name';

/** Потолки выгрузки: инспекция забирает дело, а не весь архив организации */
const EXPORT_MAX_DOCS = 500;
const EXPORT_MAX_BYTES = 300 * 1024 * 1024;

/**
 * Выгрузка ZIP для инспекции труда (Этап 8 КЭДО): личное дело сотрудника и
 * реестр за период — штампованные PDF + протоколы подписания + опись.
 * Документ обязан жить вне системы (ст. 62 ЦК РК) — выгрузка и есть этот путь.
 *
 * ЯЗЫК АРХИВА — язык ЗАПРОСА: имя ZIP, опись и подписи строк собираются здесь и
 * сейчас, для того человека, который нажал «Выгрузить». Снимком в БД ничего из
 * этого не становится, поэтому SOURCE_LOCALE тут не при чём.
 */
@Injectable()
export class HrExportService {
  private readonly logger = new Logger(HrExportService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    private readonly protocol: SignProtocolService,
    private readonly hr: HrService,
    private readonly i18n: I18nService,
  ) {}

  /** Личное дело: все кадровые документы сотрудника (подписанные и выданные) */
  async exportPersonalFile(actorId: string, workspaceId: string, userId: string, res: Response): Promise<void> {
    await this.hr.requireManager(actorId, workspaceId);
    const person = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    if (!person) throw notFound('hr.employeeNotFound');
    const docs = await this.db.orgDocument.findMany({
      where: {
        workspaceId,
        subjectUserId: userId,
        status: { in: ['signed', 'registered', 'active', 'archived'] },
      },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_MAX_DOCS,
      include: { docType: { select: { name: true } } },
    });
    await this.streamZip(res, `${this.i18n.translate('hr.export.personalFile', { name: fullName(person) })}.zip`, docs, actorId);
  }

  /** Реестр за период (опционально — один вид) */
  async exportRegistry(
    actorId: string,
    workspaceId: string,
    opts: { docTypeId?: string; from?: string; to?: string },
    res: Response,
  ): Promise<void> {
    await this.hr.requireManager(actorId, workspaceId);
    const docs = await this.db.orgDocument.findMany({
      where: {
        workspaceId,
        status: { in: ['signed', 'registered', 'active', 'archived'] },
        ...(opts.docTypeId ? { docTypeId: opts.docTypeId } : {}),
        ...(opts.from || opts.to
          ? {
              createdAt: {
                ...(opts.from ? { gte: new Date(opts.from) } : {}),
                ...(opts.to ? { lte: new Date(opts.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: EXPORT_MAX_DOCS,
      include: { docType: { select: { name: true } } },
    });
    await this.streamZip(res, `${this.i18n.translate('hr.export.registry')}.zip`, docs, actorId);
  }

  private async streamZip(
    res: Response,
    zipName: string,
    docs: {
      id: string;
      title: string;
      number: string | null;
      status: string;
      createdAt: Date;
      signedAt: Date | null;
      fileId: string | null;
      pdfFileId: string | null;
      documentId: string | null;
      builderDoc: unknown;
      subjectUserId: string | null;
      docType: { name: string };
    }[],
    actorId: string,
  ): Promise<void> {
    if (!docs.length) throw badRequest('hr.exportEmpty');

    const zip = new yazl.ZipFile();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(zipName.replace(/[\\/:*?"<>|]/g, '-'))}`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    zip.outputStream.pipe(res);
    // Обрыв скачивания (закрыли вкладку) — прекращаем сборку: без этого мёртвый
    // ответ перестаёт вычитывать поток, тот встаёт в бэкпрешер, а мы продолжаем
    // читать файлы хранилища В ПАМЯТЬ (урок ZIP-выгрузки гостевых ссылок).
    let aborted = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        aborted = true;
        // yazl типизирует outputStream как ReadableStream без destroy — берём
        // настоящий Readable (он им и является в рантайме).
        const out = zip.outputStream as unknown as import('node:stream').Readable;
        out.unpipe(res);
        out.destroy();
      }
    });

    let total = 0;
    let skippedByLimit = 0;
    const t = (key: string, values?: Record<string, string | number>) => this.i18n.translate(key, values);
    const fmt = this.i18n.format();
    const manifest: string[] = [t('hr.export.manifestTitle'), ''];
    for (const [i, doc] of docs.entries()) {
      if (aborted) break;
      const base = `${String(i + 1).padStart(3, '0')} ${doc.number ? `${doc.number} ` : ''}${doc.title}`.replace(
        /[\\/:*?"<>|]/g,
        '-',
      );
      manifest.push(
        t('hr.export.row', {
          n: i + 1,
          docType: doc.docType.name,
          title: doc.title,
          numberSuffix: doc.number ? t('hr.export.numberSuffix', { number: doc.number }) : '',
          status: doc.status,
          created: fmt.date(doc.createdAt, 'short'),
        }),
      );
      // Файл: штампованная копия завершённой заявки подписи → PDF-отпечаток → файл
      const request = await this.db.signRequest.findFirst({
        where: { refType: 'org_document', refId: doc.id, status: 'completed' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, stampedFileId: true },
      });
      const fileId = request?.stampedFileId ?? (doc.builderDoc ? doc.fileId : (doc.pdfFileId ?? doc.fileId));
      const variant = !doc.builderDoc && doc.pdfFileId && doc.pdfFileId === doc.fileId && doc.documentId ? 'pdf' : undefined;
      if (fileId && total <= EXPORT_MAX_BYTES) {
        try {
          const { result } = await this.files.openRawStream(fileId, variant ?? null);
          const bytes = await streamToBuffer(result.stream);
          // Потолок проверяем ДО добавления и дальше файлы не читаем ВООБЩЕ:
          // прежний `throw` внутри try ловился соседним catch, превращался в
          // строчку описи — и каждый следующий документ всё равно вычитывался
          // в память целиком, то есть защиты не было.
          if (total + bytes.length > EXPORT_MAX_BYTES) {
            total = EXPORT_MAX_BYTES + 1;
            skippedByLimit += 1;
            manifest.push(`   ! ${t('hr.export.skippedNarrow')}`);
          } else {
            total += bytes.length;
            zip.addBuffer(bytes, `${base}.pdf`, { compress: false });
          }
        } catch (e) {
          manifest.push(`   ! ${t('hr.export.fileFailed', { reason: (e as Error).message })}`);
        }
      } else if (fileId) {
        skippedByLimit += 1;
        manifest.push(`   ! ${t('hr.export.skipped')}`);
      }
      // Протокол подписания (если документ подписывался через core/sign)
      const anyRequest = await this.db.signRequest.findFirst({
        where: { refType: 'org_document', refId: doc.id, acts: { some: { status: 'signed' } } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (anyRequest) {
        try {
          const p = await this.protocol.buildProtocol({ type: 'user', userId: actorId }, anyRequest.id);
          total += p.buffer.length;
          zip.addBuffer(p.buffer, `${base} — ${t('hr.export.protocol')}.pdf`, { compress: false });
        } catch (e) {
          manifest.push(`   ! ${t('hr.export.protocolFailed', { reason: (e as Error).message })}`);
        }
      }
    }
    if (skippedByLimit > 0) {
      // Правило «no silent caps»: обрезка обязана быть видна В САМОЙ выгрузке,
      // иначе неполный архив выглядит полным именно там, где его читает инспекция.
      manifest.push(
        '',
        t('hr.export.capWarning', {
          n: skippedByLimit,
          size: this.i18n.bytes(EXPORT_MAX_BYTES),
        }),
      );
    }
    if (aborted) return;
    zip.addBuffer(Buffer.from(manifest.join('\n'), 'utf8'), `${t('hr.export.manifestFile')}.txt`);
    zip.end();

    await new Promise<void>((resolve) => {
      res.on('close', () => resolve());
      res.on('finish', () => resolve());
    });
  }
}
