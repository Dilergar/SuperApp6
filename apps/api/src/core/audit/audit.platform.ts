import { Body, Controller, Get, HttpCode, HttpStatus, Injectable, OnModuleInit, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AUDIT_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  PLATFORM_LIMITS,
  platformSecurityEventsQuerySchema,
  securityAccountFreezeInputSchema,
  securityAccountUnfreezeInputSchema,
  securityAlertCloseInputSchema,
  securityAlertsQuerySchema,
  securityDigestVerifyInputSchema,
  securityEventRevealIpInputSchema,
  securityExportInputSchema,
  securityStreamReplayInputSchema,
  securityNetworkLookupSchema,
  securitySessionRevokeInputSchema,
  type PlatformUserSecurityPanelDto,
  type PlatformWorkspaceSecurityPanelDto,
  type SecurityAccountFreezeInput,
  type SecurityAccountUnfreezeInput,
  type SecurityAlertCloseInput,
  type SecurityAlertSummaryDto,
  type SecurityDigestDto,
  type SecurityDigestVerifyInput,
  type SecurityExportInput,
  type SecurityStreamReplayInput,
  type PlatformSecurityExportDto,
  type SecurityEventRevealIpDto,
  type SecurityEventRevealIpInput,
  type SecurityNetworkLookupDto,
  type SecurityPartitionDto,
  type SecuritySessionRevokeInput,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { CurrentPlatformActor, PlatformCapability, PlatformRoute, type PlatformActor } from '../../shared/decorators/platform.decorator';
import { SkipIdempotency } from '../../shared/decorators/idempotency.decorator';
import { conflict, notFound, tooMany } from '../../shared/errors/api-error';
import { AnalyticsService } from '../analytics/analytics.service';
import { PlatformCommandRegistry } from '../platform/platform-commands.registry';
import { PlatformPanelRegistry } from '../platform/platform-lookup.registry';
import { PlatformAuditService } from '../platform/platform-audit.service';
import { PlatformRateService } from '../platform/platform-rate.service';
import { AuditAccountService } from './audit.account.service';
import { AuditAlertsService } from './audit.alerts.service';
import { AuditArchiveService } from './audit.archive';
import { AuditDigestService } from './audit.digests';
import { AuditExportService } from './audit.export';
import { AuditStreamService } from './audit.stream';
import { AuditPartitions } from './audit.partitions';
import { AuditQueryService } from './audit.query.service';
import { AuditService } from './audit.service';
import { AuditSessionsService } from './audit.sessions.service';
import { AuditViewedService } from './audit.viewed';
import { AuditWorkspaceAccess } from './audit.workspace-access';

const PANEL_EVENTS = 10;

/**
 * Журнал безопасности в Кабинете платформы (исполнитель Кабинета делает журнал команды,
 * step-up, причину и «четыре глаза»):
 *  - `security.session.revoke` (high) — одна сессия человека или все; access-токены гаснут сразу;
 *  - `security.account.freeze` (high) — тот же эффект, что заморозка человеком;
 *  - `security.account.unfreeze` (high, step-up) — после проверки личности по регламенту;
 *  - `security.alert.close` (medium, причина) — итог тревоги детекции;
 *  - `security.event.reveal_ip` (medium, step-up, причина, право `platform.pii.reveal`) —
 *    полный IP события; раскрытие — `platform.access.reveal`, в журнал команд IP не пишется (S7);
 *  - `security.digest.verify` (medium, `security.read`) — пересчёт корней Меркла за окно;
 *    расхождение = тревога `digest_mismatch` (critical);
 *  - `security.export` (critical, «четыре глаза») — выгрузка журнала платформы джобом, файл
 *    автору (вкладка «Целостность»), факт — `data.export{source: audit_platform}`;
 *  - `security.stream.replay` (high) — повтор SIEM-стрима организации за окно.
 * Чтение (события, тревоги, дайджесты, партиции, выгрузки, поиск по сети) — `AuditPlatformController`.
 * Панели карточки 360: `user.security`, `workspace.security`.
 * Действия сотрудников людям и организациям не показываются никогда (`platform.*` — только
 * зритель-платформа), поэтому здесь и только здесь личность сотрудника видна в ленте.
 */
@Injectable()
export class AuditPlatformProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly commands: PlatformCommandRegistry,
    private readonly panels: PlatformPanelRegistry,
    private readonly platformAudit: PlatformAuditService,
    private readonly audit: AuditService,
    private readonly query: AuditQueryService,
    private readonly sessions: AuditSessionsService,
    private readonly account: AuditAccountService,
    private readonly alerts: AuditAlertsService,
    private readonly viewed: AuditViewedService,
    private readonly wsAccess: AuditWorkspaceAccess,
    private readonly analytics: AnalyticsService,
    private readonly digests: AuditDigestService,
    private readonly exporter: AuditExportService,
    private readonly stream: AuditStreamService,
  ) {}

  onModuleInit(): void {
    this.registerAccountCommands();
    this.registerAlertCommands();
    this.registerIntegrityCommands();
    this.registerPanels();
  }

  private registerIntegrityCommands(): void {
    this.commands.register<SecurityDigestVerifyInput>({
      key: 'security.digest.verify',
      version: 1,
      group: 'security',
      titleKey: 'platform.commands.securityDigestVerify.title',
      descriptionKey: 'platform.commands.securityDigestVerify.description',
      input: securityDigestVerifyInputSchema,
      capability: 'security.read',
      risk: 'medium',
      target: () => null,
      // Проверка читает журнал и отмечает дайджесты «проверен» — вне транзакции команды:
      // пересчёт листьев за сутки — не то, что держат в одной транзакции
      execute: async (_ctx, input) => {
        const res = await this.digests.verify(new Date(input.from), new Date(input.to));
        return { result: res, after: { digests: res.digests, ok: res.ok, mismatched: res.mismatched.length } };
      },
    });

    this.commands.register<SecurityExportInput>({
      key: 'security.export',
      version: 1,
      group: 'security',
      titleKey: 'platform.commands.securityExport.title',
      descriptionKey: 'platform.commands.securityExport.description',
      input: securityExportInputSchema,
      capability: 'security.write',
      risk: 'critical',
      // Весь журнал платформы наружу — через второго сотрудника (при включённых «четырёх глазах»)
      dualControl: true,
      target: () => null,
      execute: async (ctx, input, tx) => {
        const r = await this.exporter.requestPlatform(tx, ctx.actor.userId, input);
        return { result: { exportId: r.exportId, jobQueued: true }, after: { format: input.format, from: input.from, to: input.to } };
      },
    });

    this.commands.register<SecurityStreamReplayInput>({
      key: 'security.stream.replay',
      version: 1,
      group: 'security',
      titleKey: 'platform.commands.securityStreamReplay.title',
      descriptionKey: 'platform.commands.securityStreamReplay.description',
      input: securityStreamReplayInputSchema,
      capability: 'security.write',
      risk: 'high',
      entities: ['workspace'],
      target: (i) => ({ type: 'workspace', id: i.workspaceId, workspaceId: i.workspaceId }),
      // Доставки ставятся своими транзакциями (outbox вебхуков): повтор — не одна атомарная правка
      execute: async (_ctx, input) => {
        const res = await this.stream.replay(input.workspaceId, new Date(input.from), new Date(input.to));
        return { result: res, after: res };
      },
    });
  }

  private async assertUser(userId: string): Promise<void> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!u) throw notFound('platform.entity_not_found');
  }

  private registerAccountCommands(): void {
    this.commands.register<SecuritySessionRevokeInput>({
      key: 'security.session.revoke',
      version: 1,
      group: 'security',
      titleKey: 'platform.commands.securitySessionRevoke.title',
      descriptionKey: 'platform.commands.securitySessionRevoke.description',
      input: securitySessionRevokeInputSchema,
      capability: 'security.write',
      risk: 'high',
      entities: ['user'],
      target: (i) => ({ type: 'user', id: i.userId }),
      execute: async (_ctx, input, tx) => {
        await this.assertUser(input.userId);
        if (input.sessionId) {
          const exists = await tx.session.findFirst({ where: { userId: input.userId, familyId: input.sessionId }, select: { id: true } });
          if (!exists) throw notFound('audit.session_not_found', undefined, { code: AUDIT_ERROR_CODES.sessionNotFound });
        }
        const r = await this.sessions.revokeFamilies(tx, input.userId, input.sessionId ? { only: [input.sessionId] } : {}, 'platform');
        if (r.count) {
          await this.audit.record(tx, {
            key: 'auth.session.revoked',
            subjectUserId: input.userId,
            target: input.sessionId ? { type: 'session', id: input.sessionId } : null,
            details: { by: 'platform', sessions: r.count },
          });
        }
        return {
          after: { sessionsRevoked: r.count },
          result: { sessionsRevoked: r.count },
          afterCommit: () => this.account.afterAccessRevoked(input.userId, r.families),
        };
      },
    });

    this.commands.register<SecurityAccountFreezeInput>({
      key: 'security.account.freeze',
      version: 1,
      group: 'security',
      titleKey: 'platform.commands.securityAccountFreeze.title',
      descriptionKey: 'platform.commands.securityAccountFreeze.description',
      input: securityAccountFreezeInputSchema,
      capability: 'security.write',
      risk: 'high',
      entities: ['user'],
      // Заморозить себя кнопкой Кабинета нельзя: свой аккаунт сотрудник замораживает как
      // человек (/freeze) — иначе потерял бы Кабинет без следа «кто разморозит»
      forbidSelfTarget: true,
      target: (i) => ({ type: 'user', id: i.userId }),
      execute: async (_ctx, input, tx) => {
        await this.assertUser(input.userId);
        const r = await this.account.freezeByPlatformTx(tx, input.userId);
        if (r.changed) await this.analytics.track(tx, 'auth.account.frozen', { by: 'platform' }, { userId: input.userId, workspaceId: null });
        return {
          before: { frozen: !r.changed },
          after: { frozen: true },
          result: { changed: r.changed },
          afterCommit: r.changed ? () => this.account.afterAccessRevoked(input.userId, r.families) : undefined,
        };
      },
    });

    this.commands.register<SecurityAccountUnfreezeInput>({
      key: 'security.account.unfreeze',
      version: 1,
      group: 'security',
      titleKey: 'platform.commands.securityAccountUnfreeze.title',
      descriptionKey: 'platform.commands.securityAccountUnfreeze.description',
      input: securityAccountUnfreezeInputSchema,
      capability: 'security.write',
      risk: 'high',
      stepUp: true,
      entities: ['user'],
      forbidSelfTarget: true,
      target: (i) => ({ type: 'user', id: i.userId }),
      execute: async (_ctx, input, tx) => {
        await this.assertUser(input.userId);
        const changed = await this.account.unfreezeByPlatformTx(tx, input.userId);
        if (!changed) throw conflict('audit.not_frozen', undefined, { code: AUDIT_ERROR_CODES.notFrozen });
        return { before: { frozen: true }, after: { frozen: false }, result: { changed: true } };
      },
    });

    this.commands.register<SecurityEventRevealIpInput>({
      key: 'security.event.reveal_ip',
      version: 1,
      group: 'security',
      titleKey: 'platform.commands.securityEventRevealIp.title',
      descriptionKey: 'platform.commands.securityEventRevealIp.description',
      input: securityEventRevealIpInputSchema,
      capability: 'platform.pii.reveal',
      risk: 'medium',
      // IP — персональные данные: SMS-подтверждение и причина, как у раскрытия телефона
      stepUp: true,
      reasonRequired: true,
      persistResult: false,
      target: (i) => ({ type: 'security_event', id: i.eventId }),
      execute: async (ctx, input) => {
        const reveals = await this.platformAudit.accessCount(ctx.actor.userId, 'reveal', 3_600_000);
        if (reveals >= PLATFORM_LIMITS.piiRevealsPerHour) {
          throw tooMany('platform.rate_limited', undefined, { code: PLATFORM_ERROR_CODES.rateLimited, resendInSec: 3600 });
        }
        const net = await this.query.ipOf(input.eventId);
        if (!net) throw notFound('audit.event_not_found', undefined, { code: AUDIT_ERROR_CODES.eventNotFound });
        const pseudonyms = net.ip ? await this.audit.pseudonymsForSearch(net.ip) : net.ipHmac ? [net.ipHmac] : [];
        this.platformAudit.logAccess({ actorId: ctx.actor.userId, kind: 'reveal', targetType: 'security_event', targetId: input.eventId, fields: ['ip'], requestId: ctx.actor.requestId });
        await this.viewed.bump(ctx.actor.userId, { reveals: 1 });
        const result: SecurityEventRevealIpDto = { eventId: input.eventId, ip: net.ip, ipNet: net.ipNet, pseudonyms };
        // В журнал команд — только факт раскрытия (S7): сам адрес живёт лишь в ответе
        return { result, after: { revealed: ['ip'] } };
      },
    });
  }

  private registerAlertCommands(): void {
    this.commands.register<SecurityAlertCloseInput>({
      key: 'security.alert.close',
      version: 1,
      group: 'security',
      titleKey: 'platform.commands.securityAlertClose.title',
      descriptionKey: 'platform.commands.securityAlertClose.description',
      input: securityAlertCloseInputSchema,
      capability: 'security.write',
      risk: 'medium',
      reasonRequired: true,
      target: (i) => ({ type: 'security_alert', id: i.alertId }),
      execute: async (ctx, input, tx) => {
        const r = await this.alerts.closeTx(tx, input.alertId, input.resolution, ctx.actor.userId);
        return { before: { status: r.before }, after: { status: 'closed', resolution: input.resolution, kind: r.kind } };
      },
    });
  }

  private registerPanels(): void {
    this.panels.register({
      key: 'user.security',
      entity: 'user',
      titleKey: 'platform.panels.userSecurity',
      capability: 'security.read',
      order: 65,
      eager: false,
      load: async (actor, id): Promise<PlatformUserSecurityPanelDto> => {
        const now = new Date();
        const [user, activeSessions, devices, openAlerts, page] = await Promise.all([
          this.db.user.findUnique({ where: { id }, select: { securityFrozenAt: true, loginLockedUntil: true } }),
          this.db.session.findMany({ where: { userId: id, revokedAt: null, rotatedAt: null, expiresAt: { gt: now } }, select: { familyId: true }, distinct: ['familyId'] }),
          this.db.userDevice.count({ where: { userId: id, forgottenAt: null } }),
          this.alerts.openFor({ subjectUserId: id }),
          this.query.query({ kind: 'platform', actorId: actor.userId }, { subjectUserId: id, limit: PANEL_EVENTS }),
        ]);
        if (!user) throw notFound('platform.entity_not_found');
        await this.viewed.bump(actor.userId, { queries: 1, rows: page.items.length });
        return {
          frozenAt: user.securityFrozenAt?.toISOString() ?? null,
          lockedUntil: user.loginLockedUntil && user.loginLockedUntil > now ? user.loginLockedUntil.toISOString() : null,
          activeSessions: activeSessions.length,
          devices,
          openAlerts,
          recent: page.items,
        };
      },
    });

    this.panels.register({
      key: 'workspace.security',
      entity: 'workspace',
      titleKey: 'platform.panels.workspaceSecurity',
      capability: 'security.read',
      order: 65,
      eager: false,
      load: async (actor, id): Promise<PlatformWorkspaceSecurityPanelDto> => {
        const [overview, openAlerts, page] = await Promise.all([
          this.wsAccess.overview(id),
          this.alerts.openFor({ workspaceId: id }),
          this.query.query({ kind: 'platform', actorId: actor.userId }, { workspaceId: id, limit: PANEL_EVENTS }),
        ]);
        await this.viewed.bump(actor.userId, { queries: 1, rows: page.items.length });
        return { ...overview, openAlerts, recent: page.items };
      },
    });
  }
}

