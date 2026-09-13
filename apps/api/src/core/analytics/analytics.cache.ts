/**
 * Кэш в памяти инстанса с TTL и потолком размера (вытесняется самая старая запись —
 * Map хранит порядок вставки). Для обогащения приёма: тариф субъекта, членство,
 * сведения о человеке. Не общий между инстансами намеренно: всё, что в нём лежит,
 * допускает минутную задержку.
 */
export class TtlCache<K, V> {
  private readonly map = new Map<K, { v: V; at: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}

  get(key: K): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.v;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, v: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { v, at: Date.now() });
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Кольцо последних id (дедуп ретраев ДО обращения к БД; уникум `(event_id, ts)` — второй ремень). */
export class RecentIds {
  private readonly ring: Array<string | undefined>;
  private readonly set = new Set<string>();
  private pos = 0;

  constructor(private readonly capacity: number) {
    this.ring = new Array<string | undefined>(capacity);
  }

  has(id: string): boolean {
    return this.set.has(id);
  }

  add(id: string): void {
    if (this.set.has(id)) return;
    const evicted = this.ring[this.pos];
    if (evicted !== undefined) this.set.delete(evicted);
    this.ring[this.pos] = id;
    this.set.add(id);
    this.pos = (this.pos + 1) % this.capacity;
  }
}
