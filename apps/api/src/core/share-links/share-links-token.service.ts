import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { SHARE_LINK_LIMITS } from '@superapp/shared';
import { KeysSigningService } from '../keys/keys.signing.service';
import { legacyDerivedKey, legacyOpen } from '../keys/keys.legacy';

/** Нагрузка гостевого пропуска. Ключи короткие: пропуск едет заголовком на каждый запрос страницы. */
export interface ShareSessionPayload {
  /** linkId */
  l: string;
  /** срок, мс с 1970 */
  x: number;
  /**
   * Поколение (`ShareLink.sessionEpoch`). Пропуск подписан по linkId, а НЕ по токену,
   * поэтому без поколения смена адреса ссылки не отрезала бы того, кто её уже открыл, —
   * то есть ровно того, ради кого адрес и меняют. Старые пропуска без поля считаются
   * нулевым поколением.
   */
  e?: number;
  /**
   * Личность гостя (`ShareLinkGuest.id`) — если ссылка требовала подтверждение номера.
   * По нему authorizeGuest отдаёт потребителям «кто по ту сторону»; будущие действия
   * (подпись, оплата, ответ на опрос) пишут его в свои доказательные записи.
   */
  g?: string;
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
 * Подпись — keystore core/keys, СВОЯ аудитория `share_link` (Ed25519, `kid`,
 * `typ: share+jwt`): утечка гостевого пропуска не становится оракулом ключа продукта
 * и наоборот. Прошлый формат `v1.<payload>.<hmac>` принимается только на legacy-окне.
 */
@Injectable()
export class ShareLinksTokenService {
  constructor(private readonly signing: KeysSigningService) {}

  async issue(linkId: string, sessionEpoch: number, guestId?: string | null): Promise<{ token: string; expiresAt: Date }> {
    const ttlSec = SHARE_LINK_LIMITS.guestSessionTtlMin * 60;
    const expiresAtMs = Date.now() + ttlSec * 1000;
    const payload: ShareSessionPayload = { l: linkId, x: expiresAtMs, e: sessionEpoch };
    if (guestId) payload.g = guestId;
    // Своя аудитория `share_link` в keystore: пропуск гостя не подходит ни к чему, кроме ссылки
    const token = await this.signing.sign('share_link', { ...payload }, { ttlSec, typ: 'share+jwt' });
    return { token, expiresAt: new Date(expiresAtMs) };
  }

  async verify(token: string | undefined | null): Promise<ShareSessionVerdict> {
    if (!token) return { ok: false, reason: 'no pass' };
    if (token.startsWith('v1.')) return this.verifyLegacy(token);
    let payload: ShareSessionPayload;
    try {
      payload = await this.signing.verify<ShareSessionPayload>('share_link', token, { typ: 'share+jwt' });
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    return this.checkPayload(payload);
  }

  private checkPayload(payload: ShareSessionPayload): ShareSessionVerdict {
    if (!payload?.l) return { ok: false, reason: 'payload' };
    if (!Number.isFinite(payload.x) || payload.x <= Date.now()) return { ok: false, reason: 'expired' };
    return { ok: true, payload: { l: payload.l, x: payload.x, ...(payload.e !== undefined ? { e: payload.e } : {}), ...(payload.g ? { g: payload.g } : {}) } };
  }

  /** Прошлый формат `v1.<payload>.<hmac>` — только на legacy-окне, только проверка. */
  private legacyKey(): Buffer | null {
    if (!legacyOpen()) return null;
    const own = process.env.SHARE_LINK_SECRET;
    return own ? Buffer.from(own, 'utf8') : legacyDerivedKey('core/share-links:guest:v1');
  }

  private verifyLegacy(token: string): ShareSessionVerdict {
    const key = this.legacyKey();
    if (!key) return { ok: false, reason: 'legacy window closed' };
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, reason: 'format' };
    const body = `${parts[0]}.${parts[1]}`;
    const expected = Buffer.from(createHmac('sha256', key).update(body).digest('base64url'), 'utf8');
    const got = Buffer.from(parts[2]!, 'utf8');
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
      return { ok: false, reason: 'signature' };
    }
    let payload: ShareSessionPayload;
    try {
      payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as ShareSessionPayload;
    } catch {
      return { ok: false, reason: 'unreadable payload' };
    }
    return this.checkPayload(payload);
  }
}
