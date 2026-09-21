import { AsyncLocalStorage } from 'node:async_hooks';

// ============================================================
// Привязка «эффект запроса закоммичен» к бизнес-транзакции сервиса.
//
// Живёт в `shared/`, а не в `core/idempotency`: её зовёт фабрика клиента базы
// (`shared/database`), а движки ядро НЕ импортирует. Сам движок читает и пишет
// то же состояние через ALS-контекст запроса.
//
// НЕСУЩЕЕ: отметка «эффект закоммичен» обязана лечь в ТУ ЖЕ транзакцию, что и
// сам эффект. Иначе остаётся щель: процесс умирает между коммитом эффекта и
// отметкой (или наоборот), и повтор получает ответ, не соответствующий правде.
// ============================================================

/** Состояние отметки в строке `idem.keys` глазами ЭТОГО запроса. */
export type IdemBindState = 'none' | 'pending' | 'bound';

/** Заявка запроса: что писать в отметку и что уже случилось. */
export interface IdemBinding {
  scopeHash: Buffer;
  keyHash: Buffer;
  /** Fencing-токен: отметку вправе поставить только ЭТА попытка */
  attempt: number;
  state: IdemBindState;
  /**
   * Эффект мог случиться ВНЕ отмеченной транзакции (запись без транзакции,
   * параллельная/вложенная транзакция, массивная форма `$transaction`).
   * Консервативно: ответ станет финальным, даже если эффекта не было.
   */
  dirty: boolean;
  /** Сколько транзакций запроса поставили отметку (обещание `atomic` = ровно одна) */
  markedTx: number;
  /** Владелец отметки сейчас в полёте — параллельные транзакции её не трогают */
  ownerActive: boolean;
}

export const newBinding = (scopeHash: Buffer, keyHash: Buffer, attempt: number): IdemBinding => ({
  scopeHash,
  keyHash,
  attempt,
  state: 'none',
  dirty: false,
  markedTx: 0,
  ownerActive: false,
});

/**
 * Попытка устарела: строку ключа перезахватил другой процесс (аренда истекла) либо
 * отметка уже стоит. Транзакция обязана откатиться — иначе эффект случится дважды.
 */
export class IdempotencyFencedError extends Error {
  constructor() {
    super('idempotency: the attempt is stale, the transaction must roll back');
    this.name = 'IdempotencyFencedError';
  }
}

/** Контекст ОДНОЙ транзакции запроса (живёт в своём ALS, а не в контексте запроса). */
interface TxScope {
  /** Эта транзакция ставит отметку (первая callback-транзакция запроса) */
  owner: boolean;
  /** Отметка уже поставлена в этой транзакции */
  marked: boolean;
  /** В этой транзакции были записи (для НЕ-владельца = `dirty` на коммите) */
  wrote: boolean;
  /**
   * Отметка в полёте либо уже легла. ПАРАЛЛЕЛЬНЫЕ операции той же транзакции
   * (`Promise.all` внутри колбэка) ждут этот промис: правило «отметка ПЕРЕД первой
   * записью» обязано выполняться буквально, а не «как повезёт с порядком микрозадач».
   */
  marking?: Promise<void>;
  /**
   * Отметка НЕ легла (попытка устарела либо база отказала). Запоминается здесь, а не
   * только бросается: сервис вправе проглотить ошибку своей записи (`.catch(() => null)`,
   * `allSettled`), и тогда транзакция закоммитила бы эффект УСТАРЕВШЕЙ попытки —
   * двойной эффект ровно там, где fencing обязан его остановить.
   */
  markError?: unknown;
  /** Клиент транзакции: из него исполняется UPDATE отметки */
  tx?: TxLike;
}

