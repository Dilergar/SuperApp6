// ============================================================
// Прозрачный слой ПДн над Prisma (core/keys, фаза D) — КОНТРАКТ хуков.
//
// DatabaseModule строится раньше движка ключей и не смеет от него зависеть, поэтому
// расширение (`pii-extension.ts`) читает хуки из этого держателя на каждый запрос:
// `null` → слой выключен (бут до KeysModule, скрипты). KeysPiiService ставит хуки в
// `onApplicationBootstrap`. Здесь нет ни крипто, ни знания о таблицах — только формы.
// ============================================================

export type PiiScopeRef = { type: 'platform' } | { type: 'workspace' | 'user'; id: string };

export type PiiKeyScopeDecl =
  | { type: 'platform' }
  | { type: 'workspace' | 'user'; field: string; discriminator?: { field: string; value: string } };

export interface PiiFieldDef {
  /** Поле Prisma с открытым текстом (остаётся на окне dual-write) */
  name: string;
  /** Поле-шифротекст (`<name>Enc`) */
  enc: string;
  /** Поле слепого индекса, слот 0 (`<name>Bi`) — только там, где ищут по равенству */
  bi?: string;
  /** Поле слепого индекса, слот 1 (`<name>BiAlt`) — обязательно в паре с `bi` (смена ключа без простоя) */
  biAlt?: string;
  /** Имя слепого индекса (`phone` | `iin` | `email`) — часть HMAC-контекста */
  index?: string;
  /** Нормализация ДО индекса (E.164, 12 цифр, lower-case) */
  normalize?: (v: string) => string;
  /**
   * Значение — служебная заглушка, а не ПДн (`deleted:<id>` анонимизированного, `bot:<id>` бота):
   * в `_enc` ложится КАК ЕСТЬ, без конверта. Иначе заглушка удалённого человека шифровалась бы
   * его же KEK, который тем же шагом уходит на уничтожение (поле читалось бы как null), а
   * каждый бот заводил бы себе KEK ради строки без тайны.
   */
  literal?: (v: string) => boolean;
  /** `date` → в конверт едет `YYYY-MM-DD`, наружу — Date */
  kind?: 'string' | 'date';
  /** Чтение пишется в `pii_access_log` (приказ 179/НҚ: журнал действий с ПДн ограниченного доступа) */
  sensitive?: boolean;
}

export interface PiiModelDef {
  /** Имя модели Prisma (`User`) */
  model: string;
  /** Сущность в AAD */
  entity: string;
  fields: PiiFieldDef[];
  /** Поля строки, нужные для скоупа KEK (всегда добираются в select) */
  scopeFields: string[];
  /** Скоуп KEK по строке; `null` — данных не хватает (вызывающий дочитает строку) */
  scope: (row: Record<string, unknown>) => PiiScopeRef | null;
  /**
   * Тот же скоуп ДЕКЛАРАТИВНО — для фоновых джобов движка (перешивка после ротации KEK,
   * переиндексация): вид KEK и Prisma-поле с id владельца; у полиморфного владельца — по
   * записи на вид с дискриминатором. Обязан совпадать со `scope()` (страж на старте):
   * колонка вне реестра перешивки после ротации KEK стала бы нечитаемой.
   */
  keyScopes: PiiKeyScopeDecl[];
  /** Составные уникумы с полем ПДн → их двойники по слотам (`ownerType_ownerId_phone` → `…_phoneBi` / `…_phoneBiAlt`) */
  compoundUniques?: Record<string, { bi: string; biAlt: string; field: string }>;
}

export interface PiiBlindIndexPlan {
  slot: 0 | 1;
  value(index: string, normalized: string): string;
  pendingValue(index: string, normalized: string): string | null;
}

export interface PiiAccessEntry {
  entity: string;
  fields: string[];
  ids: string[];
  count: number;
}

export interface PiiHooks {
  readMode(): 'legacy' | 'encrypted';
  /**
   * Открытые колонки ещё существуют (окно dual-write): фильтры равенства ищут `bi` ИЛИ
   * («bi пуст» и открытый текст) — строка, записанная мимо слоя (скрипт, миграция,
   * ещё не бэкфиллена), не пропадает. После дропа открытых колонок — false (строгий bi).
   */
  plaintextPresent(): boolean;
  models: ReadonlyMap<string, PiiModelDef>;
  encrypt(scope: PiiScopeRef, ctx: { entity: string; field: string; ownerType: string; ownerId: string }, plain: string): Promise<string>;
  /** `null` — не расшифровалось (KEK заморожен/уничтожен, строка бита) */
  decrypt(scope: PiiScopeRef, ctx: { entity: string; field: string; ownerType: string; ownerId: string }, stored: string): Promise<string | null>;
  /** Прогреть KEK'и по списку kid (батч одной выборкой) */
  prefetch(kids: string[]): Promise<void>;
  kekKidOf(stored: string): string | null;
  /** Снимок слепого индекса на одну операцию: слот primary + значения (primary и, на окне смены, pending) */
  blindIndexPlan(): Promise<PiiBlindIndexPlan>;
  logAccess(entry: PiiAccessEntry): void;
  /** Модель по ту сторону relation-поля (DMMF) */
  relation(model: string, field: string): { model: string; isList: boolean } | null;
  /** Строка для скоупа при update по уникуму (select = scopeFields + id) */
  fetchScopeRow(model: string, where: unknown): Promise<Record<string, unknown> | null>;
  /** Сгенерировать id для create (скоуп человека = его же id) */
  newId(): string;
}

export const piiHooks: { current: PiiHooks | null } = { current: null };

export const PII_ENVELOPE_PREFIX = 'sa6e:';
