import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  NOTIFICATION_PERSONAL_CONTEXT,
  NOTIFICATION_PREF_CHANNELS,
  NOTIFICATION_REGISTRY,
  defaultChannelsOf,
  notificationDef,
  notificationServicesForContext,
  notificationTypesForContext,
  type CopyNotificationPreferencesInput,
  type NotificationChannel,
  type NotificationChannelCellDto,
  type NotificationPolicyMode,
  type NotificationPrefChannel,
  type NotificationPreferencesDto,
  type NotificationServiceKey,
  type NotificationServicePrefDto,
  type NotificationType,
  type NotificationTypeDef,
  type NotificationTypePrefDto,
  type PutNotificationPreferencesInput,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, forbidden } from '../../shared/errors/api-error';
import { NotificationChannelRegistry } from './notifications.registry';
import { VerifySmsService } from '../verify/verify.sms';

/** Разреженные переопределения одного человека в одном контексте: `kind:key:channel` → enabled */
export type PrefMap = Map<string, boolean>;
/** Политика организации: `kind:key:channel` → mode */
export type PolicyMap = Map<string, NotificationPolicyMode>;

export const prefKey = (kind: 'service' | 'type', key: string, channel: string) => `${kind}:${key}:${channel}`;

export interface ChannelDecision {
  enabled: boolean;
  override: boolean | null;
  locked: boolean;
  /** Почему выключен (для журнала доставки) */
  reason: 'pref_off' | 'policy' | null;
}

/**
 * Прецедент (Novu «частное побеждает» + Salesforce/Courier замки):
 * critical → всегда; замок политики (тип > сервис) → всегда; личное переопределение
 * (тип > сервис) → как сказано; дефолт политики (тип > сервис) → как сказано;
 * иначе — дефолт реестра по приоритету.
 */
export function decideChannel(
  def: NotificationTypeDef,
  type: string,
  channel: NotificationChannel,
  prefs: PrefMap,
  policy: PolicyMap,
): ChannelDecision {
  if (def.priority === 'critical' && (channel === 'inapp' || channel === 'push')) {
    return { enabled: true, override: null, locked: true, reason: null };
  }
  const policyMode = policy.get(prefKey('type', type, channel)) ?? policy.get(prefKey('service', def.service, channel));
  if (policyMode === 'locked_on') return { enabled: true, override: null, locked: true, reason: null };
  const override = prefs.get(prefKey('type', type, channel)) ?? prefs.get(prefKey('service', def.service, channel));
  if (override !== undefined) return { enabled: override, override, locked: false, reason: override ? null : 'pref_off' };
  if (policyMode === 'default_on') return { enabled: true, override: null, locked: false, reason: null };
  if (policyMode === 'default_off') return { enabled: false, override: null, locked: false, reason: 'policy' };
  const enabled = defaultChannelsOf(def)[channel];
  return { enabled, override: null, locked: false, reason: enabled ? null : 'pref_off' };
}

/** SMS: только critical + smsEligible + явный opt-in человека на тип в контексте. */
export function smsOptedIn(def: NotificationTypeDef, type: string, prefs: PrefMap): boolean {
  if (def.priority !== 'critical' || !def.smsEligible) return false;
  return prefs.get(prefKey('type', type, 'sms')) === true;
}

