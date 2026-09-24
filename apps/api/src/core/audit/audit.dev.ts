import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AUDIT_CATEGORY_CODE, AUDIT_REGISTRY, AUDIT_SEVERITY_CODE, isAuditEventKey } from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { forbidden } from '../../shared/errors/api-error';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { AUDIT_REDIS } from './audit.constants';
import { AuditPartitions } from './audit.partitions';
import { AuditLoginGuard } from './audit.login-guard';
import { AuditService } from './audit.service';
import { AuditViewedService } from './audit.viewed';
import { AuditDigestService } from './audit.digests';
import { AuditArchiveService } from './audit.archive';
import { AuditDetections } from './audit.detections';
import { AuditCron } from './audit.cron';
import { AuditSettingsCheck } from './audit.settings';

const seedBody = z
  .object({
    key: z.string().refine(isAuditEventKey, 'unknown key'),
    subjectUserId: z.string().uuid().optional(),
    workspaceId: z.string().uuid().optional(),
    daysAgo: z.number().int().min(0).max(4000),
    details: z.record(z.unknown()).optional(),
    /** Системное событие по поручению человека (проекция актора «Система · инициатор») */
    onBehalfOfId: z.string().uuid().optional(),
  })
  .strict();
const probeBody = z.object({ rollback: z.boolean() }).strict();
const settingsCheckBody = z.object({ archiveEnabled: z.boolean().optional() }).strict();
const unlockBody = z.object({ userId: z.string().uuid() }).strict();
const verifyBody = z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }).strict();
const detectSeedBody = z
  .object({
    kind: z.enum(['password_spray', 'bruteforce_ip', 'otp_fatigue', 'mass_export', 'credential_stuffing']),
    // mass_export внутри организации: событие-причина её журнала (уведомление владельцу)
    org: z.object({ workspaceId: z.string().uuid(), eventId: z.string().regex(/^\d{1,19}$/) }).strict().optional(),
  })
  .strict();
const archiveBody = z.object({ partition: z.string().regex(/^security_events_\d{4}_\d{2}$/) }).strict();

/**
 * Дев-полигон журнала (только development/test, модуль регистрирует его лишь в dev):
 * партиции, запись в транзакции и откат, событие «в прошлом» для проверки окон зрителей.
 * Журнал append-only и в dev: «сдвинуть» строку нельзя — полигон ВСТАВЛЯЕТ синтетическое
 * событие с моментом в прошлом (партиция месяца заводится функцией владельца).
 */
