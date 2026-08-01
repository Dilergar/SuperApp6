// ============================================
// core/share-links — типы DTO
// ============================================

import type { FileKind } from './file';
import type { ShareLinkStatus } from '../constants/share-links';

/** Ссылка глазами того, кто ею управляет. Токен отдельным полем НЕ отдаётся — только готовый `url`. */
export interface ShareLinkDto {
  id: string;
  refType: string;
  refId: string;
  /** `${WEB_URL}/s/<токен>` — копируется одной кнопкой */
  url: string;
  label: string | null;
  status: ShareLinkStatus;
  /** Сам пароль и его хэш наружу не уходят никогда */
  hasPassword: boolean;
  expiresAt: string | null;
  maxOpens: number | null;
  openCount: number;
  lastOpenedAt: string | null;
  createdById: string;
  createdAt: string;
  revokedAt: string | null;
  revokedById: string | null;
}

/**
 * Ссылки объекта. Список обрезан потолком страницы: действующих не бывает много, а
 * отозванные не удаляются никогда — это история раздачи наружу, и она копится.
 */
export interface ShareLinksPage {
  items: ShareLinkDto[];
  /** Сколько всего ссылок у объекта, включая недействующие */
  total: number;
}

/** Строка журнала визитов. `id` — BigInt в базе, наружу всегда строка (паттерн хроники). */
export interface ShareLinkVisitDto {
  id: string;
  openedAt: string;
  ip: string | null;
  userAgent: string | null;
}

export interface ShareLinkVisitsPage {
  items: ShareLinkVisitDto[];
  nextCursor: string | null;
}

/**
 * Первый шаг гостя: состояние ссылки БЕЗ её содержимого. Запароленная ссылка не
 * должна раскрывать даже название объекта до ввода пароля, поэтому резолвер
 * потребителя здесь не зовётся, а счётчик открытий не двигается.
 */
export interface ShareGuestPeekDto {
  state: 'ready' | 'password_required';
}

/** Второй шаг: открытие засчитано, выдан пропуск и содержимое. */
export interface ShareGuestSessionDto {
  sessionToken: string;
  sessionExpiresAt: string;
  /** Срок самой ссылки (null — бессрочная): страница показывает «доступно до …» */
  linkExpiresAt: string | null;
  refType: string;
  /** Содержимое, специфичное для refType: веб выбирает отрисовщик по refType */
  view: unknown;
}

// ============================================
// Гостевые вьюхи потребителей v1
// ============================================

/**
 * Файл глазами гостя. Ссылки подписаны сервером и живут ~10 минут — страница
 * добирает свежие через `/view`, когда `urlExpiresAt` прошёл.
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
  url: string | null;
  thumbUrl: string | null;
  posterUrl: string | null;
  urlExpiresAt: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  waveform: number[] | null;
  thumbhash: string | null;
}

/** Строка списка в гостевой папке. Внутренние поля узла (владелец, звёзды, системный ключ) сюда не попадают. */
export interface ShareDriveNodeDto {
  id: string;
  kind: 'folder' | 'file';
  name: string;
  /** Размер файла или объём папки; null у папки — «ещё не посчитан» */
  size: number | null;
  updatedAt: string;
  file: ShareGuestFile | null;
}

/** Что открылось по ссылке Диска: папка (дальше — листинг) или одиночный файл */
export type ShareDriveGuestView =
  | { kind: 'folder'; rootId: string; name: string }
  | { kind: 'file'; rootId: string; name: string; file: ShareGuestFile };

export interface ShareDriveNodesPage {
  items: ShareDriveNodeDto[];
  nextCursor: string | null;
}

/**
 * Документ глазами гостя — ТОЛЬКО PDF-отпечаток текущего содержимого (решение
 * продукта): гость читает и печатает, но не получает исходник и не входит в
 * редактор. Тот же отпечаток позже подписывает ЭДО.
 *
 * `preparing` — отпечаток заказан и считается (страница поллит), `unavailable` —
 * редактор документов не подключён в этом окружении.
 */
export interface ShareDocGuestView {
  kind: 'document';
  title: string;
  ext: string;
  state: 'ready' | 'preparing' | 'unavailable';
  pdf: { url: string; expiresAt: string } | null;
  updatedAt: string;
}
