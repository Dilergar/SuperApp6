import { chmodSync, lstatSync, mkdirSync, promises as fsp, type Stats } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_TMP_NAME = 'superapp6';
/** Префиксы временных файлов, которые платформа клала прямо в /tmp до своего каталога (уборка хвостов). */
const LEGACY_PREFIXES = ['sa6-', 'consent-'];

let ensured: string | null = null;

/** Общий системный /tmp — только здесь (дверь временных файлов; страж ESLint запрещает его вне файла). */
function systemTmpDir(): string {
  // eslint-disable-next-line no-restricted-syntax -- дверь временных файлов: единственный законный os.tmpdir()
  return os.tmpdir();
}

/** Запись принадлежит процессу (POSIX: uid владельца; на Windows %TEMP% и так профиль пользователя). */
function ownedByUs(st: Stats): boolean {
  return typeof process.getuid !== 'function' || st.uid === process.getuid();
}

/**
 * Каталог временных файлов платформы (`<tmp>/superapp6`, права 0700): байты, которые
 * процесс держит на диске по ходу работы (загрузки multer, выгрузки, перекодирование
 * медиа, PDF подписи). Всё наше — только здесь: уборка по сроку (`sweepAppTmp`, шаг
 * `files.upload-tmp` раннера core/lifecycle) не может задеть чужие файлы в /tmp, а
 * соседи по машине не читают наши (0700).
 *
 * /tmp общий: каталог с нашим именем мог заранее создать ДРУГОЙ пользователь машины или
 * положить на его месте ссылку — `mkdirSync({ recursive })` молча примет чужой каталог, и
 * наши байты поедут к нему (CWE-377). Поэтому каталог обязан быть настоящим каталогом
 * процесса: ссылка или чужой владелец — отказ, права шире 0700 сужаются.
 */
export function appTmpDir(): string {
  if (ensured) return ensured;
  const dir = path.join(systemTmpDir(), APP_TMP_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`App temp dir ${dir} is not a directory`);
  if (!ownedByUs(st)) throw new Error(`App temp dir ${dir} is owned by another user`);
  if (typeof process.getuid === 'function' && (st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  ensured = dir;
  return dir;
}

/**
 * Рабочий каталог загрузок и конвейеров в корне local-хранилища (`<FILES_LOCAL_ROOT>/tmp`):
 * тот же том, что у хранилища, — rename из него дёшев (multer пишет сюда части загрузок,
 * WOPI — тело сохранения, Диск и Документы — восстановление версий). Один на платформу.
 */
export function storageTmpDir(): string {
  const root = path.resolve(process.cwd(), process.env.FILES_LOCAL_ROOT ?? './storage');
  const dir = path.join(root, 'tmp');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Путь временного файла в каталоге платформы (разделители в имени обезврежены). */
export function appTmpPath(name: string): string {
  return path.join(appTmpDir(), name.replace(/[\\/]/g, '-'));
}

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
  const dir = await fsp.mkdtemp(path.join(appTmpDir(), 'tmp-'));
  const filePath = path.join(dir, name.replace(/[\\/]/g, '-'));
  await fsp.writeFile(filePath, bytes);
  try {
    return await fn(filePath);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Прибрать брошенное: записи каталогов платформы (`appTmpDir`, `storageTmpDir`) старше
 * `before` (процесс упал посреди работы, клиент оборвал загрузку — multer CVE-2026-88932
 * оставляет файл) и старые хвосты с префиксами платформы прямо в /tmp. Не больше `limit`
 * за вызов.
 */
export async function sweepAppTmp(before: Date, limit: number): Promise<{ removed: number; more: boolean }> {
  let removed = 0;
  const scan = async (dir: string, accept: (name: string) => boolean): Promise<boolean> => {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return false;
    }
    for (const name of names) {
      if (!accept(name)) continue;
      if (removed >= limit) return true;
      const full = path.join(dir, name);
      try {
        const st = await fsp.lstat(full);
        // Чужое в общем /tmp не трогаем даже с нашим префиксом
        if (st.mtime.getTime() >= before.getTime() || !ownedByUs(st)) continue;
        await fsp.rm(full, { recursive: true, force: true });
        removed++;
      } catch {
        /* исчез между readdir и rm — уже прибран */
      }
    }
    return false;
  };
  const more =
    (await scan(appTmpDir(), () => true)) ||
    (await scan(storageTmpDir(), () => true)) ||
    (await scan(systemTmpDir(), (n) => LEGACY_PREFIXES.some((p) => n.startsWith(p))));
  return { removed, more };
}
