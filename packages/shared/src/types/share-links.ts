// ============================================
// core/share-links — типы DTO
// ============================================
// ЗДЕСЬ ТОЛЬКО КОНВЕРТ ДВИЖКА. Содержимое, которое видит гость, описывает
// ПОТРЕБИТЕЛЬ у себя: `ShareDriveGuestView` — в types/drive.ts, `ShareDocGuestView` —
// в types/document.ts, общая проекция файла `ShareGuestFile` — в types/file.ts.
// Движок по определению не знает своих потребителей (см. ShareLinksRegistry), и его
// «паспорт» не должен наполняться чужими анкетами по мере роста списка сервисов.

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
  /** Можно ли гостю скачивать оригиналы. Выключено — только просмотр (не защита от копирования) */
  allowDownload: boolean;
  /** Уведомлять владельца об открытиях (с суточным предохранителем) */
  notifyOnOpen: boolean;
  /** Гость обязан назвать имя и подтвердить номер SMS-кодом до показа содержимого */
  requireIdentity: boolean;
  /** Когда у ссылки в последний раз меняли адрес; null — адрес исходный */
  tokenRotatedAt: string | null;
  createdById: string;
  createdAt: string;
  revokedAt: string | null;
  revokedById: string | null;
}

/**
 * Строка раздела «Мои ссылки»: та же ссылка плюс подпись объекта, на который она выдана.
 * Подпись приходит из `describeRef` резолвера потребителя — движок сам не знает ни Диска,
 * ни документов. Объект мог исчезнуть (`ref: null`) — строку всё равно показываем: это
 * история раздачи, и отозвать такую ссылку человек тоже должен уметь.
 */
export interface ShareLinkMineDto extends ShareLinkDto {
  ref: { title: string; icon?: string } | null;
}

export interface ShareLinkMinePage {
  items: ShareLinkMineDto[];
  nextCursor: string | null;
}

/** Автор ссылки для PersonChip в организационном списке (человек в UI = карточка) */
export interface ShareLinkActorLite {
  id: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
}

/**
 * «Ссылки организации» (manager+): всё, что раздала наружу вся команда.
 *
 * Отличие от «Моих ссылок» — не только скоуп, но и `actors`: в личном списке автор
 * всегда один и известен, а здесь главный вопрос «кто это раздал», и на него надо
 * ответить карточкой человека, а не идентификатором.
 */
export interface ShareLinkOrgPage {
  items: ShareLinkMineDto[];
  nextCursor: string | null;
  /** createdById → лайт-профиль. Удалённые отсутствуют — клиент рисует «Бывший сотрудник». */
  actors: Record<string, ShareLinkActorLite>;
}

/** Сводка раздела «Мои ссылки» */
export interface ShareLinkStatsDto {
  activeLinks: number;
  /** Сколько объектов роздано наружу прямо сейчас */
  sharedObjects: number;
  opensInPeriod: number;
  periodDays: number;
  /** Открытий по дням за период, старые первыми — полоска над списком */
  daily: { date: string; opens: number }[];
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
  /** Кто открывал — если ссылка требовала подтверждение номера; у анонимных null */
  guestName: string | null;
  guestPhone: string | null;
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
  /** Гостю предстоит назвать имя и подтвердить номер SMS-кодом (после пароля, если он есть) */
  identityRequired: boolean;
}

/** Ответ на запрос SMS-кода гостем (зеркало VerifyStartResponse — таймер ресенда и маска) */
export interface ShareGuestIdentityStartDto {
  challengeId: string;
  resendInSec: number;
  ttlSec: number;
  phoneMasked: string;
}

/** Второй шаг: открытие засчитано, выдан пропуск и содержимое. */
export interface ShareGuestSessionDto {
  sessionToken: string;
  sessionExpiresAt: string;
  /** Срок самой ссылки (null — бессрочная): страница показывает «доступно до …» */
  linkExpiresAt: string | null;
  refType: string;
  /** Кем гость представился (ссылка требовала подтверждение номера); null у анонимных */
  guest: { name: string; phoneMasked: string } | null;
  /** Содержимое, специфичное для refType: веб выбирает отрисовщик по refType */
  view: unknown;
}