/** Минимум, который нужен от транзакционного клиента (без зависимости от Prisma-типов). */
export interface TxLike {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

const txScope = new AsyncLocalStorage<TxScope>();

/**
 * Служебные запросы САМОГО движка (заявка, аренда, финализация, снимок, keystore).
 * Они идут по тому же клиенту базы и в том же контексте запроса — без этой пометки
 * каждое продление аренды помечало бы запрос как «писал мимо транзакции» (`dirty`).
 */
const internalScope = new AsyncLocalStorage<true>();

/** Исполнить работу движка так, чтобы её запросы не считались эффектом запроса. */
export function runInternal<T>(fn: () => Promise<T>): Promise<T> {
  return internalScope.run(true, fn);
}

/** Операции Prisma, которые МОГУТ изменить данные (`$queryRaw` — консервативно: он тоже умеет писать). */
const WRITE_OPERATIONS = new Set<string>([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  '$executeRaw',
  '$executeRawUnsafe',
  '$queryRaw',
  '$queryRawUnsafe',
  'executeRaw',
  'executeRawUnsafe',
  'queryRaw',
  'queryRawUnsafe',
]);

export const isWriteOperation = (operation: string): boolean => WRITE_OPERATIONS.has(operation);

/**
 * SQL отметки. Идёт ПЕРЕД первой записью транзакции и в ТОЙ ЖЕ транзакции:
 * `state='in_progress' AND attempt=$a` — status-guarded, 0 строк = попытка устарела.
 * Строка ключа остаётся заблокированной до конца транзакции, поэтому перезахват
 * другим процессом не может обогнать коммит эффекта.
 */
async function markCommitted(tx: TxLike, b: IdemBinding): Promise<void> {
  const n = await tx.$executeRawUnsafe(
    `UPDATE idem.keys SET state = 'committed', last_seen_at = (now() AT TIME ZONE 'UTC')
     WHERE scope_hash = $1 AND key_hash = $2 AND attempt = $3 AND state = 'in_progress'`,
    b.scopeHash,
    b.keyHash,
    b.attempt,
  );
  if (n === 0) throw new IdempotencyFencedError();
}

/**
 * Хук расширения Prisma на КАЖДУЮ операцию. Зовётся из фабрики клиента базы и
 * возвращается только тогда, когда отметка (если её пора ставить) уже легла.
 *
 * `inTx` — операция идёт ПО ТРАНЗАКЦИОННОМУ клиенту (`__internalParams.transaction`
 * Prisma). `false` внутри колбэка транзакции = сервис взял КОРНЕВОЙ клиент посреди
 * чужой транзакции: такая запись коммитится сама по себе и откат её не снимет.
 * `undefined` — Prisma признака не дал (будущая версия): поведение прежнее.
 */
export async function beforeOperation(
  binding: IdemBinding | undefined,
  operation: string,
  inTx?: boolean,
): Promise<void> {
  if (!binding || !isWriteOperation(operation)) return;
  if (internalScope.getStore()) return;
  const scope = txScope.getStore();

  if (!scope || inTx === false) {
    // Запись ВНЕ транзакции: привязать отметку не к чему — ответ станет финальным
    binding.dirty = true;
    return;
  }
  if (!scope.owner) {
    // Вложенная либо параллельная транзакция запроса: второй UPDATE той же строки с
    // ДРУГОГО соединения — само-дедлок, невидимый для Postgres. Отметку не трогаем.
    scope.wrote = true;
    return;
  }
  if (scope.marking) {
    // Отметка уже в полёте (параллельная операция той же транзакции) либо легла:
    // ждём её исход. Отказ отметки получает КАЖДАЯ операция, а не только первая.
    scope.wrote = true;
    await scope.marking;
    return;
  }
  if (!scope.tx) {
    scope.wrote = true;
    return;
  }
  scope.marked = true; // ставим ДО await: вложенный вызов не должен зайти второй раз
  const tx = scope.tx;
  // Сама отметка идёт через то же расширение — `internalScope` выводит её из учёта.
  // Именно ALS, а не флаг на scope: флаг увидели бы и ПАРАЛЛЕЛЬНЫЕ операции той же
  // транзакции и прошли бы мимо отметки, не дождавшись её.
  scope.marking = internalScope.run(true, () => markCommitted(tx, binding)).catch((err: unknown) => {
    scope.markError = err;
    throw err;
  });
  await scope.marking;
  binding.state = 'pending';
}

/**
 * Обёртка `$transaction`. Вне запроса с заявкой (джобы, крон, бутстрап) — СТРОГИЙ no-op:
 * ни лишнего запроса, ни ветвления.
 */
export function wrapTransaction<T extends (...args: never[]) => unknown>(
  original: T,
  getBinding: () => IdemBinding | undefined,
): T {
  const wrapped = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const binding = getBinding();
    const call = original as unknown as (...a: unknown[]) => Promise<unknown>;
    // Служебная транзакция САМОГО движка (`runInternal`) владельцем отметки не бывает
    if (!binding || internalScope.getStore()) return call.apply(this, args);

    const [arg, options] = args;
    if (typeof arg !== 'function') {
      // Массивная форма: своего оператора в неё не вставить. Записи внутри пройдут
      // через расширение уже с `dirty` (своего scope у них нет) — этого довольно.
      return call.apply(this, args);
    }

    const outer = txScope.getStore();
    const owner = !outer && !binding.ownerActive && binding.state === 'none';
    if (owner) binding.ownerActive = true;
    const scope: TxScope = { owner, marked: false, wrote: false };
    let committed = false;
    try {
      const body = (tx: TxLike) =>
        txScope.run(scope, async () => {
          scope.tx = tx;
          const out = await (arg as (t: TxLike) => unknown)(tx);
          // Отметка не легла, а сервис ошибку проглотил — коммитить НЕЛЬЗЯ: это эффект
          // устаревшей попытки. Бросаем из колбэка — Prisma откатит транзакцию.
          if (scope.markError !== undefined) throw scope.markError;
          return out;
        });
      const result = await call.apply(this, [body, options]);
      committed = true;
      if (scope.marked) {
        binding.state = 'bound';
        binding.markedTx += 1;
      } else if (scope.wrote) {
        binding.dirty = true;
      }
      return result;
    } finally {
      // Откат снял отметку вместе с эффектом — состояние возвращается к «ничего не было»
      if (!committed && scope.marked && binding.state === 'pending') binding.state = 'none';
      if (owner) binding.ownerActive = false;
    }
  };
  return wrapped as unknown as T;
}
