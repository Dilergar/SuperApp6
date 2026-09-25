import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  lifecycleBackupReportSchema,
  type LifecycleDataBackupsDto,
  type LifecycleDataCanaryDto,
  type LifecycleDataErasureDto,
  type LifecycleDataOverviewDto,
  type LifecycleDataRetentionDto,
  type LifecycleDataRestoresDto,
  type LifecycleDataStorageDto,
  type LifecycleHealthLevel,
} from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { SkipIdempotency } from '../../shared/decorators/idempotency.decorator';
import { CurrentPlatformActor, PlatformCapability, PlatformRoute, type PlatformActor } from '../../shared/decorators/platform.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { badRequest, notFound, unauthorized } from '../../shared/errors/api-error';
import { PlatformRateService } from '../platform/platform-rate.service';
import { LifecycleDashboardService } from './lifecycle.dashboard.service';
import { LifecycleRestoreService } from './lifecycle.restore.service';

/** Запросов в минуту к вкладкам дашборда на сотрудника (обновление 30 с — с запасом). */
const TABS_PER_MINUTE = 60;
/** Окно подписи отчёта: старше — повтор перехваченного запроса. */
const SIGNATURE_SKEW_SEC = 300;

/**
 * Дашборд «Данные» Кабинета (core/lifecycle Э5): шесть вкладок по праву `data.read`. Чтения —
 * агрегаты без ПДн; бюджет — общая дверь Кабинета (`platform:rate:*`).
 */
@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformRoute()
// Кабинет платформы вне движка повторов: у каждой команды свой ключ и журнал (docs/platform_console.md)
@SkipIdempotency('own_mechanism')
@Controller('platform/data')
export class LifecycleDashboardController {
  constructor(
    private readonly dash: LifecycleDashboardService,
    private readonly rate: PlatformRateService,
    private readonly restore: LifecycleRestoreService,
  ) {}

  private budget(actor: PlatformActor): Promise<void> {
    return this.rate.assertPanelBudget(actor, 'data', TABS_PER_MINUTE);
  }

  @PlatformCapability('data.read')
  @Get('summary')
  @ApiOperation({ summary: 'Overall traffic light of the data platform (home tile)' })
  async summary(@CurrentPlatformActor() actor: PlatformActor): Promise<{ success: true; data: { level: LifecycleHealthLevel } }> {
    await this.budget(actor);
    return { success: true, data: { level: await this.dash.overallLevel() } };
  }

  @PlatformCapability('data.read')
  @Get('overview')
  @ApiOperation({ summary: 'Six tiles (database, backups, partitions, retention, erasure, canary), growth charts, attention list' })
  async overview(@CurrentPlatformActor() actor: PlatformActor): Promise<{ success: true; data: LifecycleDataOverviewDto }> {
    await this.budget(actor);
    return { success: true, data: await this.dash.overview() };
  }

  @PlatformCapability('data.read')
  @Get('storage')
  @ApiOperation({ summary: 'Top-30 tables by size with growth, bloat and vacuum; connections and lock waits' })
  async storage(@CurrentPlatformActor() actor: PlatformActor): Promise<{ success: true; data: LifecycleDataStorageDto }> {
    await this.budget(actor);
    return { success: true, data: await this.dash.storage() };
  }

  @PlatformCapability('data.read')
  @Get('retention')
  @ApiOperation({ summary: 'Retention registry: floor/default/ceiling, overrides, lag by the nightly snapshot, last run' })
  async retention(@CurrentPlatformActor() actor: PlatformActor): Promise<{ success: true; data: LifecycleDataRetentionDto }> {
    await this.budget(actor);
    return { success: true, data: await this.dash.retention() };
  }

  @PlatformCapability('data.read')
  @Get('erasure')
  @ApiOperation({ summary: 'Erasure queue by stages (pseudonyms only), platform legal holds' })
  async erasure(@CurrentPlatformActor() actor: PlatformActor): Promise<{ success: true; data: LifecycleDataErasureDto }> {
    await this.budget(actor);
    return { success: true, data: await this.dash.erasure() };
  }

