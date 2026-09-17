import { Global, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { MetricsService } from '../../shared/metrics/metrics.service';
import { KeyProviderError } from './providers/key-provider';
import { KeysRoutesAudit } from './api-keys/keys.routes.audit';
import { MAC_KEY_NAMES } from '@superapp/shared';
import { isDevEnv, isProdEnv } from '../../shared/config/env.validation';
import { JwksApiController, JwksWellKnownController } from './jwks.controller';
import { KeysAuditService } from './keys.audit.service';
import { KeysDevController } from './keys.dev';
import { keysEnv, legacyHs256Open } from './keys.env';
import { KeysEnvelopeService } from './keys.envelope.service';
import { KeysMacService } from './keys.mac.service';
import { KeysPlatformProvider } from './keys.platform.provider';
import { KeysFieldRegistry } from './keys.registry';
import { KeysRotationJobs } from './keys.rotation.jobs';
import { KeysSigningService } from './keys.signing.service';
import { KeysStoreService } from './keys.store.service';
import { KEK_NAME, KEYS_JOBS, PLATFORM_SCOPE } from './keys.constants';
import { JobsService } from '../jobs/jobs.service';
import { KEY_PROVIDER, type KeyProvider } from './providers/key-provider';
import { Pkcs11Provider } from './providers/pkcs11.provider';
import { SoftwareProvider } from './providers/software.provider';
import { ApiKeyAuthService } from './api-keys/api-key-auth.service';
import { ApiKeysService } from './api-keys/api-keys.service';
import { BotsService } from './api-keys/bots.service';
import { KeyScopeGuard } from './api-keys/key-scope.guard';
import { KeysStepUpService } from './api-keys/keys-step-up.service';
import { KeysCascadesService } from './api-keys/keys.cascades.service';
import { KeysController } from './api-keys/keys.controller';
import { KeysEntitlementsProvider } from './api-keys/keys.entitlements.provider';
import { KeysNotifier } from './api-keys/keys.notifications';
import { KeysPlatformPanel } from './api-keys/keys.platform.panel';
import { KeysRegistryService } from './api-keys/keys.registry.service';
import { ApiKeyAccessInterceptor, KeysUsageCron } from './api-keys/keys.usage.cron';
import { WebhooksRegistryPort } from './api-keys/webhooks.port';
import { WorkspaceKeysController } from './api-keys/workspace-keys.controller';
import { KeysPiiService } from './pii/keys.pii.service';

/**
 * core/keys — 22-й платформенный движок: ключи, шифрование, подпись. Единственная
 * дверь ко всей криптографии платформы: подпись JWT (Ed25519 + JWKS + kid, пара на
 * аудиторию), envelope-шифрование секретов и ПДн (AES-256-GCM с AAD, KEK на организацию
 * и человека), слепые индексы, HMAC-ключи, ключи API организаций и людей, боты,
 * реестр ключей, журнал append-only. @Global: потребители инжектят сервисы напрямую;
 * движок фичи не импортирует (обратное направление — `KeysFieldRegistry`).
 *
 * Смоук на бутстрапе (fail-closed): корень читается, ни одна версия не обёрнута чужим
 * корнем, primary-версии всех обязательных платформенных ключей существуют; в production
 * legacy HS256 после `KEYS_LEGACY_HS256_UNTIL` — ошибка старта.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  controllers: isDevEnv()
    ? [JwksWellKnownController, JwksApiController, KeysController, WorkspaceKeysController, KeysDevController]
    : [JwksWellKnownController, JwksApiController, KeysController, WorkspaceKeysController],
  providers: [
    {
      provide: KEY_PROVIDER,
      inject: [MetricsService],
      useFactory: (metrics: MetricsService): KeyProvider => {
        const env = keysEnv();
        const rootPresent = metrics.gauge('keys_root_present', 'Root key of the keys engine is loaded (1) or missing (0)');
        try {
          const provider = env.provider === 'pkcs11' ? new Pkcs11Provider(env.pkcs11) : new SoftwareProvider(env.rootKeyFile, { createIfMissing: env.rootKeyFileIsDefault && isDevEnv() });
          rootPresent.set(1);
          return provider;
        } catch (err) {
          // Событие `keys.root.missing` — строкой лога для алертинга (процесс дальше не живёт)
          rootPresent.set(0);
          const code = err instanceof KeyProviderError ? err.code : 'unknown';
          new Logger(KeysModule.name).error(`event=keys.root.missing provider=${env.provider} code=${code}: ${(err as Error).message}`);
          throw err;
        }
      },
    },
    KeysAuditService,
    KeysStoreService,
    KeysFieldRegistry,
    KeysEnvelopeService,
    KeysMacService,
    KeysSigningService,
    KeysRotationJobs,
    KeysPlatformProvider,
    ApiKeyAuthService,
    KeysPiiService,
    // Ключи API, боты, реестр, каскады (фаза E)
    KeysNotifier,
    KeysStepUpService,
    ApiKeysService,
    BotsService,
    KeysCascadesService,
    KeysRegistryService,
    WebhooksRegistryPort,
    KeysUsageCron,
    ApiKeyAccessInterceptor,
    KeysEntitlementsProvider,
    KeysPlatformPanel,
    KeyScopeGuard,
    KeysRoutesAudit,
  ],
  exports: [
    KeysStoreService,
    KeysEnvelopeService,
    KeysMacService,
    KeysSigningService,
    KeysAuditService,
    KeysFieldRegistry,
    KeysRotationJobs,
    ApiKeyAuthService,
    KeysPiiService,
    ApiKeysService,
    BotsService,
    KeysCascadesService,
    KeysNotifier,
    KeysStepUpService,
    WebhooksRegistryPort,
    KeysUsageCron,
    ApiKeyAccessInterceptor,
    KeyScopeGuard,
    KEY_PROVIDER,
  ],
})
export class KeysModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(KeysModule.name);

  constructor(
    private readonly store: KeysStoreService,
    private readonly signing: KeysSigningService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const env = keysEnv();
    // Legacy-окно в production обязано быть датированным и не истёкшим
    if (isProdEnv() && env.legacySecret && (!env.legacyHs256Until || !legacyHs256Open(env))) {
      throw new Error(
        'JWT_SECRET_LEGACY is set in production but the HS256 window is closed or undated: set KEYS_LEGACY_HS256_UNTIL to a future date for the migration window, or remove the legacy secret',
      );
    }
    const foreign = await this.store.versionsWithForeignRoot();
    if (foreign > 0) {
      throw new Error(
        `${foreign} key version(s) are wrapped by another root (current root ${this.store.provider.rootKid}): the root key file does not match the keystore — restore the right file or finish the root rotation`,
      );
    }
    // Обязательные платформенные ключи: KEK платформы, пары подписи всех аудиторий, HMAC-ключи
    await this.store.ensureKey(PLATFORM_SCOPE, 'kek', KEK_NAME);
    await this.signing.ensureAll();
    for (const name of MAC_KEY_NAMES) await this.store.ensureKey(PLATFORM_SCOPE, 'mac', name);
    // Смоук: primary каждого обязательного ключа распаковывается (файл корня — тот)
    await this.store.primary(PLATFORM_SCOPE, 'kek', KEK_NAME);
    // Строки прошлой эпохи (производные ключи, открытые Google-токены) → envelope: джоб на
    // каждом старте, идемпотентный (без legacy-строк — no-op), после регистраций колонок фичами
    await this.jobs
      .enqueue(null, { type: KEYS_JOBS.legacyReencrypt, payload: {}, uniqueKey: 'boot', runAt: new Date(Date.now() + 20_000) })
      .catch((err) => this.logger.warn(`legacy re-encrypt enqueue failed: ${(err as Error).message}`));
    this.logger.log(`keys engine ready: provider=${this.store.provider.kind} root=${this.store.provider.rootKid} legacyHs256=${legacyHs256Open(env) ? 'open' : 'closed'}`);
  }
}
