import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Положить байты во временный файл, отдать путь и гарантированно прибрать за собой.
 *
 * Нужен там, где движок файлов принимает ПУТЬ, а не буфер (`ingestLocalFile`,
 * `replaceContent` — они считают sha256 и magic-bytes потоком, чтобы не держать
 * 200-мегабайтную запись собрания в памяти), а породил байты мы сами: собранный
 * .docx, отпечаток PDF, замороженная копия предмета подписи, контейнер CMS.
 *
 * Одна реализация на платформу: раньше эта функция жила приватной копией в
 * джобах Документов, и второй потребитель означал бы вторую копию — ровно тот
 * класс расхождений, из-за которого разъехались два обхода графа Окружения.
 */
export async function withTempFile<T>(
  name: string,
  bytes: Buffer,
  fn: (filePath: string) => Promise<T>,
): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sa6-tmp-'));
  const filePath = path.join(dir, name.replace(/[\\/]/g, '-'));
  await fsp.writeFile(filePath, bytes);
  try {
    return await fn(filePath);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
