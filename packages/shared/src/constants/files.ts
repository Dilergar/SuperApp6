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
  // ODF: родные форматы LibreOffice/Collabora — движок документов (core/docs) обязан
  // принимать их наравне с OOXML, иначе .ods из редактора не загрузится обратно.
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
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
 * Аудио-контейнеры: расширение ↔ MIME — одна точка правды (веб доводит пустой/octet-stream
 * MIME по расширению; STT-подготовка называет multipart-файл по MIME). Держать в синхроне
 * с AUDIO_MIME выше: новый формат = запись в трёх соседних таблицах одного файла.
 */
export const AUDIO_EXT_TO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  webm: 'audio/webm',
};

export const AUDIO_MIME_TO_EXT: Record<string, string> = {
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/aac': '.aac',
  'audio/x-m4a': '.m4a',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
};

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
  /** Считать ли волну (meta.waveform) для аудио — капабилити профиля, не хардкод имён в движке */
  waveform?: boolean;
}

export const FILE_PROFILES: Record<string, FileProfileSpec> = {
  /** Аватарка человека/лого организации — публичная, с вариантами */
  avatar: { kind: 'image', maxSize: 5 * MB, allowedMime: IMAGE_MIME, visibility: 'public', makeVariants: true },
  /** Фото товара в магазине — публичное, с вариантами */
  listing_image: { kind: 'image', maxSize: 10 * MB, allowedMime: IMAGE_MIME, visibility: 'public', makeVariants: true },
  /** Вложение в чат/задачу — приватное, любой безопасный тип */
  chat_attachment: { kind: 'any', maxSize: 200 * MB, allowedMime: null, visibility: 'private', makeVariants: true },
  /** Голосовое сообщение (MediaRecorder: ogg/webm/mp4) */
  voice_message: { kind: 'audio', maxSize: 20 * MB, allowedMime: AUDIO_MIME, visibility: 'private', makeVariants: true, waveform: true },
  /** Запись Диктофона (собрание/лекция) — ровно apiSingleRequestMax (~3.5ч mp3 / 6ч+ m4a) */
  dictaphone: { kind: 'audio', maxSize: 200 * MB, allowedMime: AUDIO_MIME, visibility: 'private', makeVariants: true, waveform: true },
  /** Документ (Word/Excel/PDF/…) — приватный, без вариантов (текст-извлечение придёт с RAG) */
  document: { kind: 'document', maxSize: 50 * MB, allowedMime: DOCUMENT_MIME, visibility: 'private', makeVariants: false },
  /**
   * Файл на Диске (OmniDrive) — любой безопасный тип до 2 ГБ.
   *
   * Потолок больше, чем у одиночного запроса к API (`apiSingleRequestMax`): всё, что
   * крупнее, обязано ехать S3-multipart'ом. На local-драйвере multipart нет вовсе,
   * поэтому там движок режет загрузку по `apiSingleRequestMax` — в разработке файл
   * больше 200 МБ на Диск не положить, и это осознанно.
   */
  drive_file: { kind: 'any', maxSize: 2 * GB, allowedMime: null, visibility: 'private', makeVariants: true },
  /**
   * ЗАМОРОЖЕННАЯ копия того, что человек видел и подписывал (core/sign).
   *
   * Отдельный профиль, а не `document`, по трём причинам: копия неизменяема
   * (её никогда не правит редактор), она не считается в квоту владельца и её не
   * трогают ретеншн-кроны — доказательства подписания хранятся столько же,
   * сколько сам документ (по приказу № 279-НК — до 75 лет).
   */
  sign_subject: { kind: 'document', maxSize: 100 * MB, allowedMime: null, visibility: 'private', makeVariants: false },
  /**
   * Контейнер подписи CMS и квитанции OCSP/TSP (core/sign). Килобайты, но
   * юридически это и есть доказательство — тот же вечный режим хранения.
   * В `bytea` не кладём: миллионы подписей раздули бы TOAST, WAL и бэкапы;
   * целостность держат `cmsSha256` на строке акта и запись файла ДО финализации.
   */
  sign_cms: { kind: 'other', maxSize: 4 * MB, allowedMime: null, visibility: 'private', makeVariants: false },
  /**
   * Штампованная копия подписанного документа (core/sign): PDF с полосами-штампами
   * и «Листом подписей». НЕ evidence-профиль намеренно: это витрина для людей, а не
   * доказательство — при потере пересобирается из замороженной копии и актов,
   * поэтому живёт обычным файлом (квота, уборка) без вечного режима.
   */
  sign_stamped: { kind: 'document', maxSize: 120 * MB, allowedMime: null, visibility: 'private', makeVariants: false },
  /** Фолбэк без специфики */
  generic: { kind: 'any', maxSize: 100 * MB, allowedMime: null, visibility: 'private', makeVariants: true },
};

/**
 * Профили, которые НЕ считаются в квоту владельца и НЕ подлежат уборке.
 *
 * Единственный класс — доказательства электронной подписи (core/sign): их срок
 * хранения равен сроку хранения самого документа, а место, которое они занимают,
 * человек не выбирал и удалить не может. Списать это на его 15 ГБ было бы
 * одновременно и неверным счётом, и способом потерять доказательство при
 * переполнении.
 */
export const EVIDENCE_FILE_PROFILES: readonly string[] = ['sign_subject', 'sign_cms'];

export function isEvidenceProfile(profile: string | null | undefined): boolean {
  return !!profile && EVIDENCE_FILE_PROFILES.includes(profile);
}

