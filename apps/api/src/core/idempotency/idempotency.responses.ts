import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { KeyScopeRef } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { runInternal } from '../../shared/idempotency/binding';
import { KeysEnvelopeService } from '../keys/keys.envelope.service';
import { KeysFieldRegistry } from '../keys/keys.registry';
import {
  IDEMPOTENCY_RESPONSE_ENTITY,
  IDEMPOTENCY_RESPONSE_FIELD,
  idempotencyEnv,
} from './idempotency.constants';
import { IdempotencyPartitions } from './idempotency.partitions';

// ============================================================
// Снимок тела ответа (`idem.responses`).
//
// Тело лежит ПОД KEK владельца (человек / организация бота / платформа для гостя):
// удаление аккаунта уничтожает его ключ, и снимок становится нечитаем сам собой —
// crypto-shredding вместо отдельной уборки. Любой сбой здесь (нет партиции, ключ
// заморожен, строка битая) означает «тела нет», а НЕ отказ запроса.
// ============================================================

export interface SavedResponse {
  id: bigint;
  at: Date;
}

const ctxFor = (scope: KeyScopeRef) => ({
  entity: IDEMPOTENCY_RESPONSE_ENTITY,
  field: IDEMPOTENCY_RESPONSE_FIELD,
  ownerType: scope.type,
  ownerId: scope.type === 'platform' ? 'platform' : scope.id,
});

@Injectable()
export class IdempotencyResponses implements OnModuleInit {
  private readonly logger = new Logger(IdempotencyResponses.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly envelope: KeysEnvelopeService,
    private readonly fields: KeysFieldRegistry,
    private readonly partitions: IdempotencyPartitions,
  ) {}

  /**
   * Колонка снимка — в реестре зашифрованных колонок: иначе после ротации KEK старые
   * версии остались бы `active` навсегда (перешивка их просто не видела бы). Регистрация
   * ТРОЙНАЯ — по разу на вид скоупа, каждая со своим дискриминатором `scope_type`.
   */
  onModuleInit(): void {
    for (const scope of ['user', 'workspace', 'platform'] as const) {
      this.fields.register({
        schema: 'idem',
        table: 'responses',
        idColumn: 'id',
        column: 'body_enc',
        scope,
        scopeColumn: scope === 'platform' ? undefined : 'scope_id',
        scopeDiscriminator: { column: 'scope_type', value: scope },
        entity: IDEMPOTENCY_RESPONSE_ENTITY,
        field: IDEMPOTENCY_RESPONSE_FIELD,
      });
    }
  }

  /** Сохранить снимок. `null` — тела не будет (слишком большое, нет партиции, сбой шифрования). */
  async save(scope: KeyScopeRef, body: string): Promise<SavedResponse | null> {
    const env = idempotencyEnv();
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > env.maxResponseBytes) return null;
    try {
      const at = new Date();
      await this.partitions.ensureFor(at);
      const enc = await this.envelope.encrypt(scope, ctxFor(scope), body);
      return await runInternal(async () => {
        const rows = await this.db.$queryRawUnsafe<Array<{ id: bigint; at: Date }>>(
          `INSERT INTO idem.responses (at, scope_type, scope_id, body_enc, bytes)
           VALUES ($1::timestamptz AT TIME ZONE 'UTC', $2, $3::uuid, $4, $5)
           RETURNING id, at`,
          at,
          scope.type,
          scope.type === 'platform' ? null : scope.id,
          enc,
          bytes,
        );
        const row = rows[0];
        return row ? { id: row.id, at: row.at } : null;
      });
    } catch (err) {
      this.logger.warn(`idempotency snapshot not stored: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Прочитать снимок. `null` — «тела нет»: реплей ответит `already_completed`. */
  async load(scope: KeyScopeRef, id: bigint, at: Date): Promise<string | null> {
    try {
      const stored = await runInternal(async () => {
        const rows = await this.db.$queryRawUnsafe<Array<{ body_enc: string }>>(
          `SELECT body_enc FROM idem.responses WHERE id = $1 AND at = $2::timestamptz AT TIME ZONE 'UTC'`,
          id,
          at,
        );
        return rows[0]?.body_enc ?? null;
      });
      if (!stored) return null;
      const r = await this.envelope.tryDecrypt(scope, ctxFor(scope), stored);
      return r.ok ? r.value : null;
    } catch (err) {
      this.logger.warn(`idempotency snapshot not read: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
