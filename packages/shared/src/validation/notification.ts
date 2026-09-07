import { z } from 'zod';
import { queryBoolean } from './query';
import {
  NOTIFICATION_DEVICE_PLATFORMS,
  NOTIFICATION_DEVICE_PROVIDERS,
  NOTIFICATION_POLICY_MODES,
  NOTIFICATION_SUBJECT_KINDS,
} from '../types/notification';
import {
  NOTIFICATION_LIMITS,
  NOTIFICATION_PREF_CHANNELS,
  NOTIFICATION_STATES,
  NOTIFICATION_TYPES,
  NOTIFICATION_SERVICE_KEYS,
} from '../notifications';

// ============================================================
// core/notifications — входы ручек (вход = z.infer, рукописных интерфейсов нет)
// ============================================================

/** `personal` либо id организации (uuid). */
export const notificationContextSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => v === 'personal' || z.string().uuid().safeParse(v).success, 'personal | workspace uuid');

export const listNotificationsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(200).optional(),
    context: notificationContextSchema.optional(),
    service: z.enum(NOTIFICATION_SERVICE_KEYS as [string, ...string[]]).optional(),
    state: z.enum(NOTIFICATION_STATES).optional(),
    mentions: queryBoolean.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

/** `POST /notifications/seen` — показанные id; пусто = все unseen. */
export const notificationIdsSchema = z
  .object({ ids: z.array(z.string().uuid()).max(500).optional() })
  .strict();
export type NotificationIdsInput = z.infer<typeof notificationIdsSchema>;

/** `POST /notifications/read` — id либо все непрочитанные (в контексте, если задан). */
export const markNotificationsReadSchema = z
  .object({
    ids: z.array(z.string().uuid()).max(500).optional(),
    all: z.boolean().optional(),
    context: notificationContextSchema.optional(),
  })
  .strict()
  .refine((v) => (v.ids && v.ids.length > 0) || v.all === true, 'ids or all: true');
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>;

export const snoozeNotificationSchema = z
  .object({ until: z.string().datetime({ offset: true }) })
  .strict();
export type SnoozeNotificationInput = z.infer<typeof snoozeNotificationSchema>;

export const notificationMuteSchema = z
  .object({ refType: z.string().min(1).max(64), refId: z.string().min(1).max(128) })
  .strict();
export type NotificationMuteInput = z.infer<typeof notificationMuteSchema>;

export const notificationSubjectKeySchema = z
  .string()
  .min(1)
  .max(96)
  .refine(
    (v) => (NOTIFICATION_TYPES as string[]).includes(v) || (NOTIFICATION_SERVICE_KEYS as string[]).includes(v),
    'registry type or service',
  );

/** Одно разреженное переопределение; `enabled: null` — снять переопределение (вернуть дефолт). */
export const notificationPreferenceOverrideSchema = z
  .object({
    subjectKind: z.enum(NOTIFICATION_SUBJECT_KINDS),
    subjectKey: notificationSubjectKeySchema,
    channel: z.enum([...NOTIFICATION_PREF_CHANNELS, 'sms'] as [string, ...string[]]),
    enabled: z.boolean().nullable(),
  })
  .strict();

export const putNotificationPreferencesSchema = z
  .object({
    context: notificationContextSchema,
    overrides: z.array(notificationPreferenceOverrideSchema).min(1).max(NOTIFICATION_LIMITS.maxPreferenceOverrides),
  })
  .strict();
export type PutNotificationPreferencesInput = z.infer<typeof putNotificationPreferencesSchema>;

export const preferencesContextQuerySchema = z
  .object({ context: notificationContextSchema.optional() })
  .strict();

/** «Применить ко всем моим организациям» — копирование набора из контекста-источника. */
export const copyNotificationPreferencesSchema = z
  .object({ fromContext: notificationContextSchema })
  .strict();
export type CopyNotificationPreferencesInput = z.infer<typeof copyNotificationPreferencesSchema>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

