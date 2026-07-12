import type { FileKind, FileOwnerType, FileVisibility } from '../types/file';

// ============================================
// Files Engine — профили, лимиты, квоты
// ============================================

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/** MIME изображений, которые умеет обрабатывать sharp (варианты/EXIF) */
export const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

export const DOCUMENT_MIME = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
];

export const AUDIO_MIME = [
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  // Реальные выгрузки диктофонов/телефонов (Plaud: mp3/wav; iPhone: m4a/aac)
  'audio/aac',
  'audio/x-m4a',
  'audio/flac',
  // Вариации браузеров/ОС: Windows-Chromium часто отдаёт .mp3 как audio/mp3
  'audio/mp3',
  'audio/x-flac',
];

export const VIDEO_MIME = ['video/mp4', 'video/webm', 'video/quicktime'];

/**
 * Профиль загрузки: потребитель выбирает профиль, движок навязывает правила.
 * kind 'any' = любой MIME, кроме blacklist расширений.
 */
export interface FileProfileSpec {
  kind: FileKind | 'any';
  maxSize: number;
  /** null = любой MIME (кроме EXEC_EXT_BLACKLIST по расширению) */
  allowedMime: string[] | null;
  visibility: FileVisibility;
  /** Гнать ли через медиа-конвейер (миниатюры/постер/мета) */
  makeVariants: boolean;
}

export const FILE_PROFILES: Record<string, FileProfileSpec> = {
  /** Аватарка человека/лого организации — публичная, с вариантами */
  avatar: { kind: 'image', maxSize: 5 * MB, allowedMime: IMAGE_MIME, visibility: 'public', makeVariants: true },
  /** Фото товара в магазине — публичное, с вариантами */
  listing_image: { kind: 'image', maxSize: 10 * MB, allowedMime: IMAGE_MIME, visibility: 'public', makeVariants: true },
  /** Вложение в чат/задачу — приватное, любой безопасный тип */
  chat_attachment: { kind: 'any', maxSize: 200 * MB, allowedMime: null, visibility: 'private', makeVariants: true },
  /** Голосовое сообщение (MediaRecorder: ogg/webm/mp4) */
  voice_message: { kind: 'audio', maxSize: 20 * MB, allowedMime: AUDIO_MIME, visibility: 'private', makeVariants: true },
  /** Запись Диктофона (собрание/лекция) — ровно hardMaxSize (~3.5ч mp3 / 6ч+ m4a) */
  dictaphone: { kind: 'audio', maxSize: 200 * MB, allowedMime: AUDIO_MIME, visibility: 'private', makeVariants: true },
  /** Документ (Word/Excel/PDF/…) — приватный, без вариантов (текст-извлечение придёт с RAG) */
  document: { kind: 'document', maxSize: 50 * MB, allowedMime: DOCUMENT_MIME, visibility: 'private', makeVariants: false },
  /** Фолбэк без специфики */
  generic: { kind: 'any', maxSize: 100 * MB, allowedMime: null, visibility: 'private', makeVariants: true },
};

export type FileProfileKey = keyof typeof FILE_PROFILES;

/** Квоты хранилища на владельца (байты); тарифы/UI — позже, вместе с подпиской */
export const FILE_QUOTAS: Record<FileOwnerType, number> = {
  user: 2 * GB,
  workspace: 10 * GB,
};

/** Исполняемые/опасные расширения — не принимаем ни под каким профилем */
export const EXEC_EXT_BLACKLIST = [
  'exe', 'bat', 'cmd', 'com', 'msi', 'msix', 'scr', 'pif', 'cpl', 'dll', 'sys',
  'sh', 'bash', 'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'wsh', 'hta', 'reg', 'lnk',
  'jar', 'apk', 'appx', 'js', 'jse', 'mjs',
];

export const FILE_LIMITS = {
  /** До этого размера байты идут через API одним запросом; выше — S3 multipart */
  apiTransportMax: 25 * MB,
  /** Абсолютный потолок размера файла в v1 */
  hardMaxSize: 200 * MB,
  /** Размер части multipart-загрузки */
  partSize: 25 * MB,
  /** Максимум presigned-частей за один запрос */
  maxPartsPerRequest: 100,
  /** TTL приватной ссылки скачивания, сек */
  urlTtlSec: 600,
  /** TTL presigned-ссылки на часть multipart, сек */
  partUrlTtlSec: 900,
  /** Кэш публичных файлов (immutable), сек */
  publicCacheMaxAgeSec: 31536000,
  /** Через сколько дней физически удалять soft-deleted файлы */
  deletedRetentionDays: 7,
  /** Через сколько часов считать незавершённую загрузку брошенной */
  staleUploadHours: 24,
  /**
   * Через сколько часов прибрать «ready»-файл без единой привязки (приватный): забытая
   * загрузка (композер закрыт, задача не создалась, окно краша уборки). Публичные
   * (аватар/лого/фото товара) не трогаем — они живут ссылкой, не привязкой.
   */
  orphanReadyGraceHours: 24,
  /** Максимум попыток медиа-конвейера */
  pipelineMaxRetries: 3,
  /** Размеры вариантов изображений (по длинной стороне) */
  thumbSize: 320,
  mediumSize: 1024,
  /** Максимум имени файла */
  maxNameLength: 255,
} as const;

/** MIME, которые безопасно показывать inline (остальные — Content-Disposition: attachment) */
export const INLINE_MIME_PREFIXES = ['image/', 'video/', 'audio/'];
export const INLINE_MIME_EXACT = ['application/pdf', 'text/plain'];

export function isInlineMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return INLINE_MIME_PREFIXES.some((p) => m.startsWith(p)) || INLINE_MIME_EXACT.includes(m);
}

/** Класс содержимого из MIME — для FileObject.kind и выбора конвейера */
export function fileKindFromMime(mime: string): FileKind {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (DOCUMENT_MIME.includes(m) || m.startsWith('text/')) return 'document';
  return 'other';
}

/**
 * Публичная ссылка на вариант файла: `publicUrl?variant=<kind>`, если вариант готов,
 * иначе оригинал. Одна точка сборки для всех потребителей (обложки лотов, аватар, чат) —
 * контракт `?variant=` не размазан по сервисам и вебу.
 */
export function publicVariantUrl(
  file: { publicUrl: string | null; variants?: { kind: string }[] } | null | undefined,
  kind: string,
): string | null {
  if (!file?.publicUrl) return null;
  return file.variants?.some((v) => v.kind === kind) ? `${file.publicUrl}?variant=${kind}` : file.publicUrl;
}

/** Расширение из имени файла (нижний регистр, без точки) */
export function fileExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx < 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}