/**
 * Консоль «Безопасность» Кабинета — чтения (мутации — только командами реестра):
 * лента событий с фильтрами (актор, субъект, организация, запрос, сеть), одно событие,
 * псевдонимы сети по IP, тревоги, дайджесты целостности, партиции. Каждое чтение — в общий
 * бюджет просмотров сотрудника и в агрегат `audit.viewed`; поиск по IP — `platform.access.search`.
 */
@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformRoute()
// Кабинет платформы вне движка повторов: у КАЖДОЙ команды реестра свой ключ
// идемпотентности, журнал и «четыре глаза» — второй механизм поверх был бы
// не защитой, а вторым источником правды (docs/platform_console.md).
@SkipIdempotency('own_mechanism')
@Controller('platform/security')
export class AuditPlatformController {
  constructor(
    private readonly db: DatabaseService,
    private readonly query: AuditQueryService,
    private readonly audit: AuditService,
    private readonly alerts: AuditAlertsService,
    private readonly partitions: AuditPartitions,
    private readonly viewed: AuditViewedService,
    private readonly rate: PlatformRateService,
    private readonly platformAudit: PlatformAuditService,
    private readonly exporter: AuditExportService,
    private readonly archive: AuditArchiveService,
  ) {}

  @PlatformCapability('security.read')
  @Get('events')
  @ApiOperation({ summary: 'Security log: every event with filters (actor, subject, organization, request, network)' })
  async events(@CurrentPlatformActor() actor: PlatformActor, @Query() q: unknown) {
    const f = platformSecurityEventsQuerySchema.parse(q ?? {});
    await this.rate.assertViewBudget(actor);
    const data = await this.query.query(
      { kind: 'platform', actorId: actor.userId },
      {
        keys: f.key ? [f.key] : null,
        categories: f.category ? [f.category] : undefined,
        actorKind: f.actorKind,
        actorId: f.actorId,
        subjectUserId: f.subjectUserId,
        workspaceId: f.workspaceId,
        requestId: f.requestId,
        ipHmacs: f.ipHmac,
        op: f.op,
        outcome: f.outcome,
        from: f.from ? new Date(f.from) : undefined,
        to: f.to ? new Date(f.to) : undefined,
        cursor: f.cursor,
        limit: f.limit,
      },
    );
    await this.viewed.bump(actor.userId, { queries: 1, rows: data.items.length });
    return { success: true, data };
  }

