import type { DRIVE_NODE_KINDS, DRIVE_ROLES, DRIVE_SORTS, DRIVE_SORT_DIRS, DRIVE_SPACE_KINDS } from '../constants/drive';
import type { FileKind, FileOwnerType, FileScanStatus, FileStatus } from './file';

// ============================================
// OmniDrive («Диск») — типы
// ============================================

export type DriveSpaceKind = (typeof DRIVE_SPACE_KINDS)[number];
export type DriveNodeKind = (typeof DRIVE_NODE_KINDS)[number];
export type DriveRole = (typeof DRIVE_ROLES)[number];
export type DriveSort = (typeof DRIVE_SORTS)[number];
export type DriveSortDir = (typeof DRIVE_SORT_DIRS)[number];

/** Что зритель может делать в пространстве/на узле: 'owner' сильнее любой роли гранта */
export type DriveAccess = DriveRole | 'owner';

export interface DriveSpaceDto {
  id: string;
  kind: DriveSpaceKind;
  ownerType: FileOwnerType;
  ownerId: string;
  rootId: string;
  /** Человеческое имя: «Мой диск» / название организации */
  title: string;
  /** Что может ИМЕННО этот зритель в корне пространства */
  access: DriveAccess;
}

/**
 * Файл узла — снимок метаданных движка плюс уже подписанные ссылки.
 * Ссылки приходят В ТЕЛЕ листинга (модель Slack/Discord): иначе каждая строка списка
 * стоила бы отдельный GET /files/:id/download, а страница на 100 файлов — 100 запросов.
 */
export interface DriveNodeFileDto {
  id: string;
  name: string;
  mime: string;
  kind: FileKind;
  size: number;
  status: FileStatus;
  scanStatus: FileScanStatus;
  /** Подписанная ссылка на миниатюру (картинки) или постер (видео); null — нечего показать */
  thumbUrl: string | null;
  /** ISO-время истечения подписи; null — вечная ссылка (публичный класс) */
  urlExpiresAt: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** Компактный предпросмотр (thumbhash), рисуется до загрузки картинки */
  thumbhash: string | null;
}

export interface DriveNodeDto {
  id: string;
  spaceId: string;
  kind: DriveNodeKind;
  parentId: string | null;
  name: string;
  createdById: string;
  depth: number;
  /** Системная папка («Файлы из переписки») — не удаляется и не переносится */
  systemKey: string | null;
  file: DriveNodeFileDto | null;
  /** Размер поддерева у папки; null — «считается» (сентинел пересчёта) */
  subtreeBytes: number | null;
  subtreeFiles: number | null;
  /** Время СЪЁМКИ (стенное, без пояса) — только у фото */
  takenAtLocal: string | null;
  starred: boolean;
  /**
   * Сколько действующих ГОСТЕВЫХ ссылок наружу висит на этом объекте (core/share-links).
   * Нужен в самом списке: «что из этого лежит за пределами платформы» — первый вопрос,
   * когда файл всплыл не там, и открывать модалку у каждой строки ради него нельзя.
   */
  shareLinks: number;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Хлебная крошка: путь от корня, без самого узла */
export interface DriveBreadcrumbDto {
  id: string;
  name: string;
  systemKey: string | null;
}

export interface DriveListPageDto {
  items: DriveNodeDto[];
  nextCursor: string | null;
}

/** GET /drive/nodes/:id — узел + путь + права зрителя */
export interface DriveNodeDetailDto {
  node: DriveNodeDto;
  breadcrumbs: DriveBreadcrumbDto[];
  space: DriveSpaceDto;
  access: DriveAccess;
  /** Сколько ЕЩЁ мест ссылается на этот файл (чат, задача) — предупреждение перед удалением */
  usedElsewhere: number;
}

/** Грант на узле: ровно один tuple в core/access */
export interface DriveShareDto {
  principalType: string;
  principalId: string;
  /** Имя человека / название Группы, отдела, должности, филиала — для показа */
  principalName: string | null;
  role: DriveRole;
  /** Узел, на котором висит грант (может быть предком открытого узла) */
  nodeId: string;
  nodeName: string;
  /** Грант достался по наследству от папки-предка, а не выдан на этом узле */
  inherited: boolean;
}

export interface DriveVersionDto {
  id: string;
  versionNo: number;
  fileId: string;
  size: number;
  sha256: string | null;
  createdById: string;
  createdAt: string;
}

/** Счётчики ленты «Фото» по месяцам — кормят скруббер (весь ответ — единицы КБ) */
export interface DrivePhotoBucketDto {
  /** `YYYY-MM` */
  month: string;
  count: number;
}

/**
 * Страница ленты «Фото» — КОЛОНОЧНЫЙ ответ: без соотношений сторон и предпросмотров
 * раскладку не посчитать до загрузки картинок, а объектная форма на 200 плиток
 * весила бы втрое больше при том же содержании.
 */
export interface DrivePhotoPageDto {
  id: string[];
  fileId: string[];
  name: string[];
  /** Соотношение сторон (ширина / высота), уже посчитанное — клиенту нечего делить */
  ratio: number[];
  thumbhash: (string | null)[];
  url: (string | null)[];
  takenAtLocal: string[];
  nextCursor: string | null;
  /** ISO-время истечения подписей страницы — клиент перезапрашивает её до этого момента */
  urlExpiresAt: string | null;
}

/** GET /drive — пространства зрителя + занятое место текущего */
export interface DriveOverviewDto {
  space: DriveSpaceDto;
  /** Пространства, куда зрителю дали доступ (гранты), кроме своего */
  sharedWithMe: DriveSpaceDto[];
  bytesUsed: number;
  limitBytes: number;
  filesCount: number;
  trashedCount: number;
}
