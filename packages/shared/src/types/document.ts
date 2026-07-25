import type {
  DOCUMENT_ACCESS,
  DOCUMENT_EDITOR_KINDS,
  DOCUMENT_MODES,
  DOCUMENT_SESSION_STATUSES,
  DOCUMENT_STATUSES,
  DOCUMENT_VERSION_REASONS,
  DOCUMENT_VERSION_STATUSES,
} from '../constants/documents';
import type { FileOwnerType } from './file';

// ============================================
// Docs Engine (core/docs) — типы
// Документ ссылается на ЖИВОЙ файл (Document.fileId неизменен: редактор пишет в тот же
// FileObject), поэтому вложение в чате/задаче всегда отдаёт актуальное содержимое.
// ============================================

export type DocumentEditorKind = (typeof DOCUMENT_EDITOR_KINDS)[number];
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export type DocumentMode = (typeof DOCUMENT_MODES)[number];
export type DocumentAccess = (typeof DOCUMENT_ACCESS)[number];
export type DocumentVersionStatus = (typeof DOCUMENT_VERSION_STATUSES)[number];
export type DocumentVersionReason = (typeof DOCUMENT_VERSION_REASONS)[number];
export type DocumentSessionStatus = (typeof DOCUMENT_SESSION_STATUSES)[number];

/** GET /docs/status — веб прячет кнопки «Открыть/Редактировать», когда движок выключен */
export interface DocsStatusDto {
  /** Задан DOCS_EDITOR_URL и редактор отвечает discovery */
  enabled: boolean;
  /**
   * v1-инвариант: все документы обслуживает ОДИН узел редактора. Два узла на одном
   * документе = два брокера в памяти = потерянные правки; шардирование (адрес считается
   * по документу) заложено, но не включено.
   */
  singleNode: boolean;
}

export interface DocumentDto {
  id: string;
  /** Живой черновик в core/files — стабильный id вложения */
  fileId: string;
  title: string;
  ext: string;
  mime: string;
  editorKind: DocumentEditorKind;
  mode: DocumentMode;
  status: DocumentStatus;
  /** Что может ИМЕННО ЭТОТ зритель (resolveMode: место, откуда пришёл + гранты + mode) */
  access: DocumentAccess;
  ownerType: FileOwnerType;
  ownerId: string;
  createdById: string;
  lastVersionNo: number;
  lastSavedAt: string | null;
  lastEditorId: string | null;
  /** Документ сейчас открыт (живая сессия) — UI пишет «редактируется» */
  live: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * POST /docs/:id/open — всё, что нужно для запуска редактора. Токен уходит в iframe
 * form POST'ом, а не в URL: в URL он осел бы в истории браузера и в Referer.
 */
export interface DocumentOpenDto {
  documentId: string;
  /** action-URL WOPI-клиента с ?WOPISrc=… — адрес, видимый БРАУЗЕРУ (не контейнеру) */
  editorUrl: string;
  accessToken: string;
  /**
   * ВНИМАНИЕ: по протоколу WOPI это МЕТКА ВРЕМЕНИ (мс с 1970), а не длительность.
   * Классическая ошибка — положить сюда 3600.
   */
  accessTokenTtl: number;
  /** Режим, с которым открыли (в WOPI превращается в UserCanWrite) */
  mode: Exclude<DocumentAccess, 'none'>;
  /** Когда клиенту молча перепостить форму со свежим токеном (ISO) */
  refreshAt: string;
}

export interface DocumentVersionDto {
  id: string;
  versionNo: number;
  status: DocumentVersionStatus;
  reason: DocumentVersionReason;
  size: number | null;
  sha256: string | null;
  /** Подписанные версии ретеншн не удаляет никогда */
  signed: boolean;
  createdById: string | null;
  /** Кто правил в сессии, из которой нарезана веха */
  authorIds: string[];
  createdAt: string;
}
