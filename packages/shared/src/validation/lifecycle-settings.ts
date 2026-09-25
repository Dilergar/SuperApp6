import { z } from 'zod';
import { LIFECYCLE_FOREVER, LIFECYCLE_TENANT_CLASSES, type LifecycleDuration, type LifecycleTenantClass } from '../lifecycle/types';
import { LIFECYCLE_CHAT_TIMER_PRESETS } from '../lifecycle/registry';
import type { EntitlementUnlockDto } from '../types/entitlements';

// ============================================================
// Сроки хранения организации и таймер чата (core/lifecycle, Э5)
// ============================================================
// Организация выбирает срок для КЛАССА данных (не для таблицы): «сколько хранить сообщения
// чатов организации», «сколько хранить хронику записей», «сколько хранить журнал доставок
// вебхуков». Коридор — [пол закона; min(потолок политики, потолок тарифа)]. Удлинение
// действует сразу; сокращение — через 30 дней (уведомление всем членам, окно экспорта:
// ретроактивное сокращение без предупреждения — скандал Slack 2024).

/** Группа карточки на странице «Данные и сроки хранения» (порядок = порядок карточек). */
export const LIFECYCLE_TENANT_CLASS_GROUPS: Readonly<Record<LifecycleTenantClass, 'communication' | 'records' | 'integrations'>> = {
  user_content_shared: 'communication',
  tenant_record: 'records',
  operational: 'integrations',
};

export function isLifecycleTenantClass(value: unknown): value is LifecycleTenantClass {
  return typeof value === 'string' && (LIFECYCLE_TENANT_CLASSES as readonly string[]).includes(value);
}

/** Потолок срока класса у тарифа — ключ `core/entitlements` (`limit`: null = без потолка). */
export function lifecycleCeilingKeyOf(dataClass: LifecycleTenantClass): `lifecycle.retention.${LifecycleTenantClass}.ceilingDays` {
  return `lifecycle.retention.${dataClass}.ceilingDays`;
}

/** Самый длинный конечный срок (100 лет): длиннее — только «вечно». */
export const LIFECYCLE_MAX_FINITE_DAYS = 36_500;

/** Срок на проводе: сутки или `'forever'`. Строка-число — не срок (pg_partman #811). */
export const lifecycleDurationSchema = z.union([z.literal(LIFECYCLE_FOREVER), z.number().int().min(1).max(LIFECYCLE_MAX_FINITE_DAYS)]);

export const lifecycleSettingUpdateSchema = z
  .object({
    dataClass: z.enum(LIFECYCLE_TENANT_CLASSES),
    days: lifecycleDurationSchema,
  })
  .strict();
export type LifecycleSettingUpdateInput = z.infer<typeof lifecycleSettingUpdateSchema>;

/** Предпросмотр последствий — тот же вход, что у сохранения. */
export const lifecycleSettingPreviewSchema = lifecycleSettingUpdateSchema;
export type LifecycleSettingPreviewInput = LifecycleSettingUpdateInput;

export const lifecycleSettingClassParamSchema = z.object({ dataClass: z.enum(LIFECYCLE_TENANT_CLASSES) }).strict();

/** Одна карточка класса на странице организации. */
export interface LifecycleSettingsClassDto {
  dataClass: LifecycleTenantClass;
  group: (typeof LIFECYCLE_TENANT_CLASS_GROUPS)[LifecycleTenantClass];
  /** Политики класса, которые настраиваются (подписи — `lifecycle.policies.<id>`) */
  policies: string[];
  /** Действующий срок сейчас (выбор организации либо умолчание реестра) */
  current: LifecycleDuration;
  /** Умолчание реестра (организация ничего не выбирала) */
  defaultDays: LifecycleDuration;
  /** Выбор организации записан */
  custom: boolean;
  /** Отложенное сокращение: новый срок и момент вступления */
  pending: { days: LifecycleDuration; effectiveAt: string } | null;
  /** Коридор выбора: пол закона и потолок (политики и тарифа) */
  min: number;
  max: LifecycleDuration;
  /** Потолок политики без тарифа: пресеты выше него не показываются, между ним и `max` — под замком тарифа */
  policyMax: LifecycleDuration;
  /** Потолок тарифа (null — тариф срок не ограничивает) */
  planCeiling: LifecycleDuration | null;
  /** Куда идти за более длинным сроком (пресеты выше потолка — под замком) */
  unlock: EntitlementUnlockDto | null;
  /** Действующий срок выше потолка тарифа (тариф сменился): действует, пока организация не сменит сама */
  aboveCeiling: boolean;
  /** Кто менял последним (карточку веб берёт из ростера организации) */
  changedById: string | null;
  changedAt: string | null;
}

