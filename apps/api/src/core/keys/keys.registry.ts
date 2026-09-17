import { Injectable, Logger } from '@nestjs/common';
import type { KeyScopeType } from '@superapp/shared';

/**
 * Реестр зашифрованных колонок — регистрирует ВЛАДЕЛЕЦ данных в своём `onModuleInit`
 * (направление «фича → движок»). Нужен фоновым джобам движка: перешивка DEK'ов после
 * ротации KEK (`keys.rewrap`) и переиндексация слепых индексов (`keys.reindex`).
 * Имена таблиц/колонок — только из кода (валидируются регуляркой, в SQL едут как
 * идентификаторы).
 */
export interface EncryptedColumnDef {
  /** Таблица БД (snake_case) */
  table: string;
  idColumn: string;
  /** Колонка с шифротекстом `sa6e:` */
  column: string;
  /** Скоуп KEK строки и колонка с id владельца (у `platform` — не нужна) */
  scope: KeyScopeType;
  scopeColumn?: string;
  /** Контекст AAD: сущность и поле (ownerType/ownerId выводятся из scope) */
  entity: string;
  field: string;
  /** Пара слепого индекса (если есть): колонка `_bi`, имя индекса и нормализация значения */
  blindIndex?: { column: string; name: string; normalize: (plain: string) => string };
  /**
   * Строки прошлой эпохи (не `sa6e:`): как получить открытый текст, чтобы джоб
   * `keys.legacy.reencrypt` перешил их в envelope. `null` — строка нечитаема (окно
   * закрыто / повреждена) — пропускается. Нет функции = legacy-строк у колонки не бывает.
   */
  legacyDecrypt?: (stored: string) => string | null;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

@Injectable()
export class KeysFieldRegistry {
  private readonly logger = new Logger(KeysFieldRegistry.name);
  private readonly defs: EncryptedColumnDef[] = [];

  register(def: EncryptedColumnDef): void {
    for (const ident of [def.table, def.idColumn, def.column, def.scopeColumn, def.blindIndex?.column]) {
      if (ident !== undefined && !IDENT.test(ident)) throw new Error(`keys registry: bad identifier "${ident}"`);
    }
    if (def.scope !== 'platform' && !def.scopeColumn) throw new Error(`keys registry: ${def.table}.${def.column} needs scopeColumn for scope ${def.scope}`);
    this.defs.push(def);
  }

  all(): readonly EncryptedColumnDef[] {
    return this.defs;
  }

  forScope(scope: KeyScopeType): EncryptedColumnDef[] {
    return this.defs.filter((d) => d.scope === scope);
  }
}
