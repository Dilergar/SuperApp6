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
export type FileScanStatus = 'none' | 'pending' | 'clean' | 'infected' | 'error';

/** Производные файла: миниатюры/постер сейчас; text/waveform — слоты под RAG/голосовые */
export type FileVariantKind = 'thumb' | 'medium' | 'poster' | 'waveform' | 'text';

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