  @PlatformCapability('security.read')
  @Get('events/:id')
  @ApiOperation({ summary: 'One security event with all details (the full IP — only by the reveal command)' })
  async event(@CurrentPlatformActor() actor: PlatformActor, @Param('id') id: string) {
    await this.rate.assertViewBudget(actor);
    const dto = await this.query.getOne({ kind: 'platform', actorId: actor.userId }, id);
    if (!dto) throw notFound('audit.event_not_found', undefined, { code: AUDIT_ERROR_CODES.eventNotFound });
    await this.viewed.bump(actor.userId, { queries: 1, rows: 1 });
    return { success: true, data: dto };
  }

  /** IP → псевдонимы сети для фильтра ленты. POST: IP не оседает в адресе, логах прокси и истории. */
  @PlatformCapability('security.read')
  @Post('network')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Network pseudonyms of an IP address (for the “all events from this IP” filter)' })
  async network(@CurrentPlatformActor() actor: PlatformActor, @Body() body: unknown) {
    const { ip } = securityNetworkLookupSchema.parse(body ?? {});
    await this.rate.assertLookupBudget(actor);
    const pseudonyms = await this.audit.pseudonymsForSearch(ip);
    // Сам ввод IP — поиск по персональным данным: факт в журнал чтений (без значения)
    this.platformAudit.logAccess({ actorId: actor.userId, kind: 'search', fields: ['ip'], requestId: actor.requestId });
    const data: SecurityNetworkLookupDto = { pseudonyms };
    return { success: true, data };
  }