@Injectable()
export class NotificationsPreferencesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly channels: NotificationChannelRegistry,
    private readonly sms: VerifySmsService,
  ) {}

  // ---------- батч-загрузка для фанаута ----------

  /** Переопределения адресатов по типу и его сервису в двух контекстах (личном и организации события). */
  async loadPrefs(userIds: string[], contexts: string[], type: string, service: string): Promise<Map<string, PrefMap>> {
    const out = new Map<string, PrefMap>();
    if (!userIds.length) return out;
    const rows = await this.db.notificationPreference.findMany({
      where: { userId: { in: userIds }, context: { in: contexts }, subjectKey: { in: [type, service] } },
      select: { userId: true, context: true, subjectKind: true, subjectKey: true, channel: true, enabled: true },
    });
    for (const r of rows) {
      const k = `${r.userId}|${r.context}`;
      let m = out.get(k);
      if (!m) {
        m = new Map();
        out.set(k, m);
      }
      m.set(prefKey(r.subjectKind as 'service' | 'type', r.subjectKey, r.channel), r.enabled);
    }
    return out;
  }

  async loadPolicy(workspaceId: string | null, type: string, service: string): Promise<PolicyMap> {
    const out: PolicyMap = new Map();
    if (!workspaceId) return out;
    const rows = await this.db.workspaceNotificationPolicy.findMany({
      where: { workspaceId, subjectKey: { in: [type, service] } },
      select: { subjectKind: true, subjectKey: true, channel: true, mode: true },
    });
    for (const r of rows) out.set(prefKey(r.subjectKind as 'service' | 'type', r.subjectKey, r.channel), r.mode as NotificationPolicyMode);
    return out;
  }

  // ---------- витрина настроек ----------

  /** Матрица «сервис × канал», раскрываемая до типов, с замками политики и SMS-opt-in. */
  async getPreferences(userId: string, context: string): Promise<NotificationPreferencesDto> {
    await this.assertContext(userId, context);
    const workspaceId = context === NOTIFICATION_PERSONAL_CONTEXT ? null : context;
    const [prefRows, policyRows] = await Promise.all([
      this.db.notificationPreference.findMany({
        where: { userId, context },
        select: { subjectKind: true, subjectKey: true, channel: true, enabled: true },
      }),
      workspaceId
        ? this.db.workspaceNotificationPolicy.findMany({
            where: { workspaceId },
            select: { subjectKind: true, subjectKey: true, channel: true, mode: true },
          })
        : Promise.resolve([]),
    ]);
    const prefs: PrefMap = new Map(prefRows.map((r) => [prefKey(r.subjectKind as 'service' | 'type', r.subjectKey, r.channel), r.enabled]));
    const policy: PolicyMap = new Map(
      policyRows.map((r) => [prefKey(r.subjectKind as 'service' | 'type', r.subjectKey, r.channel), r.mode as NotificationPolicyMode]),
    );

    const services: NotificationServicePrefDto[] = [];
    const critical: NotificationPreferencesDto['critical'] = [];
    for (const service of notificationServicesForContext(context)) {
      const types = notificationTypesForContext(service, context);
      const typeDtos: NotificationTypePrefDto[] = [];
      for (const type of types) {
        const def = NOTIFICATION_REGISTRY[type];
        if (def.priority === 'critical') {
          critical.push({
            type,
            service,
            icon: def.icon,
            smsEligible: !!def.smsEligible,
            smsOptIn: smsOptedIn(def, type, prefs),
          });
          continue;
        }
        typeDtos.push({
          type,
          priority: def.priority,
          icon: def.icon,
          channels: this.cells(def, type, prefs, policy),
          smsEligible: false,
          smsOptIn: false,
        });
      }
      if (typeDtos.length === 0) continue;
      services.push({ service, channels: this.serviceCells(service, typeDtos, prefs, policy), types: typeDtos });
    }
    return { context, services, critical, smsLive: this.sms.driver.live };
  }

  private cells(def: NotificationTypeDef, type: string, prefs: PrefMap, policy: PolicyMap): Record<NotificationPrefChannel, NotificationChannelCellDto> {
    const out = {} as Record<NotificationPrefChannel, NotificationChannelCellDto>;
    for (const ch of NOTIFICATION_PREF_CHANNELS) {
      const d = decideChannel(def, type, ch, prefs, policy);
      out[ch] = { enabled: d.enabled, override: prefs.get(prefKey('type', type, ch)) ?? null, locked: d.locked };
    }
    return out;
  }

  /** Ячейка сервиса: включён, если включён хоть один тип; заперт, если заперты все; override — переопределение сервиса. */
  private serviceCells(
    service: NotificationServiceKey,
    types: NotificationTypePrefDto[],
    prefs: PrefMap,
    policy: PolicyMap,
  ): Record<NotificationPrefChannel, NotificationChannelCellDto> {
    const out = {} as Record<NotificationPrefChannel, NotificationChannelCellDto>;
    for (const ch of NOTIFICATION_PREF_CHANNELS) {
      const locked = policy.get(prefKey('service', service, ch)) === 'locked_on' || types.every((t) => t.channels[ch].locked);
      out[ch] = {
        enabled: types.some((t) => t.channels[ch].enabled),
        override: prefs.get(prefKey('service', service, ch)) ?? null,
        locked,
      };
    }
    return out;
  }

  /** Разреженная запись: `enabled: null` снимает переопределение. Замок и critical — отказ. */
  async putPreferences(userId: string, input: PutNotificationPreferencesInput): Promise<NotificationPreferencesDto> {
    await this.assertContext(userId, input.context);
    const workspaceId = input.context === NOTIFICATION_PERSONAL_CONTEXT ? null : input.context;
    const policy = workspaceId
      ? new Map<string, NotificationPolicyMode>(
          (
            await this.db.workspaceNotificationPolicy.findMany({
              where: { workspaceId },
              select: { subjectKind: true, subjectKey: true, channel: true, mode: true },
            })
          ).map((r) => [prefKey(r.subjectKind as 'service' | 'type', r.subjectKey, r.channel), r.mode as NotificationPolicyMode]),
        )
      : new Map<string, NotificationPolicyMode>();

    for (const o of input.overrides) {
      if (o.subjectKind === 'type') {
        const def = notificationDef(o.subjectKey);
        if (!def) throw badRequest('notification.unknownType');
        if (o.channel === 'sms') {
          if (def.priority !== 'critical' || !def.smsEligible) throw badRequest('notification.sms.notEligible');
          continue;
        }
        if (def.priority === 'critical') throw badRequest('notification.critical.immutable');
        const locked =
          policy.get(prefKey('type', o.subjectKey, o.channel)) === 'locked_on' ||
          (policy.get(prefKey('type', o.subjectKey, o.channel)) === undefined && policy.get(prefKey('service', def.service, o.channel)) === 'locked_on');
        if (locked && o.enabled === false) throw forbidden('notification.policy.forbidden');
      } else {
        if (o.channel === 'sms') throw badRequest('notification.sms.notEligible');
        // Выключить сервис целиком, когда один из его типов заперт: личное сильнее дефолта,
        // но не замка — отказ честнее молчаливого «часть останется».
        if (o.enabled === false && policy.get(prefKey('service', o.subjectKey, o.channel)) === 'locked_on') {
          throw forbidden('notification.policy.forbidden');
        }
        if (o.enabled === false) {
          for (const [k, mode] of policy) {
            if (mode === 'locked_on' && k.startsWith('type:') && k.endsWith(`:${o.channel}`)) {
              const type = k.slice('type:'.length, -(`:${o.channel}`.length));
              if (notificationDef(type)?.service === o.subjectKey) throw forbidden('notification.policy.forbidden');
            }
          }
        }
      }
    }

    await this.db.$transaction(async (tx) => {
      for (const o of input.overrides) {
        const where = {
          userId_context_subjectKind_subjectKey_channel: {
            userId,
            context: input.context,
            subjectKind: o.subjectKind,
            subjectKey: o.subjectKey,
            channel: o.channel,
          },
        };
        if (o.enabled === null) {
          await tx.notificationPreference.deleteMany({
            where: { userId, context: input.context, subjectKind: o.subjectKind, subjectKey: o.subjectKey, channel: o.channel },
          });
        } else {
          await tx.notificationPreference.upsert({
            where,
            update: { enabled: o.enabled },
            create: {
              userId,
              context: input.context,
              subjectKind: o.subjectKind,
              subjectKey: o.subjectKey,
              channel: o.channel,
              enabled: o.enabled,
            },
          });
        }
      }
    });
    return this.getPreferences(userId, input.context);
  }

  /** «Применить ко всем моим организациям» — КОПИРОВАНИЕ набора (не наследование). */
  async copyToWorkspaces(userId: string, input: CopyNotificationPreferencesInput): Promise<{ copiedTo: string[] }> {
    await this.assertContext(userId, input.fromContext);
    const source = await this.db.notificationPreference.findMany({
      where: { userId, context: input.fromContext },
      select: { subjectKind: true, subjectKey: true, channel: true, enabled: true },
    });
    const roles = await this.db.userRole.findMany({
      where: { userId, context: 'workspace', isActive: true, tenantId: { not: null } },
      select: { tenantId: true },
    });
    const targets = [...new Set(roles.map((r) => r.tenantId!).filter((id) => id !== input.fromContext))];
    if (!targets.length) return { copiedTo: [] };
    // Копируем только то, что уместно в контексте организации; замки целевой организации
    // побеждают (запертый тип остаётся включённым — фанаут читает политику первой).
    const workspaceScoped = source.filter((r) => {
      if (r.subjectKind === 'type') {
        const def = notificationDef(r.subjectKey);
        return def && def.contexts !== 'personal';
      }
      return notificationServicesForContext('workspace-any').includes(r.subjectKey as NotificationServiceKey);
    });
    await this.db.$transaction(async (tx) => {
      for (const wsId of targets) {
        await tx.notificationPreference.deleteMany({ where: { userId, context: wsId } });
        if (workspaceScoped.length) {
          await tx.notificationPreference.createMany({
            data: workspaceScoped.map((r) => ({
              userId,
              context: wsId,
              subjectKind: r.subjectKind,
              subjectKey: r.subjectKey,
              channel: r.channel,
              enabled: r.enabled,
            })),
          });
        }
      }
    });
    return { copiedTo: targets };
  }

  /** Контекст-организация доступен только её члену (личный — всегда). */
  async assertContext(userId: string, context: string): Promise<void> {
    if (context === NOTIFICATION_PERSONAL_CONTEXT) return;
    const member = await this.db.userRole.count({ where: { userId, context: 'workspace', tenantId: context, isActive: true } });
    if (!member) throw forbidden('notification.context.notMember');
  }

  /** Живой ли push (для витрины устройств) */
  get pushLive(): boolean {
    return this.channels.pushLive;
  }

  static contextOf(workspaceId: string | null): string {
    return workspaceId ?? NOTIFICATION_PERSONAL_CONTEXT;
  }

  static isType(value: string): value is NotificationType {
    return !!notificationDef(value);
  }

  static prismaJson(v: unknown): Prisma.InputJsonValue {
    return v as Prisma.InputJsonValue;
  }
}
