import { Injectable, Logger } from '@nestjs/common';
import webpush from 'web-push';
import { isAllowedWebPushEndpoint } from '@superapp/shared';
import type { PushDevice, PushDriver, PushMessage, PushSendResult } from '../notifications.registry';

/**
 * Web push (VAPID + service worker браузера). Живой при `WEB_PUSH_VAPID_PUBLIC_KEY` +
 * `WEB_PUSH_VAPID_PRIVATE_KEY` (+ `WEB_PUSH_SUBJECT` — mailto:/https: контакт для push-службы).
 * Endpoint подписки — адрес ИЗ ДАННЫХ: перед отправкой перепроверяется белым списком
 * хостов push-служб (docs/security.md), даже если прошёл его при регистрации.
 */
@Injectable()
export class WebPushDriver implements PushDriver {
  readonly provider = 'webpush' as const;
  readonly live: boolean;
  private readonly logger = new Logger(WebPushDriver.name);

  constructor() {
    const pub = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    const priv = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    this.live = !!pub && !!priv;
    if (this.live) {
      webpush.setVapidDetails(process.env.WEB_PUSH_SUBJECT || 'mailto:support@superapp6.kz', pub!, priv!);
    }
  }

  async send(device: PushDevice, message: PushMessage): Promise<PushSendResult> {
    if (!this.live) return { ok: false, error: 'driver_not_configured' };
    const sub = device.subscription as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | null;
    const endpoint = sub?.endpoint ?? device.token;
    if (!isAllowedWebPushEndpoint(endpoint) || !sub?.keys?.p256dh || !sub.keys.auth) {
      return { ok: false, gone: true, error: 'invalid_subscription' };
    }
    const payload = JSON.stringify({
      title: message.title,
      body: message.body ?? '',
      href: message.href,
      notificationId: message.notificationId,
      icon: message.icon,
      tag: message.collapseKey ?? undefined,
    });
    try {
      const res = await webpush.sendNotification(
        { endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
        payload,
        { TTL: message.ttlSec ?? 24 * 3600, urgency: 'high', ...(message.collapseKey ? { topic: topicOf(message.collapseKey) } : {}) },
      );
      return { ok: true, providerMessageId: res.headers?.['location'] ?? null };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      const gone = status === 404 || status === 410;
      if (!gone) this.logger.warn(`web push -> ${device.id} failed: ${status ?? ''} ${(e as Error).message}`);
      return { ok: false, gone, error: `${status ?? ''} ${(e as Error).message}`.trim() };
    }
  }
}

/** Topic web push — ≤32 символа base64url. */
function topicOf(key: string): string {
  return Buffer.from(key).toString('base64url').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'n';
}
