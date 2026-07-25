import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DOCS_JOB_TYPES, DOCS_LIMITS, DOCS_QUEUE } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { FilesService } from '../files/files.service';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { DocsEditorClient } from './docs-editor.client';
import { DocsRouterService } from './docs-router.service';

type RenditionTarget = 'pdf' | 'text';

/**
 * Ленивые производные документа: PDF-отпечаток (печать и будущая ЭЦП — подписывается
 * именно отпечаток неизменяемой версии) и текст для ИИ (слот RAG, FileVariant
 * kind='text'). Механизм есть всегда, запускается ТОЛЬКО по требованию — гнать
 * конвертацию на каждое автосохранение бессмысленно и дорого.
 *
 * Производные живут вариантами исходного файла, поэтому замена содержимого
 * (FilesService.replaceContent) сносит их автоматически: протухший PDF невозможен.
 */
@Injectable()
export class DocsRenditionService implements OnModuleInit {
  private readonly logger = new Logger(DocsRenditionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    private readonly jobs: JobsService,
    private readonly jobsRegistry: JobsRegistry,
    private readonly editor: DocsEditorClient,
    private readonly router: DocsRouterService,
  ) {}

  onModuleInit(): void {
    for (const [target, type] of [
      ['pdf', DOCS_JOB_TYPES.rendition],
      ['text', DOCS_JOB_TYPES.text],
    ] as Array<[RenditionTarget, string]>) {
      this.jobsRegistry.register(type, (payload) => this.run(String(payload.documentId), target), {
        queue: DOCS_QUEUE,
        queueConcurrency: DOCS_LIMITS.queueConcurrency,
        maxAttempts: 3,
        backoffBaseMs: DOCS_LIMITS.milestoneBackoffBaseMs,
        // Конвертация — внешний вызов к редактору: аренда обязана перекрывать его таймаут
        leaseMs: DOCS_LIMITS.convertTimeoutMs + 60_000,
      });
    }
  }

  /**
   * Заказать производную. Возвращает ready=true, если она уже посчитана для ТЕКУЩЕГО
   * содержимого — тогда клиент сразу идёт за ней обычной ссылкой скачивания варианта.
   */
  async request(documentId: string, target: RenditionTarget): Promise<{ ready: boolean }> {
    if (!this.editor.enabled) throw new BadRequestException('Редактор документов не подключен');
    const doc = await this.db.document.findUnique({
      where: { id: documentId },
      select: { fileId: true },
    });
    if (!doc) throw new BadRequestException('Документ не найден');
    const file = await this.db.fileObject.findUnique({
      where: { id: doc.fileId },
      select: { sha256: true },
    });
    const kind = target === 'pdf' ? 'pdf' : 'text';
    const existing = await this.files.getVariant(doc.fileId, kind);
    if (existing && (!file?.sha256 || existing.meta?.sha256 === file.sha256)) return { ready: true };

    await this.jobs.enqueue(null, {
      type: target === 'pdf' ? DOCS_JOB_TYPES.rendition : DOCS_JOB_TYPES.text,
      payload: { documentId },
      // Контентно-адресуемый ключ: пока содержимое то же, повторные заказы не плодят работу
      uniqueKey: `docs:${kind}:${documentId}:${file?.sha256 ?? 'na'}`,
    });
    return { ready: false };
  }

  private async run(documentId: string, target: RenditionTarget): Promise<void> {
    if (!this.editor.enabled) throw new JobDiscardError('редактор документов выключен');
    const doc = await this.db.document.findUnique({ where: { id: documentId } });
    if (!doc) throw new JobDiscardError(`документ ${documentId} удалён`);
    const file = await this.db.fileObject.findUnique({ where: { id: doc.fileId } });
    if (!file || file.status !== 'ready') throw new JobDiscardError('файл документа недоступен');
    if (file.scanStatus === 'infected') throw new JobDiscardError('файл помечен как заражённый');

    const kind = target === 'pdf' ? 'pdf' : 'text';
    const existing = await this.files.getVariant(doc.fileId, kind);
    if (existing && file.sha256 && existing.meta?.sha256 === file.sha256) return; // уже посчитано

    const { result } = await this.files.openRawStream(doc.fileId, null);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(chunk as Buffer);
    const source = Buffer.concat(chunks);

    const base = this.router.resolveBase(doc.id, doc.editorBaseUrl);
    const converted = await this.editor.convertTo(
      base,
      target === 'pdf' ? 'pdf' : 'txt',
      source,
      `${doc.title}.${doc.ext}`,
    );

    const tmp = path.join(this.tmpDir(), `docs-${kind}-${randomUUID()}`);
    await fs.promises.writeFile(tmp, converted);
    await this.files.putDerivedVariant({
      fileId: doc.fileId,
      kind,
      sourcePath: tmp,
      mime: target === 'pdf' ? 'application/pdf' : 'text/plain',
      // sha исходника — по нему видно, не протухла ли производная
      meta: { sha256: file.sha256 },
    });
    this.logger.log(`производная ${kind} документа ${documentId} готова (${converted.length} байт)`);
  }

  private tmpDir(): string {
    const root = path.resolve(process.cwd(), process.env.FILES_LOCAL_ROOT ?? './storage');
    const dir = path.join(root, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}
