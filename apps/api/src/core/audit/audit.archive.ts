import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { Prisma } from '@prisma/client';
import type { SecurityPartitionManifestDto } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { KeysSigningService } from '../keys/keys.signing.service';
import { STORAGE_DRIVER, type StorageDriver } from '../files/storage/storage-driver';
import { AUDIT_REDIS } from './audit.constants';
import { AuditAlertsService } from './audit.alerts.service';
import { AUDIT_LEAF_VERSION, MerkleBuilder, auditLeafSql } from './audit.digests';
import { AuditPartitions } from './audit.partitions';
import { AuditService } from './audit.service';

const ARCHIVE_BATCH = 5_000;
const PARTITION_RE = /^security_events_\d{4}_\d{2}$/;

/** Срок хранения месяца в PostgreSQL, лет (env `AUDIT_RETENTION_YEARS`, пол — 3). */
export const auditRetentionYears = (): number => {
  const n = Number.parseInt(process.env.AUDIT_RETENTION_YEARS ?? '', 10);
  return Number.isInteger(n) && n >= 3 ? n : 3;
};
const archiveEnabled = () => process.env.AUDIT_ARCHIVE_ENABLED !== 'false';

export interface AuditArchiveResult {
  partition: string;
  rows: number;
  bytes: number;
  sha256: string;
  objectKey: string;
}

/**
 * Архив журнала безопасности (решение грилла №5): закрытый месяц выгружается в объектное
 * хранилище NDJSON+gzip (`audit/archive/<партиция>.ndjson.gz`) с подписанным манифестом
 * (sha256 файла, строки, диапазон, корень Меркла строк — Ed25519, аудитория `audit`). Месяц
 * живёт в базе `AUDIT_RETENTION_YEARS` (≥ 3) и сбрасывается ТОЛЬКО после успешной выгрузки:
 * перед сбросом архив сверяется с партицией заново (строки и корень) — расхождение = отказ
 * сброса + тревога `audit_degraded`. Пол «архив есть и старше 3 лет» держит и сама база
 * (`audit_drop_partition`), так что даже сбой этого кода не удалит невыгруженный месяц.
 */
