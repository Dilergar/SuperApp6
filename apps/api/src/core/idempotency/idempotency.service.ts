import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { IDEMPOTENCY_DERIVED_PREFIX, IDEMPOTENCY_STABLE_PREFIX } from '@superapp/shared';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';

// ============================================================
// Публичный сервисный API движка: производные ключи «вниз по стеку».
//
// HTTP-ключ защищает ВХОД. Но у денег есть второй ремень — собственный ключ
// идемпотентности у проводки леджера (`LedgerTransfer.idempotencyKey`), и он обязан
// пережить строку `idem.keys`: та живёт 7 дней, деньги — всегда.
//
// Поэтому производный ключ считается из СТАБИЛЬНЫХ входов (scope_hash | key_hash | шаг),
// а НЕ из id строки заявки: id сменился бы вместе со строкой, и второй ремень молча
// отвалился бы ровно тогда, когда он нужен — на повторе через неделю.
// ============================================================

/** sha256 в base64url — компактно и безопасно для колонок и URL. */
const digest = (parts: readonly string[]): string =>
  createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('base64url');

@Injectable()
export class IdempotencyService {
  constructor(private readonly wsContext: WorkspaceContextService) {}

  /** Есть ли у ЭТОГО запроса заявка движка (иначе производного ключа не существует). */
  get active(): boolean {
    return this.wsContext.get()?.idem !== undefined;
  }

  /**
   * Производный ключ шага внутри запроса: `idem:v1:<sha256(scope|key|hop)>`.
   * `hop` — имя шага («wallet.transfer», «escrow.hold»), стабильное между повторами.
   *
   * `null` — у запроса нет ключа (движок выключен, ручка вне HTTP): вызывающий
   * обязан иметь СВОЙ механизм — молча терять второй ремень нельзя.
   */
  deriveKey(hop: string): string | null {
    const b = this.wsContext.get()?.idem;
    if (!b) return null;
    return (
      IDEMPOTENCY_DERIVED_PREFIX +
      digest([b.scopeHash.toString('hex'), b.keyHash.toString('hex'), hop])
    );
  }

  /**
   * Ключ из стабильных частей ВНЕ HTTP (джоб, крон, нода Процессов): приём Shopify
   * UUIDv5 — «одинаковый вход ⇒ одинаковый ключ». Части обязаны быть детерминированными
   * (id сущности, ключ периода), а НЕ временем вызова и не случайным числом.
   */
  stableKey(namespace: string, ...parts: Array<string | number>): string {
    return IDEMPOTENCY_STABLE_PREFIX + digest([namespace, ...parts.map(String)]);
  }

  /**
   * Производный ключ, а если его нет — стабильный запасной. Для денег: при ключе
   * клиента ремень крепится к намерению, без ключа — к самой сущности.
   */
  keyFor(hop: string, ...fallbackParts: Array<string | number>): string {
    return this.deriveKey(hop) ?? this.stableKey(hop, ...fallbackParts);
  }
}