  @PlatformCapability('data.read')
  @Get('backups')
  @ApiOperation({ summary: 'PITR coverage, backup runs, restore drills, S3 replication lag' })
  async backups(@CurrentPlatformActor() actor: PlatformActor): Promise<{ success: true; data: LifecycleDataBackupsDto }> {
    await this.budget(actor);
    return { success: true, data: await this.dash.backups() };
  }

  @PlatformCapability('data.read')
  @Get('restores')
  @ApiOperation({ summary: 'Tenant restore archives (signed, from the PITR cluster) and their import runs' })
  async restores(@CurrentPlatformActor() actor: PlatformActor): Promise<{ success: true; data: LifecycleDataRestoresDto }> {
    await this.budget(actor);
    return { success: true, data: { sourceConfigured: this.restore.sourceConfigured(), archives: await this.restore.archives() } };
  }

  @PlatformCapability('data.read')
  @Get('canary')
  @ApiOperation({ summary: 'Last 30 erasure canary runs with findings' })
  async canary(@CurrentPlatformActor() actor: PlatformActor): Promise<{ success: true; data: LifecycleDataCanaryDto }> {
    await this.budget(actor);
    return { success: true, data: await this.dash.canary() };
  }
}

/**
 * Приём отчётов бэкапов и учений восстановления от скриптов эксплуатации (pgBackRest,
 * restore-drill). НЕ под `/platform` (там всё — сессия Кабинета, запрет по умолчанию), вне
 * сессии Кабинета: `Authorization: Bearer LIFECYCLE_OPS_TOKEN` +
 * `X-Lifecycle-Signature: t=<unix>,v1=<hex HMAC-SHA256(токен, "<t>.<сырое тело>")>` — окно
 * 5 минут против повтора перехваченного запроса. Токен не задан: в production — 404
 * (fail-closed), в разработке — открыто. Отчёт идемпотентен по (вид, репозиторий, метка).
 */
@ApiTags('Lifecycle')
@Public()
@Controller('lifecycle/ops')
export class LifecycleOpsController {
  constructor(private readonly dash: LifecycleDashboardService) {}

  @Post('backups/report')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @SkipIdempotency('inbound_webhook')
  @ApiOperation({ summary: 'Backup / restore drill report from the ops scripts (Bearer LIFECYCLE_OPS_TOKEN + signed body)' })
  async report(
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-lifecycle-signature') signature: string | undefined,
  ): Promise<{ success: true; data: { id: string; created: boolean } }> {
    const raw = Buffer.isBuffer(body) ? body : null;
    this.assertSigned(raw, authorization, signature);
    let parsed: unknown;
    try {
      parsed = JSON.parse((raw ?? Buffer.from('')).toString('utf8'));
    } catch {
      throw badRequest('lifecycle.backupReportInvalid');
    }
    const input = lifecycleBackupReportSchema.safeParse(parsed);
    if (!input.success) throw badRequest('lifecycle.backupReportInvalid');
    return { success: true, data: await this.dash.report(input.data) };
  }

  private assertSigned(raw: Buffer | null, authorization: string | undefined, signature: string | undefined): void {
    const token = process.env.LIFECYCLE_OPS_TOKEN || null;
    if (!token) {
      if (isDevEnv()) return;
      throw notFound('http.notFound');
    }
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const a = Buffer.from(bearer);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw unauthorized('lifecycle.opsTokenInvalid');
    const m = /^t=(\d{9,12}),v1=([0-9a-f]{64})$/.exec(signature ?? '');
    if (!m || !raw) throw unauthorized('lifecycle.opsSignatureInvalid');
    const t = Number(m[1]);
    if (Math.abs(Date.now() / 1000 - t) > SIGNATURE_SKEW_SEC) throw unauthorized('lifecycle.opsSignatureInvalid');
    const expected = createHmac('sha256', token).update(`${m[1]}.`).update(raw).digest();
    const got = Buffer.from(m[2], 'hex');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw unauthorized('lifecycle.opsSignatureInvalid');
  }
}
