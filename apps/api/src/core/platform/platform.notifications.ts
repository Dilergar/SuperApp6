import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NotificationRefRegistry } from '../notifications/notifications.registry';
import { NotificationsService } from '../notifications/notifications.service';
import { PlatformAccessService } from './platform-access.service';
import { PLATFORM_COMMAND_REF_TYPE } from './platform.constants';

type Tx = Prisma.TransactionClient;

export type PlatformSecurityEvent =
  | 'staffAdded'
  | 'staffSuspended'
  | 'roleGranted'
  | 'roleRevoked'
  | 'policyChanged'
  | 'piiRevealBurst'
  | 'deniedBurst'
  | 'stepUpBurst'
  | 'soloDualControl'
  | 'bootstrap'
  // Журнал инцидентов ПДн (core/consents): открыт инцидент · до срока уведомления органа 4 часа
  | 'pdIncidentOpened'
  | 'pdIncidentDeadline'
  // Детекции журнала безопасности (core/audit): CRITICAL-тревоги уходят владельцам сразу
  | 'passwordSpray'
  | 'bruteforceIp'
  | 'credentialStuffing'
  | 'massExport'
  | 'digestMismatch'
  | 'digestGap'
  | 'auditDegraded'
  | 'idorProbing'
  | 'malwareBurst';

/**
 * Уведомления кабинета: security-alert всем владельцам (critical, in-app + SMS по opt-in),
 * заявки four-eyes — держателям права одобрить и автору. Ref `platform_command` ведёт
 * в «Заявки» кабинета (у продукта такой страницы нет — deep link только для кабинета).
 */
@Injectable()
export class PlatformNotifier implements OnModuleInit {
  private readonly logger = new Logger(PlatformNotifier.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly refs: NotificationRefRegistry,
    private readonly access: PlatformAccessService,
  ) {}

  onModuleInit(): void {
    this.refs.register(PLATFORM_COMMAND_REF_TYPE, {
      canViewMany: async (userIds) => {
        // Заявку видят сотрудники платформы (адресаты уже отобраны продюсером)
        const staff = new Set(await this.access.holdersOf('platform.audit.read'));
        return userIds.filter((id) => staff.has(id));
      },
      href: (ref) => `/platform/requests?id=${ref.id}`,
    });
  }

  /** Критичное событие — всем активным владельцам платформы; автор события тоже получает его (`includeActor`). */
  async securityAlert(tx: Tx | null, actorId: string | null, event: PlatformSecurityEvent, details: string): Promise<void> {
    try {
      const owners = await this.access.ownerIds();
      if (!owners.length) return;
      await this.notifications.send(tx, {
        type: 'platform.security.alert',
        to: owners.map((userId) => ({ userId })),
        payload: { eventLabelKey: `platform.securityEvents.${event}`, details },
        actorId,
        includeActor: true,
        reason: 'system',
      });
    } catch (err) {
      this.logger.warn(`security alert failed: ${(err as Error).message}`);
      if (tx) throw err;
    }
  }

  async requestPending(tx: Tx | null, requestId: string, approverIds: string[], commandLabelKey: string, reason: string | null, actorId: string): Promise<void> {
    if (!approverIds.length) return;
    await this.notifications.send(tx, {
      type: 'platform.request.pending',
      to: approverIds.map((userId) => ({ userId })),
      payload: { commandLabelKey, reason: reason ?? '' },
      ref: { type: PLATFORM_COMMAND_REF_TYPE, id: requestId },
      actorId,
      reason: 'requested',
    });
  }

  async requestResolved(tx: Tx | null, requestId: string, authorId: string, commandLabelKey: string, outcome: 'approved' | 'rejected' | 'failed', comment: string | null, decidedBy: string | null): Promise<void> {
    await this.notifications.send(tx, {
      type: 'platform.request.resolved',
      to: [{ userId: authorId }],
      payload: { commandLabelKey, outcomeLabelKey: `platform.requestOutcome.${outcome}`, comment: comment ?? '' },
      ref: { type: PLATFORM_COMMAND_REF_TYPE, id: requestId },
      actorId: decidedBy,
      includeActor: true,
      reason: 'owner',
    });
  }
}