/**
 * Профили, которые человек не удаляет РУКАМИ, но системная уборка трогать может.
 *
 * Отличие от доказательств: эти файлы производные и пересобираемые, поэтому в
 * квоте и в уборке они обычные. Но пока на них ссылается живая строка сервиса,
 * ручное `DELETE /files/:id` ломает то, что этой строкой обещано. Штампованная
 * копия подписи — ровно такой случай: `uploaderId` у неё — отправитель, то есть
 * удалить её мог он сам, а на неё в этот момент указывают `SignRequest.stampedFileId`,
 * узел реестра на Диске и кнопка «Скачать со штампами» у контрагента.
 */
export const SYSTEM_MANAGED_FILE_PROFILES: readonly string[] = ['sign_stamped'];

export function isSystemManagedProfile(profile: string | null | undefined): boolean {
  return !!profile && SYSTEM_MANAGED_FILE_PROFILES.includes(profile);
}

export type FileProfileKey = keyof typeof FILE_PROFILES;

/** Квоты хранилища на владельца (байты); тарифы/UI — позже, вместе с подпиской */
export const FILE_QUOTAS: Record<FileOwnerType, number> = {
  user: 15 * GB,
  workspace: 100 * GB,
};

/** Исполняемые/опасные расширения — не принимаем ни под каким профилем */
export const EXEC_EXT_BLACKLIST = [
  'exe', 'bat', 'cmd', 'com', 'msi', 'msix', 'scr', 'pif', 'cpl', 'dll', 'sys',
  'sh', 'bash', 'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'wsh', 'hta', 'reg', 'lnk',
  'jar', 'apk', 'appx', 'js', 'jse', 'mjs',
  // Установщики, драйверы, ярлыки и всё, что правит систему или реестр
  'msc', 'msp', 'mst', 'ocx', 'drv', 'vxd', 'scf', 'url', 'chm', 'hlp', 'jnlp',
  'gadget', 'ps1xml', 'psc1', 'ws', 'vb', 'inf',
  // Конфиги и сырые двоичные дампы: деловой переписке не нужны, а системе вредят
  'bin', 'conf', 'cfg', 'ini',
];

/**
 * Архивы — единственный класс, внутрь которого не смотрит ни один наш конвейер.
 * Именно так и носят вредоносное вложение, поэтому вскрывать их должен антивирус.
 */
export const ARCHIVE_EXT = [
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'xz', 'cab', 'iso', 'img',
  'arj', 'lzh', 'lha', 'ace', 'zst', 'z',
];

/** Обычные офисные форматы БЕЗ макросов (у .doc/.xls/.ppt макросы есть — их проверяем) */
const OFFICE_PLAIN_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

/** Офисные форматы С макросами — классический способ разослать вирус коллегам */
const OFFICE_MACRO_EXT = ['docm', 'dotm', 'xlsm', 'xltm', 'xlsb', 'pptm', 'potm', 'ppsm'];

/**
 * Нужно ли гнать файл через антивирус (решение продукта 2026-07-26).
 *
 * Правило построено «по умолчанию ПРОВЕРЯЕМ, исключения перечислены явно»: новый
 * неизвестный тип попадёт в проверку сам, а не проскочит мимо.
 *
 * Исключены:
 *   • картинки, аудио, видео — исполняемого кода в них нет, а вес большой;
 *   • обычные офисные документы — их правит наш собственный редактор, и каждое его
 *     автосохранение это «новые байты»: полный проход по 30-МБ таблице дважды в минуту
 *     на каждого правящего стоил бы дорого и не давал ничего.
 *
 * Остаются под проверкой: архивы, PDF, текст, макро-офис, всё неопознанное
 * (`application/octet-stream` и прочее).
 */
export function shouldScanFile(file: { name?: string | null; mime?: string | null }): boolean {
  const ext = fileExtension(file.name ?? '');
  const mime = (file.mime ?? '').split(';')[0].trim().toLowerCase();
  if (ext && OFFICE_MACRO_EXT.includes(ext)) return true;
  if (ext && ARCHIVE_EXT.includes(ext)) return true;
  if (mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/')) return false;
  if (OFFICE_PLAIN_MIME.has(mime)) return false;
  return true;
}

export const FILE_LIMITS = {
  /** До этого размера байты идут через API одним запросом; выше — S3 multipart */
  apiTransportMax: 25 * MB,
  /**
   * Абсолютный потолок размера файла (самый щедрый профиль — `drive_file`).
   * Ограничивает ТОЛЬКО схему загрузки и multipart-путь.
   */
  hardMaxSize: 2 * GB,
  /**
   * Потолок ОДНОГО HTTP-запроса с байтами: сюда смотрят multer и приёмник правок WOPI.
   * Отдельная величина, а не `hardMaxSize`, потому что 2-ГБ файл обязан ехать частями:
   * приняв такой объём одним запросом на диск, мы бы держали его целиком в проксях и
   * во временном файле. Всё, что крупнее, идёт через S3 multipart; на local-драйвере
   * multipart отсутствует, поэтому там это и есть настоящий потолок файла.
   */
  apiSingleRequestMax: 200 * MB,
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

/**
 * «Это голосовое сообщение?» — одна точка классификации voice-note для API-превью
 * («🎤 Голосовое») и веб-баблов; новый голосовой профиль добавляется здесь, а не
 * строковыми сравнениями по двум приложениям.
 */
export function isVoiceNoteProfile(profile: string | null | undefined): boolean {
  return profile === 'voice_message';
}

/** Расширение из имени файла (нижний регистр, без точки) */
export function fileExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx < 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}
