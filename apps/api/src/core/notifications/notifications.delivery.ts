import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { NOTIFICATION_LIMITS, SOURCE_LOCALE, isKzMobilePhone, maskPhone, notificationDef, type NotificationRef } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { I18nService } from '../../shared/i18n/i18n.service';
import { RedisService } from '../../shared/redis/redis.service';
import { isDevEnv } from '../../shared/config/env.validation';
import { isApiError } from '../../shared/errors/api-error';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { JobDiscardError, JobsRegistry } from '../jobs/jobs.registry';
import { JobsService } from '../jobs/jobs.service';
import { VerifySmsService } from '../verify/verify.sms';
import { ConsentsActionsService } from '../consents/consents.actions.service';
import { NOTIFICATION_JOBS, NOTIFICATION_QUEUE, NOTIFICATION_REDIS } from './notifications.constants';
import { NotificationChannelRegistry, type PushDevice, type PushMessage } from './notifications.registry';
import { NotificationsRenderer } from './notifications.render';
import { NotificationsService } from './notifications.service';
import { quietState } from './notifications.quiet';
import { slidingPeek, slidingRecord } from './notifications.window';

/** Сколько созревших push-доставок разбирает один прогон батчера (хвост берёт свой джоб). */
const PUSH_BATCH = 200;

/**
 * Deep link push несёт `n=<id>` — веб пометит строку прочитанной при открытии. Разделитель
 * считается по ФАКТИЧЕСКОМУ адресу: он приходит и от продюсера (`actionUrl`), и из реестра
 * (`href(ref)`), а тот сам бывает с query (`/messenger?chat=…`) — иначе выходило `…?chat=x?n=y`.
 */
export function withRowParam(href: string, notificationId: string | null): string {
  if (!notificationId) return href;
  const [path, hash = ''] = splitHash(href);
  return `${path}${path.includes('?') ? '&' : '?'}n=${notificationId}${hash}`;
}

function splitHash(href: string): [string, string] {
  const i = href.indexOf('#');
  return i === -1 ? [href, ''] : [href.slice(0, i), href.slice(i)];
}

/**
 * Канальные джобы: push (батчер на человека), SMS (по доставке), chat (по доставке).
 * Push/SMS рендерятся В МОМЕНТ доставки в `User.locale` адресата (фон — язык человека,
 * не запроса). Каждая строка лога несёт eventId/deliveryId — трассируемость (Slack).
 */
@Injectable()
export class NotificationsDelivery implements OnModuleInit {
  private readonly logger = new Logger(NotificationsDelivery.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly jobsRegistry: JobsRegistry,
    private readonly jobs: JobsService,
    private readonly redis: RedisService,
    private readonly i18n: I18nService,
    private readonly sms: VerifySmsService,
    private readonly channels: NotificationChannelRegistry,
    private readonly renderer: NotificationsRenderer,
    private readonly notifications: NotificationsService,
    private readonly entitlements: EntitlementsService,
    private readonly pdActions: ConsentsActionsService,
  ) {}

  onModuleInit(): void {
    this.jobsRegistry.register(NOTIFICATION_JOBS.deliverPush, (p) => this.deliverPush(String(p['userId'] ?? '')), {
      queue: NOTIFICATION_QUEUE,
      maxAttempts: 5,
    });
    this.jobsRegistry.register(NOTIFICATION_JOBS.deliverSms, (p) => this.deliverSms(BigInt(String(p['deliveryId'] ?? '0')), atHint(p)), {
      queue: NOTIFICATION_QUEUE,
      maxAttempts: 4,
    });
    this.jobsRegistry.register(NOTIFICATION_JOBS.deliverChat, (p) => this.deliverChat(BigInt(String(p['deliveryId'] ?? '0')), atHint(p)), {
      queue: NOTIFICATION_QUEUE,
      maxAttempts: 5,
    });
  }

  // ============================================================
  // Push — батчер «N новых»
  // ============================================================

