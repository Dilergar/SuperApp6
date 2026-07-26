import { fileExtension } from './files';

// ============================================
// Docs Engine (core/docs) — 12-й платформенный движок: работа с документами
// Документ = ЖИВОЙ файл core/files (мутируется на месте, id стабилен — модель Google
// Drive) + неизменяемые вехи-версии отдельными снимками. Редактор — внешний
// WOPI-клиент (первый драйвер — Collabora Online), сменная деталь в розетке.
// ============================================

/** Семейство редактора: по расширению в BaseFileName WOPI-клиент выбирает Writer/Calc/Impress */
export const DOCUMENT_EDITOR_KINDS = ['writer', 'calc', 'impress'] as const;

/** Жизненный цикл документа (сам файл живёт своей жизнью в core/files) */
export const DOCUMENT_STATUSES = ['active', 'archived'] as const;

/** Document.mode — владелец может «заморозить» правку (п.7 грилла) */
export const DOCUMENT_MODES = ['edit', 'readonly'] as const;

/** Что зритель МОЖЕТ с документом — результат resolveMode() (место + гранты + mode) */
export const DOCUMENT_ACCESS = ['none', 'view', 'edit'] as const;

export const DOCUMENT_VERSION_STATUSES = ['pending', 'ready', 'skipped', 'failed'] as const;

/**
 * Почему нарезана веха: ушёл последний редактор | кнопка «Сохранить версию» |
 * отпечаток перед подписанием (задел под ЭЦП — такие версии ретеншн не трогает).
 */
export const DOCUMENT_VERSION_REASONS = ['session_end', 'manual', 'pre_sign'] as const;

/** Сессия правки = одна WOPI-блокировка на документ (не на пользователя) */
export const DOCUMENT_SESSION_STATUSES = ['open', 'closed', 'expired'] as const;

export interface DocumentFormatSpec {
  ext: string;
  mime: string;
  editorKind: (typeof DOCUMENT_EDITOR_KINDS)[number];
}

/**
 * Форматы, которые движок умеет оживлять в документ. Файл ВСЁ ВРЕМЯ остаётся в родном
 * формате: ни импорта во внутренний формат, ни пересобирания (п.2 грилла) — поэтому
 * список закрытый, и каждая строка это ещё и «в чём сохраняем обратно».
 */
export const DOCUMENT_FORMATS: readonly DocumentFormatSpec[] = [
  {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    editorKind: 'writer',
  },
  {
    ext: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    editorKind: 'calc',
  },
  {
    ext: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    editorKind: 'impress',
  },
  { ext: 'odt', mime: 'application/vnd.oasis.opendocument.text', editorKind: 'writer' },
  { ext: 'ods', mime: 'application/vnd.oasis.opendocument.spreadsheet', editorKind: 'calc' },
  { ext: 'odp', mime: 'application/vnd.oasis.opendocument.presentation', editorKind: 'impress' },
];

const FORMAT_BY_EXT = new Map(DOCUMENT_FORMATS.map((f) => [f.ext, f]));
const FORMAT_BY_MIME = new Map(DOCUMENT_FORMATS.map((f) => [f.mime, f]));

/** Нормализованное расширение (без точки, нижний регистр) → формат */
export function documentFormatByExt(ext: string | null | undefined): DocumentFormatSpec | null {
  if (!ext) return null;
  return FORMAT_BY_EXT.get(ext.trim().toLowerCase().replace(/^\./, '')) ?? null;
}

/** MIME (с отброшенными параметрами вида `; charset=`) → формат */
export function documentFormatByMime(mime: string | null | undefined): DocumentFormatSpec | null {
  if (!mime) return null;
  return FORMAT_BY_MIME.get(mime.split(';')[0].trim().toLowerCase()) ?? null;
}

/**
 * Можно ли оживить этот файл в документ. MIME первичен, расширение — фолбэк: браузеры и
 * мобильные клиенты регулярно шлют `application/octet-stream` на офисных файлах, и без
 * фолбэка кнопка «Редактировать» на нормальном .xlsx просто не появилась бы.
 */
export function documentFormatForFile(file: {
  name?: string | null;
  mime?: string | null;
}): DocumentFormatSpec | null {
  return documentFormatByMime(file.mime) ?? documentFormatByExt(fileExtension(file.name ?? ''));
}

