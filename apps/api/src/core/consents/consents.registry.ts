import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ConsentDocumentKey, ConsentRevokeReason, ConsentSubjectType } from '@superapp/shared';

type Tx = Prisma.TransactionClient;

export interface ConsentRevokeHook {
  /**
   * Согласие отозвано: владелец данных, которые на нём держатся, гасит их В ТОЙ ЖЕ транзакции
   * (подключение Google Calendar — отключение и стирание токенов). Бросок откатывает отзыв.
   *
   * В транзакции — ТОЛЬКО база. Внешний эффект (отзыв токена у Google) хук возвращает функцией:
   * движок выполнит её ПОСЛЕ коммита. Сетевой вызов внутри транзакции держал бы её открытой на
   * время чужого таймаута (у Prisma — 5 секунд, дальше откат отзыва), а при откате оставлял бы
   * эффект снаружи без эффекта в базе.
   */
  onRevoked(tx: Tx, subject: { type: ConsentSubjectType; id: string }, reason: ConsentRevokeReason): Promise<void | (() => Promise<void>)>;
}

/**
 * Реестр хуков отзыва — регистрирует ВЛАДЕЛЕЦ данных в своём `onModuleInit` (направление
 * «фича → движок»: движок согласий фичи не импортирует). Без хука отзыв согласия на
 * интеграцию оставлял бы передачу данных работать — правило «действует на всех путях».
 */
@Injectable()
export class ConsentsRevokeRegistry {
  private readonly logger = new Logger(ConsentsRevokeRegistry.name);
  private readonly hooks = new Map<ConsentDocumentKey, ConsentRevokeHook[]>();

  register(documentKey: ConsentDocumentKey, hook: ConsentRevokeHook): void {
    const list = this.hooks.get(documentKey) ?? [];
    list.push(hook);
    this.hooks.set(documentKey, list);
    this.logger.log(`revoke hook registered for "${documentKey}"`);
  }

  /** Возвращает эффекты «после коммита», собранные с хуков (вызывающий обязан их выполнить). */
  async run(tx: Tx, documentKey: ConsentDocumentKey, subject: { type: ConsentSubjectType; id: string }, reason: ConsentRevokeReason): Promise<Array<() => Promise<void>>> {
    const after: Array<() => Promise<void>> = [];
    for (const hook of this.hooks.get(documentKey) ?? []) {
      const fn = await hook.onRevoked(tx, subject, reason);
      if (typeof fn === 'function') after.push(fn);
    }
    return after;
  }
}
