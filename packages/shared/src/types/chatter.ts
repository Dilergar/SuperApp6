import type { ChatterCategory, ChatterTypeKey } from '../constants/chatter';
import type { CursorPage } from './common';

// ============================================
// core/chatter («Хроника записи») — типы
// Запись хроники полиморфна по refType+refId; id — BigInt в БД,
// на проводе ВСЕГДА string (JSON.stringify на BigInt бросает).
// ============================================

export type { ChatterCategory, ChatterTypeKey };

/**
 * Сырые значения изменения — чтобы зритель мог показать их СВОИМИ правилами.
 * Дата, записанная как «03.09.2026», навсегда останется этим текстом; ISO-строка
 * рядом с ней переформатируется под язык и регион того, кто читает.
 *
 * `kind: 'key'` — значение-СЛОВО продукта («Да», «Лизинг», «Менеджер»): в сыром
 * виде лежит КЛЮЧ каталога, и запись переводится задним числом вместе с ним.
 * Записанное словом, оно застыло бы в языке того, кто нажал кнопку.
 */
export interface ChatterChangeRaw {
  from: string | null;
  to: string | null;
  kind: 'text' | 'date' | 'datetime' | 'number' | 'key';
}

/** Одно изменение поля «было → стало» */
export interface ChatterChange {
  field: string;
  /**
   * СНАПШОТ подписи на момент записи («Срок», «Приоритет») — фолбэк для типов,
   * чьи подписи ещё не переехали в каталог `chatter.fields.<refType>.<field>`.
   */
  label: string;
  /** Снапшот display-строк — тот же фолбэк, когда `raw` нет (старые записи) */
  from: string | null;
  to: string | null;
  raw?: ChatterChangeRaw | null;
  /**
   * Значения, СОБРАННЫЕ сервером в языке запроса, — те самые, что стоят внутри
   * `text`. Без них клиент искал бы в готовом тексте снимок («No → Yes»), а там
   * уже перевод («Нет → Да»): чипы диффа переставали находиться ровно на тех
   * записях, где `raw` пересобрал значение (дата, число, слово-ключ).
   */
  display?: { from: string; to: string } | null;
}

/** Лайт-профиль актёра для PersonChip (батч-обогащение страницы) */
export interface ChatterActorLite {
  id: string;
  firstName: string;
  lastName: string | null;
  avatar: string | null;
  /** `bot` — актор-бот (core/keys): клиент рисует BotChip, не PersonChip */
  kind: 'person' | 'bot';
}

export interface ChatterEntryDto {
  /** BigInt id → string; он же курсор */
  id: string;
  refType: string;
  refId: string;
  workspaceId: string | null;
  /** null = система (крон/движок) */
  actorId: string | null;
  /** Снапшот имени — хроника переживает удаление аккаунта */
  actorName: string | null;
  /** ChatterTypeKey на практике; string на проводе — форвард-совместимость со старыми клиентами */
  typeKey: string;
  changes: ChatterChange[] | null;
  payload: Record<string, unknown> | null;
  /**
   * Плоский текст записи, уже собранный сервером в языке ЗАПРОСА.
   * Веб может нарисовать своё (чипы людей через `t.rich`), mobile и AI берут
   * готовую строку — контракт «и текст, и структура» из решения по i18n.
   */
  text: string;
  createdAt: string;
}

export interface ChatterPageDto extends CursorPage<ChatterEntryDto> {
  /**
   * actorId → лайт-профиль для PersonChip. Удалённые/анонимизированные
   * пользователи отсутствуют — клиент падает на снапшот actorName.
   */
  actors: Record<string, ChatterActorLite>;
}
