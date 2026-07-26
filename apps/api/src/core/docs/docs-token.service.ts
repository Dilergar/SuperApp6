import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { DOCS_LIMITS } from '@superapp/shared';

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

/**
 * Токены доступа WOPI. НЕ платформенный JWT намеренно: этот токен живёт по другим
 * правилам (привязан к паре «пользователь+документ» и к режиму, гасится бампом
 * tokenEpoch документа, живёт 10 часов) и не должен ни при каких обстоятельствах
 * пускать предъявителя в остальное API. Формат самодостаточный — в БД не храним:
 * `v1.<payload>.<hmac>`, оба сегмента base64url.
 *
 * Ключ подписи — DOCS_TOKEN_SECRET; пусто → выводим из JWT_SECRET отдельной строкой
 * контекста, чтобы утечка токена документа не превращалась в оракул платформенного
 * секрета и наоборот.
 */
@Injectable()
export class DocsTokenService {
  private cachedKey: { source: string; key: Buffer } | null = null;

  private get signingKey(): Buffer {
    const source = process.env.DOCS_TOKEN_SECRET || process.env.JWT_SECRET || '';
    if (this.cachedKey?.source === source) return this.cachedKey.key;
    const key = process.env.DOCS_TOKEN_SECRET
      ? Buffer.from(source, 'utf8')
      : createHmac('sha256', source).update('core/docs:wopi-token:v1').digest();
    this.cachedKey = { source, key };
    return key;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.signingKey).update(body).digest('base64url');
  }

  /** TTL берётся из DOCS_LIMITS: правка большого документа идёт часами (риск 6) */
  issue(input: {
    documentId: string;
    userId: string;
    canWrite: boolean;
    epoch: number;
    place?: { refType: string; refId: string } | null;
  }): {
    token: string;
    /** ВНИМАНИЕ: WOPI-поле access_token_ttl — это МЕТКА ВРЕМЕНИ в мс, а не длительность */
    expiresAtMs: number;
  } {
    const expiresAtMs = Date.now() + DOCS_LIMITS.tokenTtlHours * 60 * 60 * 1000;
    const payload: DocsTokenPayload = {
      d: input.documentId,
      u: input.userId,
      m: input.canWrite ? 'w' : 'r',
      e: input.epoch,
      x: expiresAtMs,
      ...(input.place ? { p: `${input.place.refType}:${input.place.refId}` } : {}),
    };
    const body = `v1.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
    return { token: `${body}.${this.sign(body)}`, expiresAtMs };
  }

  /**
   * Разбор и проверка подписи/срока. Соответствие documentId и tokenEpoch сверяет
   * вызывающий: epoch живёт в БД, и только там видно, что документ отозвали.
   */
  verify(token: string | undefined | null): DocsTokenVerdict {
    if (!token) return { ok: false, reason: 'нет токена' };
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, reason: 'формат' };
    const body = `${parts[0]}.${parts[1]}`;
    const expected = Buffer.from(this.sign(body), 'utf8');
    const got = Buffer.from(parts[2], 'utf8');
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
      return { ok: false, reason: 'подпись' };
    }
    let payload: DocsTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as DocsTokenPayload;
    } catch {
      return { ok: false, reason: 'нечитаемая нагрузка' };
    }
    if (!payload?.d || !payload?.u || (payload.m !== 'w' && payload.m !== 'r')) {
      return { ok: false, reason: 'нагрузка' };
    }
    if (!Number.isFinite(payload.x) || payload.x <= Date.now()) return { ok: false, reason: 'истёк' };
    return { ok: true, payload };
  }

  /**
   * Место из токена обратно в пару. Разделитель — первое двоеточие: зарегистрированные
   * refType'ы его не содержат, а если кто-то передаст такой — место просто не найдётся
   * (hasLink вернёт false), то есть отказ будет в безопасную сторону.
   */
  placeOf(payload: DocsTokenPayload): { refType: string; refId: string } | null {
    if (!payload.p) return null;
    const at = payload.p.indexOf(':');
    if (at <= 0 || at === payload.p.length - 1) return null;
    return { refType: payload.p.slice(0, at), refId: payload.p.slice(at + 1) };
  }
}
