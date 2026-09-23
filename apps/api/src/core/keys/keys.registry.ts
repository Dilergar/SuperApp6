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
  /**
   * Схема таблицы, если это не `public` (служебные хранилища движков: `idem`,
   * `analytics`). Без неё сырой SQL перешивки искал бы таблицу по search_path и
   * молча ничего не находил — старая версия KEK осталась бы `active` навсегда.
   */
  schema?: string;
  idColumn: string;
  /**
   * id — целое (bigint большого журнала, `security_events`): курсор перешивки идёт по числу,
   * а не по `id::text` — текстовое сравнение не берёт индекс, и каждая пачка сортировала бы
   * всю таблицу (O(n²) на миллионах строк), а точечный UPDATE сканировал бы все партиции.
   */
  idNumeric?: boolean;
  /** Колонка с шифротекстом `sa6e:` */
  column: string;
  /** Скоуп KEK строки и колонка с id владельца (у `platform` — не нужна) */
  scope: KeyScopeType;
  scopeColumn?: string;
  /**
   * Полиморфный владелец (`owner_type` + `owner_id`): одна колонка id на два вида скоупа —
   * колонка регистрируется ДВАЖДЫ (по разу на вид), каждая со своим равенством-дискриминатором
   */
  scopeDiscriminator?: { column: string; value: string };
  /** Контекст AAD: сущность и поле (ownerType/ownerId выводятся из scope) */
  entity: string;
  field: string;
  /**
   * Пара слепого индекса (если есть): колонки ДВУХ слотов (`_bi` — слот 0, `_bi_alt` — слот 1),
   * имя индекса и нормализация значения. Версия mac-ключа пишет в колонку СВОЕГО слота.
   */
  blindIndex?: { column: string; altColumn: string; name: string; normalize: (plain: string) => string };
  /** Значение колонки — служебная заглушка без конверта (`deleted:<id>`, `bot:<id>`): индексируется как есть */
  literal?: (stored: string) => boolean;
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
    for (const ident of [def.schema, def.table, def.idColumn, def.column, def.scopeColumn, def.blindIndex?.column, def.blindIndex?.altColumn, def.scopeDiscriminator?.column]) {
      if (ident !== undefined && !IDENT.test(ident)) throw new Error(`keys registry: bad identifier "${ident}"`);
    }
    if (def.scope !== 'platform' && !def.scopeColumn) throw new Error(`keys registry: ${def.table}.${def.column} needs scopeColumn for scope ${def.scope}`);
    // Повторная регистрация той же колонки того же скоупа (HMR, двойной onModuleInit) — не дубль прохода
    const same = (d: EncryptedColumnDef) =>
      d.schema === def.schema && d.table === def.table && d.column === def.column && d.scope === def.scope && d.scopeDiscriminator?.value === def.scopeDiscriminator?.value;
    if (this.defs.some(same)) return;
    this.defs.push(def);
  }

  all(): readonly EncryptedColumnDef[] {
    return this.defs;
  }

  forScope(scope: KeyScopeType): EncryptedColumnDef[] {
    return this.defs.filter((d) => d.scope === scope);
  }
}
