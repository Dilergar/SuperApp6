import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { SHARE_LINK_LIMITS } from '@superapp/shared';

/** Нагрузка гостевого пропуска. Ключи короткие: пропуск едет заголовком на каждый запрос страницы. */
export interface ShareSessionPayload {
  /** linkId */
  l: string;
  /** срок, мс с 1970 */
  x: number;
}

export interface ShareSessionVerdict {
  ok: boolean;
  payload?: ShareSessionPayload;
  /** Почему отвергнут — только для лога, наружу не уходит */
  reason?: string;
}

/**
 * Пропуск гостя, уже открывшего ссылку. НЕ платформенный JWT намеренно: предъявитель
 * не является пользователем платформы и не должен получить доступ ни к чему, кроме
 * содержимого одной конкретной ссылки.
 *
 * Формат самодостаточный, в БД не хранится: `v1.<payload>.<hmac>`, оба сегмента
 * base64url (тот же приём, что у токенов редактора документов). Отдельной «эпохи»
 * здесь нет и не нужно: строка ссылки перечитывается на КАЖДОМ запросе, поэтому
 * отзыв срабатывает мгновенно, а пропуск сам по себе ничего не разрешает.
 *
 * Ключ подписи — SHARE_LINK_SECRET; пусто → выводим из JWT_SECRET отдельной строкой
 * контекста, чтобы утечка гостевого пропуска не превращалась в оракул платформенного
 * секрета и наоборот.
 */
@Injectable()
export class ShareLinksTokenService {
  private cachedKey: { source: string; key: Buffer } | null = null;

  private get signingKey(): Buffer {
    const source = process.env.SHARE_LINK_SECRET || process.env.JWT_SECRET || '';
    if (this.cachedKey?.source === source) return this.cachedKey.key;
    const key = process.env.SHARE_LINK_SECRET
      ? Buffer.from(source, 'utf8')
      : createHmac('sha256', source).update('core/share-links:guest:v1').digest();
    this.cachedKey = { source, key };
    return key;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.signingKey).update(body).digest('base64url');
  }

  issue(linkId: string): { token: string; expiresAt: Date } {
    const expiresAtMs = Date.now() + SHARE_LINK_LIMITS.guestSessionTtlMin * 60 * 1000;
    const payload: ShareSessionPayload = { l: linkId, x: expiresAtMs };
    const body = `v1.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
    return { token: `${body}.${this.sign(body)}`, expiresAt: new Date(expiresAtMs) };
  }

  verify(token: string | undefined | null): ShareSessionVerdict {
    if (!token) return { ok: false, reason: 'нет пропуска' };
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, reason: 'формат' };
    const body = `${parts[0]}.${parts[1]}`;
    const expected = Buffer.from(this.sign(body), 'utf8');
    const got = Buffer.from(parts[2], 'utf8');
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
      return { ok: false, reason: 'подпись' };
    }
    let payload: ShareSessionPayload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as ShareSessionPayload;
    } catch {
      return { ok: false, reason: 'нечитаемая нагрузка' };
    }
    if (!payload?.l) return { ok: false, reason: 'нагрузка' };
    if (!Number.isFinite(payload.x) || payload.x <= Date.now()) return { ok: false, reason: 'истёк' };
    return { ok: true, payload };
  }
}
