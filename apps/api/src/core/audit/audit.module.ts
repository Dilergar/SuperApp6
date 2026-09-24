import { Global, Logger, Module, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { auditRegistryProblems } from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { DI_TOKENS } from '../../shared/di-tokens';
import { AuditDevController } from './audit.dev';
import { AuditJobs } from './audit.jobs';
import { AuditMetrics } from './audit.metrics';
import { AuditPartitions } from './audit.partitions';
import { AuditQueryService } from './audit.query.service';
import { AuditRealtimeProvider } from './audit.realtime.provider';
import { AuditRenderer } from './audit.render';
import { AuditService } from './audit.service';
import { AuditSessionsService } from './audit.sessions.service';
import { AuditLoginGuard } from './audit.login-guard';
import { AuditAccountService } from './audit.account.service';
import { AuditMeController } from './audit.controller';
import { AuditMyDataService } from './audit.my-data.service';
import { AuditCron } from './audit.cron';
import { AuditViewedService } from './audit.viewed';
import { AuditAlertsService } from './audit.alerts.service';
import { AuditWorkspaceAccess } from './audit.workspace-access';
import { AuditWorkspaceController } from './audit.workspace.controller';
import { AuditPlatformController, AuditPlatformProvider } from './audit.platform';
import { AuditDetections } from './audit.detections';
import { AuditAuthz } from './audit.authz';
import { AuditSettingsCheck } from './audit.settings';
import { AuditDigestService } from './audit.digests';
import { AuditArchiveService } from './audit.archive';
import { AuditExportService } from './audit.export';
import { AuditStreamService } from './audit.stream';
import { KeysFieldRegistry } from '../keys/keys.registry';
import { AUDIT_EVENT_ENTITY } from './audit.constants';

/**
 * core/audit — 26-й платформенный движок: журнал аудита безопасности. ЕДИНЫЙ поток событий
 * «кто / когда / откуда / что / с чем / исход» с тремя зрителями (человек, организация,
 * платформа); в него переехали журналы ключей, Кабинета, чтений и учёта действий с ПДн.
 * @Global: сервисы зовут `AuditService.record(tx, …)`; движок фичи не импортирует.
 *
 * Циклы: `core/keys` и `core/platform` берут `AuditService` ЛЕНИВО по `DI_TOKENS.AuditService`
 * (сам журнал тянет keys — envelope/HMAC/подпись — и реестры Кабинета).
 *
 * Смоук на бутстрапе: реестр, нарушающий правила (категория ≠ префиксу, зритель-платформа не
 * true, действия сотрудников видны людям, окно не у pd/consents, запрещённое имя детали),
 * роняет старт. docs/audit_engine.md.
 */
@Global()
@Module({
  controllers: isDevEnv()
    ? [AuditMeController, AuditWorkspaceController, AuditPlatformController, AuditDevController]
    : [AuditMeController, AuditWorkspaceController, AuditPlatformController],
  providers: [
    AuditService,
    { provide: DI_TOKENS.AuditService, useExisting: AuditService },
    AuditQueryService,
    { provide: DI_TOKENS.AuditQueryService, useExisting: AuditQueryService },
    AuditRenderer,
    AuditPartitions,
    AuditMetrics,
    AuditJobs,
    AuditRealtimeProvider,
    AuditSessionsService,
    AuditLoginGuard,
    AuditAccountService,
    AuditMyDataService,
    AuditCron,
    AuditViewedService,
    AuditAlertsService,
    AuditWorkspaceAccess,
    AuditPlatformProvider,
    AuditDetections,
    AuditAuthz,
    AuditSettingsCheck,
    AuditDigestService,
    AuditArchiveService,
    AuditExportService,
    AuditStreamService,
  ],
  exports: [AuditService, AuditQueryService, AuditPartitions, AuditSessionsService, AuditLoginGuard, AuditAccountService, AuditWorkspaceAccess, AuditAlertsService, DI_TOKENS.AuditService, DI_TOKENS.AuditQueryService],
})
export class AuditModule implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(AuditModule.name);

  constructor(private readonly fields: KeysFieldRegistry) {}

  /**
   * Шифротексты журнала — в общий реестр перешивки ключей (`keys.rewrap`): ротация
   * платформенного KEK перешивает IP и UA событий (страж-триггер пропускает ровно эти две
   * колонки). Курсор — по числу: журнал — миллионы строк.
   */
  onModuleInit(): void {
    this.fields.register({ table: 'security_events', idColumn: 'id', idNumeric: true, column: 'ip_enc', scope: 'platform', entity: AUDIT_EVENT_ENTITY, field: 'ip' });
    this.fields.register({ table: 'security_events', idColumn: 'id', idNumeric: true, column: 'ua_raw_enc', scope: 'platform', entity: AUDIT_EVENT_ENTITY, field: 'userAgent' });
  }

  onApplicationBootstrap(): void {
    const problems = auditRegistryProblems();
    if (problems.length) {
      const msg = `security audit event registry is invalid:\n  ${problems.join('\n  ')}`;
      this.logger.error(msg);
      throw new Error(msg);
    }
  }
}
