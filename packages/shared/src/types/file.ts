// ============================================
// Files Engine (core/files) — платформенное хранение файлов
// ============================================

/** Владелец файла: явное владение как у Shop (НЕ chokepoint) */
export type FileOwnerType = 'user' | 'workspace';

/** Класс содержимого (выводится из MIME) */
export type FileKind = 'image' | 'video' | 'audio' | 'document' | 'other';

export type FileStatus = 'uploading' | 'ready' | 'failed' | 'deleted';

/** private — только по правам (presigned/HMAC), public — вечная ссылка с неугадываемым токеном */
export type FileVisibility = 'private' | 'public';

/** none — не сканировался; error — скан не удался терминально (не блокирует выдачу) */
/** 'skipped' — тип файла не проверяем по политике (shouldScanFile), это НЕ сбой */
export type FileScanStatus = 'none' | 'pending' | 'clean' | 'infected' | 'error' | 'skipped';

/**
 * Производные файла: миниатюры/постер/волна сейчас; text — слот RAG, pdf — ленивый
 * отпечаток документа (core/docs: печать и будущее подписание ЭЦП неизменяемой версии).
 */
export type FileVariantKind = 'thumb' | 'medium' | 'poster' | 'waveform' | 'text' | 'pdf';

/** Транспорт байтов, выбирается движком в init */
export type FileTransport = 'api' | 'multipart';

export interface FileVariantDto {
  kind: FileVariantKind;
  mime: string;
  size: number;
  meta?: Record<string, unknown> | null;
}

export interface FileDto {
  id: string;
  ownerType: FileOwnerType;
  ownerId: string;
  uploaderId: string;
  profile: string;
  kind: FileKind;
  name: string;
  mime: string;
  size: number;
  sha256: string | null;
  status: FileStatus;
  visibility: FileVisibility;
  /** Абсолютная вечная ссылка (только у public-файлов в статусе ready) */
  publicUrl: string | null;
  scanStatus: FileScanStatus;
  meta: Record<string, unknown> | null;
  variants: FileVariantDto[];
  createdAt: string;
  readyAt: string | null;
}

export interface FileInitResult {
  file: FileDto;
  transport: FileTransport;
  /** multipart: размер одной части в байтах */
  partSize?: number;
  /** multipart: сколько частей потребуется */
  partCount?: number;
}

export interface FilePartUrl {
  partNumber: number;
  url: string;
}

export interface FileDownloadUrl {
  url: string;
  /** ISO-время истечения ссылки */
  expiresAt: string;
}

export interface FileUsageDto {
  ownerType: FileOwnerType;
  ownerId: string;
  bytesUsed: number;
  filesCount: number;
  limitBytes: number;
}

/**
 * Файл глазами ГОСТЯ по внешней ссылке (core/share-links). Живёт здесь, а не в
 * типах движка ссылок: это проекция ФАЙЛА, общая для всех гостевых потребителей —
 * сегодня Диск, завтра счета с приложениями и витрина.
 *
 * Ссылки подписаны сервером и живут ~10 минут — страница добирает свежие через
 * `/view`, когда `urlExpiresAt` прошёл.
 *
 * `available: false` — файл ещё не готов или помечен антивирусом как заражённый:
 * ссылок нет вовсе, страница честно говорит «файл недоступен».
 */
export interface ShareGuestFile {
  fileId: string;
  name: string;
  mime: string;
  kind: FileKind;
  size: number;
  available: boolean;
  /**
   * Оригинал. `null`, если владелец выключил скачивание — тогда у картинки остаётся
   * `previewUrl` (уменьшенная копия), а у файла без предпросмотра честно не остаётся
   * ничего, и страница так и говорит.
   */
  url: string | null;
  /** Уменьшенная копия для просмотра без скачивания оригинала */
  previewUrl: string | null;
  thumbUrl: string | null;
  posterUrl: string | null;
  urlExpiresAt: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  waveform: number[] | null;
  thumbhash: string | null;
}