@Injectable()
export class AuditArchiveService {
  private readonly logger = new Logger(AuditArchiveService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly partitions: AuditPartitions,
    private readonly signing: KeysSigningService,
    private readonly audit: AuditService,
    private readonly alerts: AuditAlertsService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  /** Раз в сутки: выгрузить закрытые месяцы без архива, сбросить отслужившие срок. */
  @Cron('23 2 * * *')
  async daily(): Promise<void> {
    if (!archiveEnabled()) return;
    await this.redis.withLock(AUDIT_REDIS.lock('archive'), 60 * 60_000, () => this.runNow());
  }

  async runNow(now = new Date()): Promise<{ archived: string[]; dropped: string[] }> {
    const archived: string[] = [];
    const dropped: string[] = [];
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const known = new Set((await this.db.securityPartitionArchive.findMany({ select: { partition: true } })).map((a) => a.partition));
    for (const p of await this.partitions.list()) {
      // Только ЗАКРЫТЫЕ месяцы: в текущий ещё пишут
      if (p.to > monthStart) continue;
      if (!known.has(p.name)) {
        try {
          await this.archive(p.name);
          archived.push(p.name);
        } catch (err) {
          this.logger.error(`archive of ${p.name} failed: ${(err as Error).message}`);
          await this.degraded();
          continue;
        }
      }
      const floor = new Date(Date.UTC(now.getUTCFullYear() - auditRetentionYears(), now.getUTCMonth(), 1));
      if (p.to <= floor && (await this.dropVerified(p.name))) dropped.push(p.name);
    }
    return { archived, dropped };
  }

  private async degraded(): Promise<void> {
    await this.alerts.raise({ kind: 'audit_degraded', severity: 'critical', dedupeKey: 'archive', finding: { failures: 1, windowMin: 60 * 24 }, platformEvent: 'auditDegraded' }).catch(() => undefined);
  }

  /** Строки партиции по порядку id — `to_jsonb` целиком (шифротексты IP/UA — как есть). */
  private async *rowsOf(partition: string, leafVersion: number): AsyncGenerator<{ json: string; leaf: Buffer }> {
    if (!PARTITION_RE.test(partition)) throw new Error(`audit archive: not a security_events partition: ${partition}`);
    const table = Prisma.raw(`"${partition}"`);
    const leaf = auditLeafSql(leafVersion);
    let after = '0';
    for (;;) {
      const rows = await this.db.$queryRaw<Array<{ id: string; j: string; h: Buffer }>>`
        SELECT id::text AS id, to_jsonb(e)::text AS j, ${leaf} AS h
        FROM ${table} e WHERE id > ${after}::bigint ORDER BY id LIMIT ${ARCHIVE_BATCH}`;
      for (const r of rows) yield { json: r.j, leaf: Buffer.from(r.h) };
      if (rows.length < ARCHIVE_BATCH) return;
      after = rows[rows.length - 1]!.id;
    }
  }

  /** Выгрузить месяц: NDJSON+gzip + манифест, подписанный Ed25519; строка реестра архивов. */
  async archive(partition: string): Promise<AuditArchiveResult> {
    if (!PARTITION_RE.test(partition)) throw new Error(`audit archive: not a security_events partition: ${partition}`);
    // Повтор — отдать то, что уже выгружено: объект в хранилище не перезаписывается никогда
    const existing = await this.db.securityPartitionArchive.findUnique({ where: { partition } });
    if (existing) return { partition, rows: existing.rows, bytes: Number(existing.bytes), sha256: existing.sha256, objectKey: existing.objectKey };
    const info = (await this.partitions.list()).find((p) => p.name === partition);
    if (!info) throw new Error(`audit archive: partition ${partition} does not exist`);
    const tmp = join(os.tmpdir(), `sa6-${partition}-${Date.now()}.ndjson.gz`);
    // Корень — потоково: месяц журнала не держится в памяти ни строками, ни хешами
    const leafVersion = AUDIT_LEAF_VERSION;
    const merkle = new MerkleBuilder();
    let rows = 0;
    const source = this.rowsOf(partition, leafVersion);
    async function* lines() {
      for await (const r of source) {
        rows++;
        merkle.push(r.leaf);
        yield `${r.json}\n`;
      }
    }
    const manifestTmp = `${tmp}.manifest.json`;
    try {
      await pipeline(Readable.from(lines()), createGzip({ level: 9 }), createWriteStream(tmp));
      const hash = createHash('sha256');
      await pipeline(createReadStream(tmp), hash);
      const sha256 = hash.digest('hex');
      const bytes = (await fs.stat(tmp)).size;
      const objectKey = `audit/archive/${partition}.ndjson.gz`;
      const manifestKey = `audit/archive/${partition}.manifest.json`;
      // Версия формата = версия формулы листа (корень пересчитывается перед сбросом той же формулой)
      const manifest = {
        format: `sa6-audit-archive:v${leafVersion}`,
        partition,
        from: info.from.toISOString(),
        to: info.to.toISOString(),
        rows,
        bytes,
        sha256,
        merkleRoot: merkle.root().toString('hex'),
        objectKey,
      };
      const payload = JSON.stringify(manifest);
      const signed = await this.signing.signRaw('audit', payload);
      await fs.writeFile(manifestTmp, JSON.stringify({ ...manifest, kid: signed.kid, signature: signed.sig }, null, 1));
      await this.storage.putFromFile(objectKey, tmp, 'application/gzip');
      await this.storage.putFromFile(manifestKey, manifestTmp, 'application/json');
      await this.db.securityPartitionArchive.create({
        data: { partition, fromAt: info.from, toAt: info.to, rows, bytes: BigInt(bytes), sha256, objectKey, manifestKey, signature: Uint8Array.from(Buffer.from(signed.sig, 'base64url')), kid: signed.kid, leafVersion },
      });
      await this.audit.record(null, { key: 'audit.partition.archived', actor: { kind: 'system' }, details: { partition, rows, bytes } });
      return { partition, rows, bytes, sha256, objectKey };
    } finally {
      await fs.unlink(tmp).catch(() => undefined);
      await fs.unlink(manifestTmp).catch(() => undefined);
    }
  }

  /**
   * Сброс отслужившего месяца — только если архив ВСЁ ЕЩЁ описывает партицию (строки и корень
   * Меркла совпадают): вставка задним числом или подмена после выгрузки сброс останавливают.
   */
  async dropVerified(partition: string): Promise<boolean> {
    const arch = await this.db.securityPartitionArchive.findUnique({ where: { partition } });
    if (!arch || arch.droppedAt) return false;
    const merkle = new MerkleBuilder();
    for await (const r of this.rowsOf(partition, arch.leafVersion)) merkle.push(r.leaf);
    const { manifest, signedOk } = await this.signedManifest(arch);
    if (!manifest || !signedOk || merkle.count !== arch.rows || manifest.merkleRoot !== merkle.root().toString('hex')) {
      this.logger.error(`audit archive of ${partition} no longer matches the partition — the drop is refused`);
      await this.degraded();
      return false;
    }
    const dropped = await this.partitions.drop(partition);
    if (dropped) await this.audit.record(null, { key: 'audit.partition.dropped', actor: { kind: 'system' }, details: { partition } });
    return dropped;
  }

  /**
   * Манифест месяца для консоли «Целостность»: файл из хранилища + проверка подписи той, что
   * записана в базе при выгрузке, + сверка строк/байт/хеша со строкой архива. Файла нет или он
   * не JSON — `null` (консоль показывает «не найден», а не 500).
   */
  async inspect(partition: string): Promise<SecurityPartitionManifestDto | null> {
    const arch = await this.db.securityPartitionArchive.findUnique({ where: { partition } });
    if (!arch) return null;
    const { manifest, signedOk } = await this.signedManifest(arch);
    if (!manifest) return null;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : -1);
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    return {
      partition,
      format: str(manifest.format),
      from: str(manifest.from),
      to: str(manifest.to),
      rows: num(manifest.rows),
      bytes: num(manifest.bytes),
      sha256: str(manifest.sha256),
      merkleRoot: str(manifest.merkleRoot),
      objectKey: str(manifest.objectKey),
      kid: arch.kid,
      archivedAt: arch.archivedAt.toISOString(),
      droppedAt: arch.droppedAt?.toISOString() ?? null,
      signatureOk: signedOk,
      matchesRecord: manifest.rows === arch.rows && manifest.bytes === Number(arch.bytes) && manifest.sha256 === arch.sha256 && manifest.objectKey === arch.objectKey,
    };
  }

  /** Манифест в хранилище обязан быть ТЕМ, что подписан при выгрузке (подпись — в базе, не в файле). */
  private async signedManifest(arch: { manifestKey: string; kid: string; signature: Uint8Array; archivedAt: Date }) {
    const manifest = await this.readManifest(arch.manifestKey).catch(() => null);
    if (!manifest) return { manifest: null, signedOk: false };
    const { kid: _kid, signature: _sig, ...body } = manifest;
    const check = await this.signing.verifyArchival('audit', { kid: arch.kid, data: JSON.stringify(body), sig: Buffer.from(arch.signature).toString('base64url'), signedAt: arch.archivedAt });
    return { manifest, signedOk: check.ok };
  }

  private async readManifest(key: string): Promise<{ merkleRoot: string; kid?: string; signature?: string } & Record<string, unknown>> {
    const obj = await this.storage.getStream(key);
    const chunks: Buffer[] = [];
    for await (const c of obj.stream) chunks.push(Buffer.from(c as Buffer));
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as { merkleRoot: string; kid?: string; signature?: string };
  }
}