/** Типы джобов движка (обработчики — в DocsModule, регистрация как у любого потребителя core/jobs) */
export const DOCS_JOB_TYPES = {
  /** Нарезать веху: снимок черновика в отдельный FileObject + ретеншн в хвосте */
  milestone: 'docs.milestone',
  /** Ленивый PDF-отпечаток (FileVariant kind='pdf') — под ЭЦП/печать */
  rendition: 'docs.rendition',
  /** Ленивое извлечение текста (FileVariant kind='text') — слот RAG */
  text: 'docs.text',
} as const;

/**
 * СВОЯ очередь джобов. Конвертация и снимки — тяжёлые и внешние (звонок в редактор,
 * перегон байт), а cap это свойство ОЧЕРЕДИ (минимум по её типам): в 'default' они
 * подпирали бы латентно-чувствительные типы вроде уведомлений.
 */
export const DOCS_QUEUE = 'docs';

export const DOCS_LIMITS = {
  /**
   * TTL access_token WOPI, часов. Правка большого документа идёт часами; клиент молча
   * перепощивает форму со свежим токеном за tokenRefreshLeadMin до конца (риск 6).
   */
  tokenTtlHours: 10,
  tokenRefreshLeadMin: 20,
  /** Срок WOPI-блокировки; RefreshLock двигает его (COOL шлёт refresh каждые ~5 мин) */
  lockTtlMin: 30,
  /**
   * X-COOL-WOPI-IsExitSave («сохранение при выходе») — подсказка, а не гарантия: срезаем
   * срок блокировки до этого, чтобы жнец добил сессию быстрее полного lockTtlMin.
   */
  exitSaveGraceMin: 5,
  /**
   * История версий живёт по БЮДЖЕТУ МЕСТА, а не по числу копий: снимок это ПОЛНАЯ копия
   * файла (офисный формат — zip, дельта между двумя версиями почти всегда равна всему
   * файлу, а настоящие дельты требуют лезть внутрь формата — чего движок не делает
   * принципиально). Одно правило вместо двух:
   *   договор на 200 КБ  → 10 версий (история бесплатна, терять её незачем);
   *   смета на 20 МБ     → 10 версий (укладывается в бюджет);
   *   презентация 200 МБ → 2 версии (иначе история съела бы 2 ГБ квоты владельца).
   * Подписанные (signed) не удаляются никогда и в лимит числа не считаются.
   */
  historyBudgetBytes: 200 * 1024 * 1024,
  /** Меньше этого не оставляем никогда — «предыдущая версия» должна быть всегда */
  minVersions: 2,
  /** Больше этого не храним, даже если файл крошечный */
  keepVersions: 10,
  /**
   * Потолки на ОТКРЫТИЕ в редакторе (скачивание не ограничено никогда). Редактору нужно
   * ~50 МБ памяти на правящего, и большой файл не «медленно откроется», а положит сеанс
   * соседям либо покажет человеку белый прямоугольник при полностью зелёном сервере.
   *   ≤ soft   — открываем молча;
   *   soft…hard — открываем, но честно предупреждаем;
   *   > hard   — отказываем и предлагаем скачать.
   */
  openSoftLimitBytes: 40 * 1024 * 1024,
  openHardLimitBytes: 70 * 1024 * 1024,
  /** Не чаще одной плашки «правил документ» в чат на пару «человек + документ» */
  chatEditNoticeCooldownMin: 60,
  /** Кэш ответа /hosting/discovery в Redis, сек */
  discoveryCacheSec: 3600,
  /** Таймаут исходящего вызова к редактору (discovery), мс */
  editorRequestTimeoutMs: 30_000,
  /** Таймаут конвертации /cool/convert-to (PDF-отпечаток, извлечение текста), мс */
  convertTimeoutMs: 120_000,
  maxTitleLength: 200,
  /** Страница списка версий документа */
  versionsPageSize: 50,
  /** Джоб вехи: попыток до dead-letter */
  milestoneMaxAttempts: 5,
  /** …база экспоненциального бэкоффа, мс */
  milestoneBackoffBaseMs: 30_000,
  /**
   * …аренда, мс. Обязана перекрывать ВЕСЬ бюджет обработчика (скачивание черновика +
   * инжест снимка + ретеншн): аренда меньше реального бюджета = переклейм reaper'ом во
   * время работы, то есть вторая параллельная нарезка той же вехи.
   */
  milestoneLeaseMs: 5 * 60 * 1000,
  /** Конкурентность очереди 'docs' на инстанс */
  queueConcurrency: 2,
} as const;