  /** Счётчик вкладки: незакрытые тревоги. Статический путь — до любых `alerts/:…`. */
  @PlatformCapability('security.read')
  @Get('alerts/summary')
  @ApiOperation({ summary: 'Unresolved detection alerts: open, in progress, critical' })
  async alertSummary() {
    const data: SecurityAlertSummaryDto = await this.alerts.summary();
    return { success: true, data };
  }

  @PlatformCapability('security.read')
  @Get('alerts')
  @ApiOperation({ summary: 'Detection alerts (work queue)' })
  async alertList(@CurrentPlatformActor() actor: PlatformActor, @Query() q: unknown) {
    const f = securityAlertsQuerySchema.parse(q ?? {});
    await this.rate.assertViewBudget(actor);
    return { success: true, data: await this.alerts.list(f) };
  }

  /** Мои выгрузки журнала (команда `security.export`): файлы только автора. */
  @PlatformCapability('security.read')
  @Get('exports')
  @ApiOperation({ summary: 'My security log exports (files of the security.export command)' })
  async exports(@CurrentPlatformActor() actor: PlatformActor) {
    const data: PlatformSecurityExportDto[] = await this.exporter.platformExports(actor.userId);
    return { success: true, data };
  }

  /** Короткая ссылка на скачивание своей выгрузки; скачивание — чтение журнала (агрегат audit.viewed). */
  @PlatformCapability('security.read')
  @Get('exports/:fileId/url')
  @ApiOperation({ summary: 'Download link of my security log export' })
  async exportUrl(@CurrentPlatformActor() actor: PlatformActor, @Param('fileId', ParseUUIDPipe) fileId: string) {
    const data = await this.exporter.platformExportUrl(actor.userId, fileId);
    if (!data) throw notFound('files.notFound');
    this.platformAudit.logAccess({ actorId: actor.userId, kind: 'view', targetType: 'file', targetId: fileId, fields: ['security_log_export'], requestId: actor.requestId });
    return { success: true, data };
  }

