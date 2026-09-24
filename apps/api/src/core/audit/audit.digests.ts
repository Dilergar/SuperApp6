import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { Prisma, type SecurityDigest } from '@prisma/client';
import { type SecurityDigestVerifyDto, uuidv7 } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { KeysSigningService } from '../keys/keys.signing.service';
import { STORAGE_DRIVER, type StorageDriver } from '../files/storage/storage-driver';
import { AUDIT_REDIS } from './audit.constants';
import { AuditAlertsService } from './audit.alerts.service';
import { AuditMetrics } from './audit.metrics';
import { AuditService } from './audit.service';

const sha256 = (...parts: Buffer[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);

/**
 * Корень дерева Меркла по RFC 6962 (Certificate Transparency): лист = SHA-256(0x00 ‖ d),
 * узел = SHA-256(0x01 ‖ левый ‖ правый), разбиение по наибольшей степени двойки меньше n.
 * Разделение доменов листа и узла не даёт выдать узел за лист (атака второго прообраза).
 *
 * ПОТОКОВО: стек полных поддеревьев убывающих степеней двойки (как двоичный счётчик) — память
 * O(log n), а не все листья: месяц журнала — сотни миллионов строк, массив хешей не влез бы в
 * процесс. Корень — свёртка стека справа налево: ровно разбиение RFC 6962 (k — наибольшая
 * степень двойки < n — и есть левое поддерево стека).
 */
export class MerkleBuilder {
  private readonly stack: Array<{ hash: Buffer; size: number }> = [];
  private n = 0;

  push(data: Buffer): void {
    let node = { hash: sha256(LEAF, data), size: 1 };
    while (this.stack.length && this.stack[this.stack.length - 1]!.size === node.size) {
      const left = this.stack.pop()!;
      node = { hash: sha256(NODE, left.hash, node.hash), size: left.size * 2 };
    }
    this.stack.push(node);
    this.n++;
  }

  get count(): number {
    return this.n;
  }

  root(): Buffer {
    if (!this.stack.length) return sha256(Buffer.alloc(0));
    let acc = this.stack[this.stack.length - 1]!.hash;
    for (let i = this.stack.length - 2; i >= 0; i--) acc = sha256(NODE, this.stack[i]!.hash, acc);
    return acc;
  }
}

export function merkleRoot(leaves: Iterable<Buffer>): Buffer {
  const b = new MerkleBuilder();
  for (const l of leaves) b.push(l);
  return b.root();
}

/**
 * Версии формулы листа (колонка `leaf_version` дайджеста и архива):
 *  1 — `to_jsonb(e)` без шифротекстов: НОВАЯ колонка журнала (даже пустая) меняла текст строки
 *      и роняла проверку всех прошлых дайджестов и сброс архивов;
 *  2 — то же через `jsonb_strip_nulls`: пустая новая колонка лист не меняет. Правило схемы:
 *      новая колонка `security_events` — только с NULL по умолчанию (docs/audit_engine.md);
 *  3 — формула v2 и ЧИСЛОВОЙ порядок листьев `(xact, id)`. В v1–v2 запрос выбирал
 *      `xact::text AS xact, id::text AS id` и сортировал `ORDER BY xact, id` — Postgres берёт
 *      одноимённую ВЫХОДНУЮ колонку, то есть текст: на переходе 999 999 → 1 000 000 порядок
 *      расходился с числовым (независимая проверка корня падала), а курсор страницы сравнивал
 *      числа — окно больше страницы теряло строки. Дайджесты v1–v2 проверяются своим порядком:
 *      их подписанный корень посчитан по нему.
 * Формулы — константы кода (никакого ввода): `Prisma.raw` безопасен.
 */
export const AUDIT_LEAF_VERSION = 3;
/** Строка страницы листьев: курсор (xact, id) текстом, момент события, хеш листа */
type LeafRow = { xact: string; id: string; at: Date; h: Buffer };
/** Версии, чей корень посчитан в ТЕКСТОВОМ порядке листьев (наследие, только для проверки) */
export const auditLegacyTextOrder = (version: number): boolean => version <= 2;
export function auditLeafSql(version: number): Prisma.Sql {
  return version === 1
    ? Prisma.raw(`sha256(convert_to((to_jsonb(e) - 'ip_enc' - 'ua_raw_enc')::text, 'UTF8'))`)
    : Prisma.raw(`sha256(convert_to(jsonb_strip_nulls(to_jsonb(e) - 'ip_enc' - 'ua_raw_enc')::text, 'UTF8'))`);
}

/** Интервал дайджестов, минут (env `AUDIT_DIGEST_INTERVAL_MIN`, пусто = 5). */
export const auditDigestIntervalMin = (): number => {
  const n = Number.parseInt(process.env.AUDIT_DIGEST_INTERVAL_MIN ?? '', 10);
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : 5;
};

/** Сколько строк читать за один запрос при сборе листьев */
const LEAF_BATCH = 5_000;

interface Leaves {
  count: number;
  root: Buffer;
  firstAt: Date | null;
  lastAt: Date | null;
}

/**
 * Подписанные дайджесты целостности журнала (NIST AU-9/AU-10). Каждые N минут: окно по
 * курсору транзакций `xact` — [конец прошлого дайджеста, xmin текущего снимка): всё, что
 * ниже xmin, уже зафиксировано или откатилось, и в окно задним числом ничего не упадёт.
 * Лист — SHA-256 канонического jsonb строки БЕЗ `ip_enc`/`ua_raw_enc` (их перешивает ротация
 * KEK). Корень Меркла + цепочка (хеш прошлого дайджеста) подписываются Ed25519 (аудитория
 * `audit`, архивная проверка — годами). Копия дайджеста уходит в объектное хранилище
 * (`exported_at`) — улика вне базы: подменить журнал И дайджест одной SQL-сессией нельзя.
 */
@Injectable()
export class AuditDigestService {
  private readonly logger = new Logger(AuditDigestService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly signing: KeysSigningService,
    private readonly audit: AuditService,
    private readonly alerts: AuditAlertsService,
    private readonly metrics: AuditMetrics,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    await this.redis.withLock(AUDIT_REDIS.lock('digest'), 4 * 60_000, async () => {
      const last = await this.db.securityDigest.findFirst({ orderBy: { xactTo: 'desc' }, select: { signedAt: true } });
      // Отставание целостности — метрика (алерт мониторинга: долгая транзакция держит xmin)
      if (last) this.metrics.digestLagSeconds.set(Math.max(0, Math.round((Date.now() - last.signedAt.getTime()) / 1000)));
      if (last && Date.now() - last.signedAt.getTime() < auditDigestIntervalMin() * 60_000) return;
      await this.run();
    });
  }

  /**
   * Листья окна [from, to) по порядку (xact, id) — хеш считает база (jsonb детерминирован),
   * корень — потоково: окно после долгой транзакции бывает часами журнала.
   */
  async leaves(from: bigint, to: bigint, version: number = AUDIT_LEAF_VERSION): Promise<Leaves> {
    const merkle = new MerkleBuilder();
    const leaf = auditLeafSql(version);
    let firstAt: Date | null = null;
    let lastAt: Date | null = null;
    let cursor: { xact: string; id: string } | null = null;
    for (;;) {
      const rows: LeafRow[] = auditLegacyTextOrder(version) ? await this.legacyTextPage(leaf, from, to, cursor) : await this.numericPage(leaf, from, to, cursor);
      for (const r of rows) {
        merkle.push(Buffer.from(r.h));
        if (!firstAt || r.at < firstAt) firstAt = r.at;
        if (!lastAt || r.at > lastAt) lastAt = r.at;
      }
      if (rows.length < LEAF_BATCH) break;
      const tail = rows[rows.length - 1]!;
      cursor = { xact: tail.xact, id: tail.id };
    }
    return { count: merkle.count, root: merkle.root(), firstAt, lastAt };
  }

  /** Страница листьев v3: числовой порядок `(xact, id)` — колонки таблицы, не выходные псевдонимы */
  private async numericPage(leaf: Prisma.Sql, from: bigint, to: bigint, cursor: { xact: string; id: string } | null): Promise<LeafRow[]> {
    const after: Prisma.Sql = cursor ? Prisma.sql`AND (e.xact, e.id) > (${cursor.xact}::xid8, ${cursor.id}::bigint)` : Prisma.empty;
    const rows = await this.db.$queryRaw<Array<{ x: string; i: string; at: Date; h: Buffer }>>`
      SELECT e.xact::text AS x, e.id::text AS i, e.occurred_at AS at, ${leaf} AS h
      FROM security_events e
      WHERE e.xact >= ${from.toString()}::xid8 AND e.xact < ${to.toString()}::xid8 ${after}
      ORDER BY e.xact, e.id LIMIT ${LEAF_BATCH}`;
    return rows.map((r) => ({ xact: r.x, id: r.i, at: r.at, h: r.h }));
  }

  /**
   * Страница листьев v1–v2 ровно тем запросом, которым их корень был подписан (текстовый
   * порядок выходных колонок) — только для проверки прошлых дайджестов; новые пишутся v3.
   */
  private legacyTextPage(leaf: Prisma.Sql, from: bigint, to: bigint, cursor: { xact: string; id: string } | null): Promise<LeafRow[]> {
    const after: Prisma.Sql = cursor ? Prisma.sql`AND (xact, id) > (${cursor.xact}::xid8, ${cursor.id}::bigint)` : Prisma.empty;
    return this.db.$queryRaw<LeafRow[]>`
      SELECT xact::text AS xact, id::text AS id, occurred_at AS at, ${leaf} AS h
      FROM security_events e
      WHERE xact >= ${from.toString()}::xid8 AND xact < ${to.toString()}::xid8 ${after}
      ORDER BY xact, id LIMIT ${LEAF_BATCH}`;
  }

  /** Хеш дайджеста для цепочки: следующий подписывает его как `prev`. */
  static chainHash(d: Pick<SecurityDigest, 'id' | 'xactFrom' | 'xactTo' | 'count' | 'merkleRoot' | 'signature'>): Buffer {
    return sha256(Buffer.from(`${d.id}|${d.xactFrom}|${d.xactTo}|${d.count}|${Buffer.from(d.merkleRoot).toString('hex')}|${Buffer.from(d.signature).toString('base64url')}`, 'utf8'));
  }

  /**
   * Подписываемая строка дайджеста (версионирована: формат меняется только новой версией).
   * Версия строки = версия формулы листа: подпись закрепляет и то, КАК считались листья.
   */
  static payload(d: { version: number; xactFrom: bigint; xactTo: bigint; count: number; firstAt: Date | null; lastAt: Date | null; root: Buffer; prev: Buffer | null }): string {
    return [`sa6-audit-digest:v${d.version}`, d.xactFrom, d.xactTo, d.count, d.firstAt?.toISOString() ?? '', d.lastAt?.toISOString() ?? '', d.root.toString('hex'), d.prev?.toString('hex') ?? ''].join('|');
  }

  /** Собрать и подписать дайджест нового окна; пустое окно — ничего (следующий прогон его накроет). */
  async run(): Promise<SecurityDigest | null> {
    const last = await this.db.securityDigest.findFirst({ orderBy: { xactTo: 'desc' } });
    const from = last?.xactTo ?? 0n;
    const [{ xmin }] = await this.db.$queryRaw<Array<{ xmin: string }>>`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`;
    const to = BigInt(xmin);
    if (to < from) {
      // xmin снимка внутри ОДНОГО кластера назад не ходит. Меньше конца прошлого окна — значит,
      // база перенесена логически (pg_dump → pg_restore) в новый кластер со свежим счётчиком:
      // окна по xid8 больше не продолжают цепочку, и новые строки журнала молча выпадали бы из
      // целостности. Тревога CRITICAL (одна на окно), лечение — сдвиг счётчика до открытия
      // трафика (`pg_resetwal -x`, как делает pg_upgrade), рунбук docs/operations_backup_dr.md.
      this.logger.error(`audit digest chain cannot continue: snapshot xmin ${to} is below the last digest end ${from} (logical restore into a new cluster?)`);
      await this.alerts
        .raise({ kind: 'digest_gap', severity: 'critical', dedupeKey: `xid:${from}`, finding: { events: 1, windowMin: 1 }, platformEvent: 'digestGap' })
        .catch((err: unknown) => this.logger.error(`digest_gap alert was not raised: ${err instanceof Error ? err.message : String(err)}`));
      return null;
    }
    if (to === from) return null;
    const version = AUDIT_LEAF_VERSION;
    const leaves = await this.leaves(from, to, version);
    if (!leaves.count) return null;
    const root = leaves.root;
    const prev = last ? AuditDigestService.chainHash(last) : null;
    const payload = AuditDigestService.payload({ version, xactFrom: from, xactTo: to, count: leaves.count, firstAt: leaves.firstAt, lastAt: leaves.lastAt, root, prev });
    const signed = await this.signing.signRaw('audit', payload);
    const id = uuidv7();
    let row: SecurityDigest;
    try {
      row = await this.db.securityDigest.create({
        data: {
          id,
          xactFrom: from,
          xactTo: to,
          firstAt: leaves.firstAt,
          lastAt: leaves.lastAt,
          count: leaves.count,
          merkleRoot: Uint8Array.from(root),
          prevDigestHash: prev ? Uint8Array.from(prev) : null,
          signature: Uint8Array.from(Buffer.from(signed.sig, 'base64url')),
          kid: signed.kid,
          leafVersion: version,
        },
      });
    } catch (err) {
      // Уникум xact_from: соседний инстанс уже подписал это окно
      if ((err as { code?: string }).code === 'P2002') return null;
      throw err;
    }
    this.metrics.digestLagSeconds.set(0);
    await this.audit.record(null, { key: 'audit.digest.created', actor: { kind: 'system' }, details: { digestId: id.replace(/-/g, ''), rows: row.count } });
    await this.exportCopy(row, payload, signed.sig).catch((err: unknown) => this.logger.warn(`digest ${id} copy was not exported: ${err instanceof Error ? err.message : String(err)}`));
    return row;
  }

  /** Копия дайджеста вне базы: `audit/digests/<yyyy>/<mm>/<id>.json` в объектном хранилище. */
  private async exportCopy(row: SecurityDigest, payload: string, sig: string): Promise<void> {
    const at = row.signedAt;
    const key = `audit/digests/${at.getUTCFullYear()}/${String(at.getUTCMonth() + 1).padStart(2, '0')}/${row.id}.json`;
    const tmp = join(os.tmpdir(), `sa6-digest-${row.id}.json`);
    await fs.writeFile(tmp, JSON.stringify({ id: row.id, payload, kid: row.kid, signature: sig, signedAt: at.toISOString() }, null, 1));
    try {
      await this.storage.putFromFile(key, tmp, 'application/json');
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
    }
    await this.db.securityDigest.update({ where: { id: row.id }, data: { exportedAt: new Date() } });
  }

  /**
   * Проверка дайджестов, подписанных в окне [from, to]: пересчёт листьев и корня, подпись
   * (архивная — годами, со сверкой окна жизни ключа) и цепочка к предыдущему. Расхождение —
   * `audit.digest.failed` + тревога `digest_mismatch` (CRITICAL) владельцам платформы.
   */
  async verify(from: Date, to: Date): Promise<SecurityDigestVerifyDto> {
    const digests = await this.db.securityDigest.findMany({ where: { signedAt: { gte: from, lte: to } }, orderBy: { xactFrom: 'asc' } });
    const mismatched: SecurityDigestVerifyDto['mismatched'] = [];
    let rows = 0;
    for (const d of digests) {
      const reason = await this.verifyOne(d);
      rows += d.count;
      await this.db.securityDigest.update({ where: { id: d.id }, data: { verifiedAt: new Date(), verifyOk: reason === null } });
      if (reason) mismatched.push({ digestId: d.id, reason });
    }
    const ok = mismatched.length === 0;
    const window = { from: from.toISOString(), to: to.toISOString() };
    if (ok) {
      await this.audit.record(null, { key: 'audit.digest.verified', actor: { kind: 'system' }, details: { digests: digests.length, rows, ...window } });
    } else {
      const ev = await this.audit.record(null, { key: 'audit.digest.failed', actor: { kind: 'system' }, details: { digests: digests.length, mismatched: mismatched.length, ...window } });
      await this.alerts.raise({
        kind: 'digest_mismatch',
        severity: 'critical',
        dedupeKey: `digest:${mismatched[0]!.digestId}`,
        evidence: [ev.id],
        finding: { events: mismatched.length, rows, windowMin: Math.max(1, Math.round((to.getTime() - from.getTime()) / 60_000)) },
        platformEvent: 'digestMismatch',
      });
    }
    return { digests: digests.length, rows, ok, mismatched };
  }

  /** null — дайджест цел; иначе код причины. */
  private async verifyOne(d: SecurityDigest): Promise<string | null> {
    const prevRow = d.xactFrom > 0n ? await this.db.securityDigest.findFirst({ where: { xactTo: d.xactFrom } }) : null;
    const prev = prevRow ? AuditDigestService.chainHash(prevRow) : null;
    const expectedPrev = d.prevDigestHash ? Buffer.from(d.prevDigestHash) : null;
    if ((prev && (!expectedPrev || !prev.equals(expectedPrev))) || (!prev && expectedPrev)) return 'chain';
    const leaves = await this.leaves(d.xactFrom, d.xactTo, d.leafVersion);
    if (leaves.count !== d.count) return 'count';
    const root = leaves.root;
    if (!root.equals(Buffer.from(d.merkleRoot))) return 'root';
    const payload = AuditDigestService.payload({ version: d.leafVersion, xactFrom: d.xactFrom, xactTo: d.xactTo, count: d.count, firstAt: d.firstAt, lastAt: d.lastAt, root, prev: expectedPrev });
    const sig = await this.signing.verifyArchival('audit', { kid: d.kid, data: payload, sig: Buffer.from(d.signature).toString('base64url'), signedAt: d.signedAt });
    return sig.ok ? null : `signature_${sig.reason ?? 'invalid'}`;
  }
}