@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit/dev')
export class AuditDevController {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly partitions: AuditPartitions,
    private readonly loginGuard: AuditLoginGuard,
    private readonly viewed: AuditViewedService,
    private readonly digests: AuditDigestService,
    private readonly archive: AuditArchiveService,
    private readonly detections: AuditDetections,
    private readonly cron: AuditCron,
    private readonly settings: AuditSettingsCheck,
  ) {}

  private assertDev(): void {
    if (!isDevEnv()) throw forbidden('dev.developmentOnly');
  }

  @Get('partitions')
  @ApiOperation({ summary: '[dev] Security log partitions' })
  async listPartitions() {
    this.assertDev();
    await this.partitions.ensureAhead();
    return { success: true, data: (await this.partitions.list()).map((p) => ({ name: p.name, from: p.from.toISOString(), to: p.to.toISOString() })) };
  }

  /** Запись в транзакции факта: rollback=true — факт откатывается, события быть не должно. */
  @Post('tx-probe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Record an event inside a transaction and optionally roll it back' })
  async txProbe(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const { rollback } = probeBody.parse(body);
    let eventId: string | null = null;
    try {
      await this.db.$transaction(async (tx) => {
        const r = await this.audit.record(tx, { key: 'account.settings_changed', subjectUserId: user.sub, details: { sessionMaxIdleDays: 90 } });
        eventId = r.eventId;
        if (rollback) throw new Error('dev rollback');
      });
    } catch (err) {
      if ((err as Error).message !== 'dev rollback') throw err;
    }
    const found = eventId ? await this.db.securityEvent.count({ where: { eventId } }) : 0;
    return { success: true, data: { eventId, persisted: found > 0 } };
  }

  /** Снять блокировку входа (сьюта проверяет блокировку на suite3 и снимает её в finally). */
  @Post('unlock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Lift a sign-in lockout (suite3 lockout checks)' })
  async unlock(@Body() body: unknown) {
    this.assertDev();
    const { userId } = unlockBody.parse(body);
    const unlocked = await this.db.$transaction((tx) => this.loginGuard.unlockTx(tx, userId));
    // Потолок «Это не я» (3 в час) — частые прогоны сьюта упирались бы в него
    await this.redis.getClient().del(AUDIT_REDIS.notMe(userId)).catch(() => undefined);
    return { success: true, data: { unlocked } };
  }

  /** Сбросить агрегат «кто смотрел журнал» сейчас, включая текущий час (крон ждёт конца часа). */
  @Post('viewed-flush')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Flush the “who viewed the log” aggregate including the current hour' })
  async viewedFlush() {
    this.assertDev();
    return { success: true, data: { written: await this.viewed.flush(Date.now() + 3_600_000) } };
  }

  /** Дайджест целостности сейчас (крон ждёт интервала). */
  @Post('digest/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Build and sign a digest of the new log window now' })
  async digestRun() {
    this.assertDev();
    const d = await this.digests.run();
    return { success: true, data: d ? { id: d.id, count: d.count, xactFrom: d.xactFrom.toString(), xactTo: d.xactTo.toString() } : null };
  }

  @Post('digest/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Verify digests signed in a window' })
  async digestVerify(@Body() body: unknown) {
    this.assertDev();
    const { from, to } = verifyBody.parse(body);
    return { success: true, data: await this.digests.verify(new Date(from), new Date(to)) };
  }

  /** Выгрузить закрытый месяц в архив (без сброса: сброс — только по сроку, пол держит база). */
  @Post('archive/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Archive one closed month of the log (NDJSON+gzip + signed manifest)' })
  async archiveRun(@Body() body: unknown) {
    this.assertDev();
    const { partition } = archiveBody.parse(body);
    return { success: true, data: await this.archive.archive(partition) };
  }

  /** Минутный тик детекций сейчас (подстановка учёток, деградация журнала). */
  @Post('detect/tick')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Run the minute detection tick now' })
  async detectTick() {
    this.assertDev();
    return { success: true, data: await this.detections.tickNow(Date.now() + 60_000) };
  }

  /** Посев правила детекции синтетическими событиями (без 20 настоящих неудачных входов). */
  @Post('detect/seed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Seed a detection rule with synthetic events and return the alert dedupe key' })
  async detectSeed(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const { kind, org } = detectSeedBody.parse(body);
    const r = await this.detections.seed(kind, user.sub, org);
    const alert = await this.db.securityAlert.findFirst({ where: { kind, dedupeKey: r.dedupeKey }, orderBy: { openedAt: 'desc' }, select: { id: true, severity: true, status: true, hits: true } });
    return { success: true, data: { ...r, alert } };
  }

  /**
   * Сверка настроек журнала сейчас (как на старте). `archiveEnabled` — подменить одну
   * настройку на время сверки (проверка «смена записывается»): окружение процесса
   * возвращается сразу после, и следующий вызов записывает возврат.
   */
  @Post('settings/check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Compare security log settings with the journal now' })
  async settingsCheck(@Body() body: unknown) {
    this.assertDev();
    const input = settingsCheckBody.parse(body ?? {});
    const saved = process.env.AUDIT_ARCHIVE_ENABLED;
    if (input.archiveEnabled !== undefined) process.env.AUDIT_ARCHIVE_ENABLED = input.archiveEnabled ? 'true' : 'false';
    try {
      return { success: true, data: { written: await this.settings.check() } };
    } finally {
      if (saved === undefined) delete process.env.AUDIT_ARCHIVE_ENABLED;
      else process.env.AUDIT_ARCHIVE_ENABLED = saved;
    }
  }

  /** Чистка закрытых тревог старше срока сейчас (ночной крон). */
  @Post('alerts/purge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Purge closed security alerts past retention now' })
  async alertsPurge() {
    this.assertDev();
    return { success: true, data: { purged: await this.cron.alertsNow() } };
  }

  /** Синтетическое событие в прошлом (окна зрителей: 365 дней человека, окно тарифа организации). */
  @Post('seed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Insert a synthetic past security event (window checks)' })
  async seed(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const input = seedBody.parse(body);
    const def = AUDIT_REGISTRY[input.key as keyof typeof AUDIT_REGISTRY];
    const at = new Date(Date.now() - input.daysAgo * 86_400_000);
    await this.partitions.ensureFor(at);
    const subject = input.subjectUserId ?? user.sub;
    const row = await this.db.securityEvent.create({
      data: {
        occurredAt: at,
        txAt: at,
        eventKey: input.key,
        category: AUDIT_CATEGORY_CODE[def.category],
        severity: AUDIT_SEVERITY_CODE[def.severity],
        outcome: 0,
        actorKind: 3,
        onBehalfOfId: input.onBehalfOfId ?? null,
        subjectUserId: subject,
        workspaceId: input.workspaceId ?? null,
        visSubject: def.visibility.subject,
        visWorkspace: def.visibility.workspace && !!input.workspaceId,
        details: (input.details ?? {}) as object,
        reasonCode: 'dev_seed',
      },
      select: { id: true, eventId: true },
    });
    return { success: true, data: { id: row.id.toString(), eventId: row.eventId, occurredAt: at.toISOString() } };
  }
}