/** Класс «по закону»: срок не выбирается (кадры, деньги, подписи, журнал безопасности). */
export interface LifecycleLawClassDto {
  dataClass: string;
  /** Политики класса (подписи — `lifecycle.policies.<id>`) */
  policies: string[];
  /** Норма (ключ `lifecycle.citations.<code>`) */
  citation: string | null;
  /** Срок по закону (пол) */
  floorDays: LifecycleDuration | null;
}

export interface LifecycleSettingsDto {
  classes: LifecycleSettingsClassDto[];
  law: LifecycleLawClassDto[];
  /** Пресеты срока (Slack/WhatsApp): «Вечно · 1 год · 90 · 30 · 7 · 1 день» */
  presets: LifecycleDuration[];
  shorteningDelayDays: number;
}

/** Последствия выбранного срока ДО сохранения (сервер считает, UI показывает). */
export interface LifecycleSettingPreviewDto {
  dataClass: LifecycleTenantClass;
  days: LifecycleDuration;
  /** Сокращение (вступит через `shorteningDelayDays`) или удлинение (сразу) */
  shortened: boolean;
  /** С какого момента начнётся удаление (null — ничего не удаляется) */
  effectiveAt: string | null;
  /** Строк старше нового срока по политикам класса (оценка с потолком `capped`) */
  counts: Array<{ policyId: string; rows: number; capped: boolean }>;
  /** Ничего не изменится (тот же срок) */
  unchanged: boolean;
}

/** Сводка страницы «Данные» организации: четыре плитки. */
export interface LifecycleWorkspaceSummaryDto {
  /** Занято места и квота (байты; квота null — без ограничения) */
  storage: { usedBytes: number; limitBytes: number | null };
  /** Записей по классам (счёт с потолком: `capped` — «больше N») */
  counts: Array<{ dataClass: LifecycleTenantClass; rows: number; capped: boolean }>;
  /**
   * Ближайшее автоудаление: класс, дата и почему (`pending` — вступает отложенное сокращение,
   * `nightly` — ночной прогон удалит строки старше срока). null — удалять нечего.
   */
  nextDeletion: { dataClass: LifecycleTenantClass; at: string; reason: 'pending' | 'nightly' } | null;
  /** Действующих заморозок организации */
  activeHolds: number;
}

// ------------------------------------------------------------
// Таймер автоудаления сообщений в чате
// ------------------------------------------------------------

/** Таймер: 1 · 7 · 30 дней или null («выкл»). */
export const lifecycleChatTimerSchema = z
  .object({
    days: z
      .number()
      .int()
      .refine((d) => LIFECYCLE_CHAT_TIMER_PRESETS.includes(d), { message: 'timer preset' })
      .nullable(),
  })
  .strict();
export type LifecycleChatTimerInput = z.infer<typeof lifecycleChatTimerSchema>;

/** Сроки чата глазами участника: таймер, политика организации и действующий срок. */
export interface ChatRetentionDto {
  /** Таймер чата (null — выключен) */
  timerDays: number | null;
  /** Срок сообщений, заданный организацией (чат организации; null — «вечно» или личный чат) */
  workspaceDays: number | null;
  /** Действующий срок: min(таймер, срок организации); null — хранится вечно */
  effectiveDays: number | null;
  /** Какие пресеты таймера доступны (длиннее срока организации — нет) */
  allowedPresets: number[];
  /** Может ли зритель менять таймер (личный чат — любой участник, группа — владелец/админ) */
  canChange: boolean;
}