  @PlatformCapability('security.read')
  @Get('digests')
  @ApiOperation({ summary: 'Signed integrity digests of the log (latest 100)' })
  async digests() {
    const rows = await this.db.securityDigest.findMany({ orderBy: { signedAt: 'desc' }, take: 100 });
    const data: SecurityDigestDto[] = rows.map((d) => ({
      id: d.id,
      firstAt: d.firstAt?.toISOString() ?? null,
      lastAt: d.lastAt?.toISOString() ?? null,
      count: d.count,
      merkleRoot: Buffer.from(d.merkleRoot).toString('hex'),
      kid: d.kid,
      signedAt: d.signedAt.toISOString(),
      exportedAt: d.exportedAt?.toISOString() ?? null,
      verifiedAt: d.verifiedAt?.toISOString() ?? null,
      verifyOk: d.verifyOk,
    }));
    return { success: true, data };
  }

  @PlatformCapability('security.read')
  @Get('partitions')
  @ApiOperation({ summary: 'Monthly partitions of the log and their archive status' })
  async partitionList() {
    const [live, archives] = await Promise.all([this.partitions.list(), this.db.securityPartitionArchive.findMany({ orderBy: { fromAt: 'desc' } })]);
    const byName = new Map(archives.map((a) => [a.partition, a]));
    const data: SecurityPartitionDto[] = live.map((p) => {
      const a = byName.get(p.name);
      byName.delete(p.name);
      return { name: p.name, from: p.from.toISOString(), to: p.to.toISOString(), status: a ? 'archived' : 'in_db', rows: a?.rows ?? null, archivedAt: a?.archivedAt.toISOString() ?? null, manifestKey: a?.manifestKey ?? null };
    });
    // Сброшенные партиции живут только строкой архива
    for (const a of byName.values()) {
      data.push({ name: a.partition, from: a.fromAt.toISOString(), to: a.toAt.toISOString(), status: a.droppedAt ? 'dropped' : 'archived', rows: a.rows, archivedAt: a.archivedAt.toISOString(), manifestKey: a.manifestKey });
    }
    // ISO-строки UTC сравниваются как строки — порядок времени (свежие сверху)
    data.sort((x, y) => (x.from < y.from ? 1 : x.from > y.from ? -1 : 0));
    return { success: true, data };
  }

  /** Манифест архива месяца из хранилища + проверка подписи (подпись сверяется с записанной в базе). */
  @PlatformCapability('security.read')
  @Get('partitions/:partition/manifest')
  @ApiOperation({ summary: 'Archive manifest of a month with its signature check' })
  async manifest(@CurrentPlatformActor() actor: PlatformActor, @Param('partition') partition: string) {
    if (!/^security_events_\d{4}_\d{2}$/.test(partition)) throw notFound('audit.partition_not_found', undefined, { code: AUDIT_ERROR_CODES.partitionNotFound });
    await this.rate.assertViewBudget(actor);
    const data = await this.archive.inspect(partition);
    if (!data) throw notFound('audit.partition_not_found', undefined, { code: AUDIT_ERROR_CODES.partitionNotFound });
    return { success: true, data };
  }
}
