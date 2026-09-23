import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AUDIT_LIMITS, PD_RECIPIENTS, isLocale, notificationDef, type NotificationType } from '@superapp/shared';
import { DEFAULT_LOCALE, resolveCountryValues } from '@superapp/i18n';
import { DatabaseService } from '../../shared/database/database.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { deviceFromFamily } from '../../shared/utils/user-agent';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { SmsOutboundService } from '../verify/sms-outbound.service';
import { AUDIT_JOBS, AUDIT_QUEUE } from './audit.constants';
import { AuditService } from './audit.service';

/**
 * Джобы движка журнала, не относящиеся к целостности и выгрузкам.
 *
 * `audit.sms_alert` — SMS о событии безопасности человеку, у которого НЕТ живого push-устройства
 * (решение грилла №9: in-app + push всегда, SMS — только когда push не дойдёт). Ставится В
 * ТРАНЗАКЦИИ события (outbox): SMS уходит только после коммита, сеть в транзакции не держится.
 * Текст — заголовок уведомления в языке человека, БЕЗ ссылок (фишинг прикидывается нашими
 * SMS); потолок — одна SMS в час на человека (`SmsOutboundService.sendAccountAlert`).
 * Отправка — передача номера оператору связи: событие учёта `pd.transfer`.
 */
@Injectable()
export class AuditJobs implements OnModuleInit {
  private readonly logger = new Logger(AuditJobs.name);

  constructor(
    private readonly registry: JobsRegistry,
    private readonly db: DatabaseService,
    private readonly i18n: I18nService,
    private readonly sms: SmsOutboundService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.registry.register(AUDIT_JOBS.smsAlert, (p) => this.smsAlert(p), { queue: AUDIT_QUEUE, maxAttempts: 3, queueConcurrency: 2 });
  }

  async smsAlert(payload: Record<string, unknown>): Promise<void> {
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    const type = typeof payload.notification === 'string' ? payload.notification : null;
    const eventId = typeof payload.eventId === 'string' && /^\d{1,19}$/.test(payload.eventId) ? payload.eventId : null;
    if (!userId || !type || !eventId || !notificationDef(type)) throw new JobDiscardError('audit.sms_alert: bad payload');

    const since = new Date(Date.now() - AUDIT_LIMITS.pushDeviceFreshDays * 86_400_000);
    const push = await this.db.notificationDevice.count({ where: { userId, disabledAt: null, lastSeenAt: { gt: since } } });
    if (push > 0) return; // push дойдёт — SMS не нужна

    const user = await this.db.user.findUnique({ where: { id: userId }, select: { phone: true, locale: true, kind: true, deletedAt: true } });
    if (!user || user.deletedAt || user.kind !== 'person' || !user.phone || user.phone.startsWith('deleted:')) return;
    const event = await this.db.securityEvent.findFirst({ where: { id: BigInt(eventId), subjectUserId: userId }, select: { details: true, country: true, uaFamily: true } });
    if (!event) return;

    const locale = isLocale(user.locale) ? user.locale : DEFAULT_LOCALE;
    const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details) ? (event.details as Record<string, unknown>) : {};
    const values: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(details)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') values[k] = v;
    values.device = deviceFromFamily(event.uaFamily).label ?? this.i18n.translateFor(locale, 'audit.unknownDevice');
    if (event.country) values.whereCountry = event.country;
    else values.where = this.i18n.translateFor(locale, 'audit.unknownPlace');
    const title = this.i18n.translateFor(locale, `notifications.${type as NotificationType}.title`, resolveCountryValues(this.i18n.format(locale), values));
    const sent = await this.sms.sendAccountAlert(userId, user.phone, `SuperApp6: ${title}`);
    if (!sent) return;
    const kazinfoteh = PD_RECIPIENTS.kazinfoteh;
    await this.audit.recordBestEffort({
      key: 'pd.transfer',
      subjectUserId: userId,
      actor: { kind: 'system' },
      details: { recipient: 'kazinfoteh', recipientCountry: kazinfoteh.country, basis: kazinfoteh.basis, fields: ['phone', 'notification_text'], purpose: 'notification_sms', crossBorder: kazinfoteh.crossBorder },
      ref: { type: 'security_event', id: eventId },
    });
    this.logger.log(`security SMS alert sent (${type})`);
  }
}
