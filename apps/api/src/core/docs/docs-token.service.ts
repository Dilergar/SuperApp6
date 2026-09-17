import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { DOCS_LIMITS } from '@superapp/shared';
import { KeysSigningService } from '../keys/keys.signing.service';
import { legacyDerivedKey, legacyOpen } from '../keys/keys.legacy';

/**
 * Полезная нагрузка WOPI-токена. Короткие ключи не ради красоты: токен уходит в
 * form POST на каждое открытие и в каждый запрос редактора, и длина тут — трафик.
 */
export interface DocsTokenPayload {
  /** documentId */
  d: string;
  /** userId */
  u: string;
  /** режим: w = правка, r = только чтение */
  m: 'w' | 'r';
  /** Document.tokenEpoch на момент выдачи — рубильник массового отзыва */
  e: number;
  /** срок, мс с 1970 */
  x: number;
  /**
   * Место, через которое человек вошёл: `refType:refId`. Токен самодостаточен и живёт
   * часами, поэтому права по нему ПЕРЕРЕШИВАЮТСЯ на каждом запросе — а для этого нужно
   * знать место (правка наследуется только от него). Без этого поля «убрали из задачи»
   * не отзывало бы уже выданный пропуск на запись.
   */
  p?: string;
}

export interface DocsTokenVerdict {
  ok: boolean;
  payload?: DocsTokenPayload;
  /** Почему отвергнут — только для лога, наружу не уходит */
  reason?: string;
}

const LEGACY_CONTEXT = 'core/docs:wopi-token:v1';

/**
 * Токены доступа WOPI. НЕ платформенный access-токен намеренно: этот токен живёт по
 * другим правилам (привязан к паре «пользователь+документ» и к режиму, гасится бампом
 * tokenEpoch документа, живёт 10 часов) и не должен ни при каких обстоятельствах
 * пускать предъявителя в остальное API — у него СВОЯ аудитория `wopi` в keystore
 * (Ed25519, `kid`, `typ: wopi+jwt`), верификатор продукта её отвергает по `aud`.
 *
 * Прошлый формат `v1.<payload>.<hmac>` (ключ из DOCS_TOKEN_SECRET либо производный от
 * мастер-секрета) принимается только на legacy-окне и только для проверки.
 */
@Injectable()
export class DocsTokenService {
  constructor(private readonly signing: KeysSigningService) {}

  /** TTL берётся из DOCS_LIMITS: правка большого документа идёт часами (риск 6) */
  async issue(input: {
    documentId: string;
    userId: string;
    canWrite: boolean;
    epoch: number;
    place?: { refType: string; refId: string } | null;
  }): Promise<{
    token: string;
    /** ВНИМАНИЕ: WOPI-поле access_token_ttl — это МЕТКА ВРЕМЕНИ в мс, а не длительность */
    expiresAtMs: number;
  }> {
    const ttlSec = DOCS_LIMITS.tokenTtlHours * 60 * 60;
    const expiresAtMs = Date.now() + ttlSec * 1000;
    const payload: DocsTokenPayload = {
      d: input.documentId,
      u: input.userId,
      m: input.canWrite ? 'w' : 'r',
      e: input.epoch,
      x: expiresAtMs,
      ...(input.place ? { p: `${input.place.refType}:${input.place.refId}` } : {}),
    };
    const token = await this.signing.sign('wopi', { ...payload }, { ttlSec, typ: 'wopi+jwt' });
    return { token, expiresAtMs };
  }

  /**
   * Разбор и проверка подписи/срока. Соответствие documentId и tokenEpoch сверяет
   * вызывающий: epoch живёт в БД, и только там видно, что документ отозвали.
   */
  async verify(token: string | undefined | null): Promise<DocsTokenVerdict> {
    if (!token) return { ok: false, reason: 'no token' };
    if (token.startsWith('v1.')) return this.verifyLegacy(token);
    let payload: DocsTokenPayload;
    try {
      payload = await this.signing.verify<DocsTokenPayload>('wopi', token, { typ: 'wopi+jwt' });
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    return this.checkPayload(payload);
  }

  private checkPayload(payload: DocsTokenPayload): DocsTokenVerdict {
    if (!payload?.d || !payload?.u || (payload.m !== 'w' && payload.m !== 'r')) {
      return { ok: false, reason: 'payload' };
    }
    if (!Number.isFinite(payload.x) || payload.x <= Date.now()) return { ok: false, reason: 'expired' };
    return { ok: true, payload: { d: payload.d, u: payload.u, m: payload.m, e: payload.e, x: payload.x, ...(payload.p ? { p: payload.p } : {}) } };
  }

  private legacyKey(): Buffer | null {
    if (!legacyOpen()) return null;
    const own = process.env.DOCS_TOKEN_SECRET;
    return own ? Buffer.from(own, 'utf8') : legacyDerivedKey(LEGACY_CONTEXT);
  }

  private verifyLegacy(token: string): DocsTokenVerdict {
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
    let payload: DocsTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as DocsTokenPayload;
    } catch {
      return { ok: false, reason: 'unreadable payload' };
    }
    return this.checkPayload(payload);
  }

  /**
   * Место из токена обратно в пару. Разделитель — первое двоеточие: зарегистрированные
   * refType'ы его не содержат, а если кто-то передаст такой — место просто не найдётся
   * (hasLink вернёт false), то есть отказ будет в безопасную сторону.
   */
  placeOf(payload: DocsTokenPayload): { refType: string; refId: string } | null {
    if (!payload.p) return null;
    const idx = payload.p.indexOf(':');
    if (idx <= 0 || idx === payload.p.length - 1) return null;
    return { refType: payload.p.slice(0, idx), refId: payload.p.slice(idx + 1) };
  }
}