  private async deliverPush(userId: string): Promise<void> {
    if (!userId) return;
    const now = new Date();
    const due = await this.db.notificationDelivery.findMany({
      where: { userId, channel: 'push', status: 'queued', scheduledAt: { lte: now } },
      orderBy: { id: 'asc' },
      take: PUSH_BATCH,
    });
    if (!due.length) return;
    // Страница выбрана целиком — созревшего больше, чем влезло: хвост подберёт свой джоб
    if (due.length === PUSH_BATCH) await this.enqueueSelf(userId, new Date(Date.now() + 15_000), 'tail');

    const user = await this.db.user.findUnique({ where: { id: userId }, select: { locale: true, timezone: true } });
    if (!user) {
      await this.db.notificationDelivery.updateMany({ where: { id: { in: due.map((d) => d.id) } }, data: { status: 'skipped', skipReason: 'no_access' } });
      return;
    }
    const settings = await this.db.userNotificationSettings.findUnique({ where: { userId } });
    const locale = this.i18n.negotiate(null, user.locale);

    // Тишина проверяется ещё раз В МОМЕНТ доставки (пауза могла появиться после фанаута);
    // critical пробивает — его доставки помечены событием critical.
    const rows = await this.db.notificationDelivery.findMany({
      where: { id: { in: due.map((d) => d.id) } },
      include: { event: true },
    });
    const quiet = quietState(settings, now, user.timezone);
    const sendable: typeof rows = [];
    let deferredUntil: Date | null = null;
    for (const r of rows) {
      const critical = r.event.priority === 'critical';
      if (quiet.quiet && quiet.until && !critical) {
        deferredUntil = quiet.until;
        continue;
      }
      sendable.push(r);
    }
    if (deferredUntil) {
      const sendableIds = new Set(sendable.map((r) => r.id));
      const deferredIds = rows.filter((r) => !sendableIds.has(r.id)).map((r) => r.id);
      await this.db.notificationDelivery.updateMany({ where: { id: { in: deferredIds } }, data: { scheduledAt: deferredUntil, skipReason: 'quiet' } });
      await this.enqueueSelf(userId, deferredUntil, 'quiet');
    }
    if (!sendable.length) return;

    // Presence-aware: строка уже просмотрена в приложении → push не нужен
    const notificationIds = sendable.map((r) => r.notificationId).filter((id): id is string => !!id);
    const seen = new Set(
      (await this.db.notification.findMany({ where: { id: { in: notificationIds }, seenAt: { not: null } }, select: { id: true } })).map((n) => n.id),
    );
    const fresh: typeof sendable = [];
    const skipIds: { id: bigint; reason: 'seen' | 'expired' }[] = [];
    for (const r of sendable) {
      if (r.notificationId && seen.has(r.notificationId)) {
        skipIds.push({ id: r.id, reason: 'seen' });
        continue;
      }
      const ttl = notificationDef(r.event.type)?.ttlSec;
      if (ttl && r.event.createdAt.getTime() + ttl * 1000 < now.getTime()) {
        skipIds.push({ id: r.id, reason: 'expired' });
        continue;
      }
      fresh.push(r);
    }
    for (const reason of ['seen', 'expired'] as const) {
      const ids = skipIds.filter((s) => s.reason === reason).map((s) => s.id);
      if (ids.length) await this.db.notificationDelivery.updateMany({ where: { id: { in: ids } }, data: { status: 'skipped', skipReason: reason } });
    }
    if (!fresh.length) return;

    const devices = await this.db.notificationDevice.findMany({ where: { userId, disabledAt: null } });
    if (!devices.length) {
      await this.db.notificationDelivery.updateMany({ where: { id: { in: fresh.map((r) => r.id) } }, data: { status: 'skipped', skipReason: 'no_device' } });
      return;
    }

    // Burst guard: ≥max push за окно → только сводные (Knock throttle)
    const burst = await slidingPeek(this.redis, NOTIFICATION_REDIS.burst(userId), NOTIFICATION_LIMITS.pushBurst.windowSec).catch(() => 0);
    const summary = fresh.length > 1 || burst >= NOTIFICATION_LIMITS.pushBurst.max;

    const first = fresh[0];
    const firstText = this.renderer.render(locale, first.event.type, (first.event.payload ?? {}) as Record<string, unknown>, {
      snapshot: first.event.snapshot as { title?: unknown; body?: unknown } | null,
    });
    const firstRef: NotificationRef | null = first.event.refType && first.event.refId ? { type: first.event.refType, id: first.event.refId } : null;
    const message: PushMessage = summary
      ? {
          title: this.i18n.translateFor(locale, 'notifications.push.summaryTitle', { n: fresh.length }),
          body: this.i18n.translateFor(locale, 'notifications.push.summaryBody', { first: firstText.title }),
          href: '/notifications',
          notificationId: null,
          icon: 'bell',
          collapseKey: `summary:${userId}`,
        }
      : {
          title: firstText.title,
          body: firstText.body,
          href: withRowParam(
            this.notifications.hrefFor(first.event.actionUrl, firstRef, first.event.workspaceId) ?? '/notifications',
            first.notificationId,
          ),
          notificationId: first.notificationId,
          icon: notificationDef(first.event.type)?.icon ?? 'bell',
          ttlSec: notificationDef(first.event.type)?.ttlSec,
          collapseKey: first.notificationId ?? undefined,
        };

    let sentAny = false;
    let lastError: string | null = null;
    for (const device of devices) {
      const driver = this.channels.push(device.provider as PushDevice['provider']);
      if (!driver || !driver.live) continue;
      const res = await driver.send(
        { id: device.id, userId, provider: device.provider as PushDevice['provider'], token: device.token, subscription: (device.subscription as Record<string, unknown> | null) ?? null },
        message,
      );
      if (res.ok) {
        sentAny = true;
        if (device.failureCount > 0) await this.db.notificationDevice.update({ where: { id: device.id }, data: { failureCount: 0 } });
      } else {
        lastError = res.error ?? 'failed';
        // 404/410 — подписка мертва; 3 отказа подряд — тоже выключаем
        const failures = device.failureCount + 1;
        await this.db.notificationDevice.update({
          where: { id: device.id },
          data: { failureCount: failures, disabledAt: res.gone || failures >= NOTIFICATION_LIMITS.deviceFailuresToDisable ? new Date() : null },
        });
      }
    }
    const ids = fresh.map((r) => r.id);
    if (sentAny) {
      await this.db.notificationDelivery.updateMany({
        where: { id: { in: ids } },
        data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 }, providerMessageId: summary ? `summary:${fresh.length}` : null },
      });
      await slidingRecord(this.redis, NOTIFICATION_REDIS.burst(userId), NOTIFICATION_LIMITS.pushBurst.windowSec).catch(() => undefined);
      // Учёт действий с ПДн: токен устройства и текст ушли службе доставки браузера (трансгранично)
      await this.pdActions.record(null, { subjectId: userId, recipient: 'web_push', purpose: 'notification_push', refType: 'notification', refId: first.notificationId ?? null });
    } else {
      const anyLive = devices.some((d) => this.channels.push(d.provider as PushDevice['provider'])?.live);
      await this.db.notificationDelivery.updateMany({
        where: { id: { in: ids } },
        data: anyLive
          ? { status: 'failed', error: (lastError ?? 'failed').slice(0, 500), attempts: { increment: 1 } }
          : { status: 'skipped', skipReason: 'driver_not_configured' },
      });
    }
  }

  /**
   * Догоняющий прогон батчера для того же человека. `uniqueKey` не обновляет runAt живого
   * джоба, а «уже идёт» ≠ «уже учтено»: прогон, который сам себя и вытеснил (он в статусе
   * executing), оставил бы отложенные доставки висеть до следующего чужого push. Поэтому
   * при `inserted=false` ставится ПАРНЫЙ ключ — правило core/jobs, как у enqueuePushJob.
   */
  private async enqueueSelf(userId: string, runAt: Date, kind: 'quiet' | 'tail'): Promise<void> {
    const res = await this.jobs.enqueue(null, {
      type: NOTIFICATION_JOBS.deliverPush,
      payload: { userId },
      runAt,
      uniqueKey: `push:${userId}:${kind}`,
    });
    if (res.inserted) return;
    await this.jobs.enqueue(null, {
      type: NOTIFICATION_JOBS.deliverPush,
      payload: { userId },
      runAt: new Date(Math.max(runAt.getTime(), Date.now() + 15_000)),
      uniqueKey: `push:${userId}:${kind}:next`,
    });
  }

  // ============================================================
  // SMS — только critical + opt-in, KZ-номер, суточные потолки
  // ============================================================

  private async deliverSms(deliveryId: bigint, at: Date | null): Promise<void> {
    const d = await this.loadDelivery(deliveryId, at);
    if (!d) throw new JobDiscardError(`delivery ${deliveryId} not found`);
    if (d.status !== 'queued' || !d.userId) return;
    const key = { id_createdAt: { id: d.id, createdAt: d.createdAt } };
    const user = await this.db.user.findUnique({ where: { id: d.userId }, select: { phone: true, locale: true } });
    const skip = async (reason: string) => {
      await this.db.notificationDelivery.update({ where: key, data: { status: 'skipped', skipReason: reason } });
    };
    if (!user) return skip('no_access');
    if (!isKzMobilePhone(user.phone)) return skip('no_phone');
    if (!this.sms.driver.live && !isDevEnv()) return skip('driver_not_configured');

    // Личный потолок — анти-абьюз (Redis, окно суток); бюджет ОРГАНИЗАЦИИ — тарифная
    // квота `notifications.smsPerDay` (core/entitlements): РЕЗЕРВ в транзакции до
    // отправки (fail-closed: пачка параллельных доставок не проедет потолок),
    // ленивый суточный сброс, отказ 402 → доставка `skipped: budget`.
    const userKey = NOTIFICATION_REDIS.smsUser(d.userId);
    const usedUser = await slidingPeek(this.redis, userKey, 86_400).catch(() => 0);
    if (usedUser >= NOTIFICATION_LIMITS.smsPerUserDaily) return skip('budget');
    const wsId = d.event.workspaceId;
    let reserved = false;
    if (wsId) {
      try {
        await this.db.$transaction((tx) => this.entitlements.consume(tx, { type: 'workspace', id: wsId }, 'notifications.smsPerDay', 1));
        reserved = true;
      } catch (err) {
        if (isApiError(err) && err.getStatus() === 402) return skip('budget');
        throw err;
      }
    }
    /**
     * Бюджет тратится по ФАКТУ отправки (правило core/verify): всё, что кончилось БЕЗ
     * ушедшей SMS, возвращает единицу — иначе сбой шлюза и каждый ретрей джоба
     * сжигали бы платную квоту организации, ничего не доставив.
     */
    const refund = async (): Promise<void> => {
      if (!reserved || !wsId) return;
      reserved = false;
      try {
        await this.db.$transaction((tx) => this.entitlements.release(tx, { type: 'workspace', id: wsId }, 'notifications.smsPerDay', 1));
      } catch (err) {
        // Возврат — не security-эффект: ночная сверка и суточный сброс добьют дрейф
        this.logger.warn(`[${d.eventId}] SMS budget refund failed: ${(err as Error).message}`);
      }
    };

    let body: string;
    try {
      const locale = this.i18n.negotiate(null, user.locale);
      const text = this.renderer.render(locale, d.event.type, (d.event.payload ?? {}) as Record<string, unknown>, {
        snapshot: d.event.snapshot as { title?: unknown; body?: unknown } | null,
      });
      const ref: NotificationRef | null = d.event.refType && d.event.refId ? { type: d.event.refType, id: d.event.refId } : null;
      const href = this.notifications.hrefFor(d.event.actionUrl, ref, d.event.workspaceId);
      const webUrl = process.env.WEB_URL || 'http://localhost:3000';
      body = this.i18n.translateFor(locale, 'notifications.sms.text', { title: text.title }) + (href ? ` ${webUrl}${href}` : '');
    } catch (e) {
      await refund(); // текст не собрался — SMS не уйдёт, резерв возвращаем
      throw e;
    }

    let res: { ok: boolean; error?: string; providerMessageId?: string | null };
    try {
      res = await this.sms.driver.send(user.phone, body);
    } catch (e) {
      await refund();
      await this.db.notificationDelivery.update({ where: key, data: { attempts: { increment: 1 }, error: (e as Error).message.slice(0, 500) } });
      throw e; // транзиентно — движок ретраит, резерв возьмётся заново
    }
    if (!res.ok) {
      await refund();
      await this.db.notificationDelivery.update({
        where: key,
        data: { status: 'failed', attempts: { increment: 1 }, error: (res.error ?? 'failed').slice(0, 500) },
      });
      this.logger.warn(`[${d.eventId}] SMS → ${maskPhone(user.phone)} failed: ${res.error ?? 'no reason'}`);
      return;
    }
    await slidingRecord(this.redis, userKey, 86_400).catch(() => undefined);
    // Учёт действий с ПДн: номер и текст ушли SMS-шлюзу
    await this.pdActions.record(null, { subjectId: d.userId, recipient: 'kazinfoteh', purpose: 'notification_sms', refType: 'notification_delivery', refId: String(deliveryId) });
    await this.db.notificationDelivery.update({
      where: key,
      data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 }, providerMessageId: (res as { providerMessageId?: string | null }).providerMessageId ?? null },
    });
  }

  // ============================================================
  // Chat — системное сообщение / рич-карта в чат (драйвер регистрирует мессенджер)
  // ============================================================

  private async deliverChat(deliveryId: bigint, at: Date | null): Promise<void> {
    const d = await this.loadDelivery(deliveryId, at);
    if (!d) throw new JobDiscardError(`delivery ${deliveryId} not found`);
    if (d.status !== 'queued' || !d.recipient.startsWith('chat:')) return;
    const key = { id_createdAt: { id: d.id, createdAt: d.createdAt } };
    const driver = this.channels.chat();
    if (!driver || !driver.live) {
      await this.db.notificationDelivery.update({ where: key, data: { status: 'skipped', skipReason: 'driver_not_configured' } });
      return;
    }
    const chatId = d.recipient.slice('chat:'.length);
    const payload = (d.event.payload ?? {}) as Record<string, unknown>;
    const ref: NotificationRef | null = d.event.refType && d.event.refId ? { type: d.event.refType, id: d.event.refId } : null;
    const text = this.renderer.render(SOURCE_LOCALE, d.event.type, payload, { snapshot: d.event.snapshot as { title?: unknown; body?: unknown } | null });
    const res = await driver.post({
      chatId,
      eventId: d.eventId,
      type: d.event.type,
      text: text.body ? `${text.title}\n${text.body}` : text.title,
      payload,
      href: this.notifications.hrefFor(d.event.actionUrl, ref, d.event.workspaceId),
      ref,
      richCardType: this.notifications.richCardTypeFor(ref),
      actorId: d.event.actorId,
    });
    if (res.ok) {
      await this.db.notificationDelivery.update({
        where: key,
        data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 }, providerMessageId: res.messageId ?? null },
      });
      return;
    }
    if (res.gone) {
      // Чата нет / он закрыт — постоянная ошибка, ретраить нечего
      await this.db.notificationDelivery.update({
        where: key,
        data: { status: 'skipped', skipReason: 'no_access', attempts: { increment: 1 }, error: (res.error ?? 'failed').slice(0, 500) },
      });
      return;
    }
    // Транзиентная ошибка: статус остаётся `queued` — иначе ретрай джоба упёрся бы в
    // собственный гвард «не queued → выходим» и сжёг бы все попытки вхолостую.
    await this.db.notificationDelivery.update({
      where: key,
      data: { attempts: { increment: 1 }, error: (res.error ?? 'failed').slice(0, 500) },
    });
    throw new Error(res.error ?? 'chat post failed');
  }

  /**
   * Доставка по id. Журнал партиционирован по месяцу `created_at` (= момент события):
   * подсказка из джоба сужает поиск до одной партиции; джоб старой формы (без `at`) ищет
   * по всем.
   */
  private loadDelivery(id: bigint, at: Date | null) {
    return this.db.notificationDelivery.findFirst({ where: { id, ...(at ? { createdAt: at } : {}) }, include: { event: true } });
  }
}

/** Момент события из payload джоба доставки (подсказка партиции); нет или битый — null. */
function atHint(p: Record<string, unknown>): Date | null {
  const raw = typeof p['at'] === 'string' ? p['at'] : null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