export const notificationQuietRuleSchema = z
  .object({
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    from: hhmm,
    to: hhmm,
  })
  .strict();

export const putNotificationQuietSchema = z
  .object({ schedule: z.array(notificationQuietRuleSchema).max(14).nullable() })
  .strict();
export type PutNotificationQuietInput = z.infer<typeof putNotificationQuietSchema>;

/** Разовая пауза: минуты (30/60/120) либо «до утра» (08:00 в поясе человека); `clear` снимает. */
export const pauseNotificationsSchema = z
  .object({
    minutes: z.number().int().min(1).max(24 * 60).optional(),
    untilMorning: z.boolean().optional(),
    clear: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.minutes !== undefined || v.untilMorning === true || v.clear === true, 'minutes | untilMorning | clear');
export type PauseNotificationsInput = z.infer<typeof pauseNotificationsSchema>;

export const registerNotificationDeviceSchema = z
  .object({
    platform: z.enum(NOTIFICATION_DEVICE_PLATFORMS),
    provider: z.enum(NOTIFICATION_DEVICE_PROVIDERS),
    /** Web: endpoint подписки; Expo/FCM: токен устройства */
    token: z.string().min(8).max(2048),
    /** Web: ключи подписки PushSubscription */
    subscription: z
      .object({
        endpoint: z.string().url(),
        expirationTime: z.number().nullable().optional(),
        keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }).strict(),
      })
      .strict()
      .optional(),
    userAgent: z.string().max(300).optional(),
  })
  .strict();
export type RegisterNotificationDeviceInput = z.infer<typeof registerNotificationDeviceSchema>;

export const removeNotificationDeviceSchema = z
  .object({
    id: z.string().uuid().optional(),
    provider: z.enum(NOTIFICATION_DEVICE_PROVIDERS).optional(),
    token: z.string().min(8).max(2048).optional(),
  })
  .strict()
  .refine((v) => !!v.id || (!!v.provider && !!v.token), 'id or provider+token');
export type RemoveNotificationDeviceInput = z.infer<typeof removeNotificationDeviceSchema>;

export const workspaceNotificationPolicyRuleSchema = z
  .object({
    subjectKind: z.enum(NOTIFICATION_SUBJECT_KINDS),
    subjectKey: notificationSubjectKeySchema,
    channel: z.enum(NOTIFICATION_PREF_CHANNELS),
    mode: z.enum(NOTIFICATION_POLICY_MODES),
  })
  .strict();

/** Полный набор правил организации (PUT заменяет целиком — явная кнопка «Сохранить»). */
export const putWorkspaceNotificationPolicySchema = z
  .object({ rules: z.array(workspaceNotificationPolicyRuleSchema).max(NOTIFICATION_LIMITS.maxPreferenceOverrides) })
  .strict();
export type PutWorkspaceNotificationPolicyInput = z.infer<typeof putWorkspaceNotificationPolicySchema>;

export const devDeliveriesQuerySchema = z
  .object({
    userId: z.string().uuid().optional(),
    eventId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/** [dev] `POST /notifications/dev/send` — полигон движка для сьюта (только development/test). */
export const devSendNotificationSchema = z
  .object({
    type: z.enum(NOTIFICATION_TYPES as [string, ...string[]]),
    to: z.array(z.string().uuid()).min(1).max(50),
    payload: z.record(z.unknown()).optional(),
    ref: z.object({ type: z.string().min(1).max(64), id: z.string().min(1).max(128) }).strict().optional(),
    actorId: z.string().uuid().optional(),
    workspaceId: z.string().uuid().optional(),
    reason: z.string().min(1).max(32).optional(),
    collapseKey: z.string().min(1).max(200).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    actionUrl: z.string().max(500).optional(),
    includeActor: z.boolean().optional(),
    budget: z.literal('workspace').optional(),
  })
  .strict();
export type DevSendNotificationInput = z.infer<typeof devSendNotificationSchema>;
