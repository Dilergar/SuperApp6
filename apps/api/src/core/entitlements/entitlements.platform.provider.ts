import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  entitlementSubjectSchema,
  grantCreateInputSchema,
  grantRevokeInputSchema,
  overrideClearInputSchema,
  overrideSetInputSchema,
  planCreateVersionInputSchema,
  planUpdateDraftInputSchema,
  planVersionRefInputSchema,
  subscriptionSetInputSchema,
  trialExtendInputSchema,
  type EntitlementSubjectRef,
  type GrantCreateInput,
  type GrantRevokeInput,
  type OverrideClearInput,
  type OverrideSetInput,
  type PlanCreateVersionInput,
  type PlanUpdateDraftInput,
  type PlanVersionRefInput,
  type SubscriptionSetInput,
  type TrialExtendInput,
} from '@superapp/shared';
import { PlatformCommandRegistry } from '../platform/platform-commands.registry';
import { PlatformPanelRegistry } from '../platform/platform-lookup.registry';
import { PlatformAuditService } from '../platform/platform-audit.service';
import { PlatformRateService } from '../platform/platform-rate.service';
import { CurrentPlatformActor, PlatformCapability, PlatformRoute, type PlatformActor } from '../../shared/decorators/platform.decorator';
import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EntitlementsCatalogService } from './entitlements.catalog.service';
import { EntitlementsService } from './entitlements.service';

const subjectTarget = (s: { type: string; id: string }) => ({ type: s.type, id: s.id, workspaceId: s.type === 'workspace' ? s.id : null });

/**
 * Регистрации движка в кабинете платформы: команды каталога и субъектов + панели
 * карточки 360. Права проверяет исполнитель по capability команды; сами методы
 * движка — system-методы.
 */
@Injectable()
export class EntitlementsPlatformProvider implements OnModuleInit {
  constructor(
    private readonly commands: PlatformCommandRegistry,
    private readonly panels: PlatformPanelRegistry,
    private readonly catalog: EntitlementsCatalogService,
    private readonly entitlements: EntitlementsService,
  ) {}

  onModuleInit(): void {
    this.commands.register<PlanCreateVersionInput>({
      key: 'entitlements.plan.createVersion',
      version: 1,
      group: 'entitlements',
      titleKey: 'platform.commands.entitlementsPlanCreateVersion.title',
      descriptionKey: 'platform.commands.entitlementsPlanCreateVersion.description',
      input: planCreateVersionInputSchema,
      capability: 'entitlements.catalog.write',
      risk: 'medium',
      target: (i) => ({ type: 'plan', id: i.planKey }),
      execute: async (ctx, input, tx) => ({ after: await this.catalog.createVersion(tx, ctx.actor.userId, input) }),
    });
    this.commands.register<PlanUpdateDraftInput>({
      key: 'entitlements.plan.updateDraft',
      version: 1,
      group: 'entitlements',
      titleKey: 'platform.commands.entitlementsPlanUpdateDraft.title',
      input: planUpdateDraftInputSchema,
      capability: 'entitlements.catalog.write',
      risk: 'medium',
      target: (i) => ({ type: 'plan_version', id: i.planVersionId }),
      execute: async (ctx, input, tx) => this.catalog.updateDraft(tx, ctx.actor.userId, input),
    });
    this.commands.register<PlanVersionRefInput>({
      key: 'entitlements.plan.publishVersion',
      version: 1,
      group: 'entitlements',
      titleKey: 'platform.commands.entitlementsPlanPublishVersion.title',
      descriptionKey: 'platform.commands.entitlementsPlanPublishVersion.description',
      input: planVersionRefInputSchema,
      capability: 'entitlements.catalog.write',
      risk: 'high',
      dryRun: true,
      target: (i) => ({ type: 'plan_version', id: i.planVersionId }),
      execute: async (ctx, input, tx) => this.catalog.publishVersion(tx, ctx.actor.userId, input.planVersionId),
    });
    this.commands.register<PlanVersionRefInput>({
      key: 'entitlements.plan.archiveVersion',
      version: 1,
      group: 'entitlements',
      titleKey: 'platform.commands.entitlementsPlanArchiveVersion.title',
      input: planVersionRefInputSchema,
      capability: 'entitlements.catalog.write',
      risk: 'high',
      target: (i) => ({ type: 'plan_version', id: i.planVersionId }),
      execute: async (ctx, input, tx) => this.catalog.archiveVersion(tx, ctx.actor.userId, input.planVersionId),
    });
    this.commands.register<SubscriptionSetInput>({
      key: 'entitlements.subscription.set',
      version: 1,
      group: 'entitlements',
      titleKey: 'platform.commands.entitlementsSubscriptionSet.title',
      descriptionKey: 'platform.commands.entitlementsSubscriptionSet.description',
      input: subscriptionSetInputSchema,
      capability: 'entitlements.subject.write',
      risk: 'high',
      // Ручная выдача тарифа — такое же повышение прав, как индивидуальное условие:
      // контроль стоит на ВСЕХ повышающих дверях, иначе обходится соседней
      dualControl: true,
      forbidSelfTarget: true,
      dryRun: true,
      entities: ['user', 'workspace'],
      target: (i) => subjectTarget(i.subject),
      execute: async (ctx, input, tx) => this.entitlements.setSubscription(tx, ctx.actor.userId, input),
    });
    this.commands.register<TrialExtendInput>({
      key: 'entitlements.trial.extend',
      version: 1,
      group: 'entitlements',
      titleKey: 'platform.commands.entitlementsTrialExtend.title',
      input: trialExtendInputSchema,
      capability: 'entitlements.subject.write',
      risk: 'high',
      forbidSelfTarget: true,
      entities: ['user', 'workspace'],
      target: (i) => subjectTarget(i.subject),
      execute: async (ctx, input, tx) => this.entitlements.extendTrial(tx, ctx.actor.userId, input),
    });
    this.commands.register<GrantCreateInput>({
      key: 'entitlements.grant.create',
      version: 1,
      group: 'entitlements',
      titleKey: 'platform.commands.entitlementsGrantCreate.title',
      descriptionKey: 'platform.commands.entitlementsGrantCreate.description',
      input: grantCreateInputSchema,
      capability: 'entitlements.grant.write',
      risk: 'high',
      // Грант со значением «без ограничения» равен оверрайду `unlimited` — значит и
      // ворота у него те же
      dualControl: true,
      forbidSelfTarget: true,
      entities: ['user', 'workspace'],
      target: (i) => subjectTarget(i.subject),
      execute: async (ctx, input, tx) => ({ after: await this.entitlements.createGrant(tx, ctx.actor.userId, input) }),
    });
    this.commands.register<GrantRevokeInput>({
      key: 'entitlements.grant.revoke',
      version: 1,
      group: 'entitlements',
      titleKey: 'platform.commands.entitlementsGrantRevoke.title',
      input: grantRevokeInputSchema,
      capability: 'entitlements.grant.write',
      risk: 'medium',
      // Отзыв выданного объясняют всегда: снятие компенсации человек почувствует
      reasonRequired: true,
      target: (i) => ({ type: 'entitlement_grant', id: i.grantId }),
      execute: async (ctx, input, tx) => this.entitlements.revokeGrant(tx, ctx.actor.userId, input.grantId),
    });
    this.commands.register<OverrideSetInput>({
      key: 'entitlements.override.set',
      version: 1,
      group: 'entitlements',
      titleKey: 'platform.commands.entitlementsOverrideSet.title',
      descriptionKey: 'platform.commands.entitlementsOverrideSet.description',
      input: overrideSetInputSchema,
      capability: 'entitlements.override.write',
      risk: 'high',
      dualControl: true,
      forbidSelfTarget: true,
      dryRun: true,
      entities: ['user', 'workspace'],
      target: (i) => subjectTarget(i.subject),
      execute: async (ctx, input, tx) => this.entitlements.setOverride(tx, ctx.actor.userId, input),
    });
    this.commands.register<OverrideClearInput>({
      key: 'entitlements.override.clear',
      version: 1,
      group: 'entitlements',
      titleKey: 'platform.commands.entitlementsOverrideClear.title',
      input: overrideClearInputSchema,
      capability: 'entitlements.override.write',
      risk: 'high',
      // Снятие — зеркало установки: условие `deny` (санкция) ставилось вдвоём, значит и
      // снимается вдвоём, под sudo и с причиной. Асимметрия «поставить/снять» и есть
      // обычная дыра в четырёх глазах.
      dualControl: true,
      forbidSelfTarget: true,
      entities: ['user', 'workspace'],
      target: (i) => subjectTarget(i.subject),
      execute: async (ctx, input, tx) => this.entitlements.clearOverride(tx, ctx.actor.userId, input.subject as EntitlementSubjectRef, input.key),
    });

    this.panels.register({
      key: 'user.entitlements',
      entity: 'user',
      titleKey: 'platform.panels.userEntitlements',
      capability: 'entitlements.subject.read',
      order: 30,
      load: async (_actor, id) => this.entitlements.subjectDetail({ type: 'user', id }),
    });
    this.panels.register({
      key: 'workspace.entitlements',
      entity: 'workspace',
      titleKey: 'platform.panels.workspaceEntitlements',
      capability: 'entitlements.subject.read',
      order: 30,
      load: async (_actor, id) => this.entitlements.subjectDetail({ type: 'workspace', id }),
    });
  }
}

/** Чтения движка для кабинета: каталог и карточка субъекта. Статика ДО :type/:id. */
@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformRoute()
@Controller('platform/entitlements')
export class EntitlementsPlatformController {
  constructor(
    private readonly catalog: EntitlementsCatalogService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: PlatformAuditService,
    private readonly rate: PlatformRateService,
  ) {}

  @PlatformCapability('entitlements.catalog.read')
  @Get('catalog')
  @ApiOperation({ summary: 'Plans with all versions and the free values of the registry' })
  async listCatalog() {
    return { success: true, data: await this.catalog.listCatalog() };
  }

  @PlatformCapability('entitlements.subject.read')
  @Get('subjects/:type/:id')
  @ApiOperation({ summary: 'Subject card: subscription, grants, overrides, counters, resolved snapshot' })
  async subject(@CurrentPlatformActor() actor: PlatformActor, @Param('type') type: string, @Param('id') id: string) {
    const subject = entitlementSubjectSchema.parse({ type, id }) as EntitlementSubjectRef;
    // Карточка субъекта — такое же чтение чужих данных, как панель: общий потолок
    // просмотров и строка журнала «кто на кого смотрел».
    await this.rate.assertViewBudget(actor);
    this.audit.logAccess({ actorId: actor.userId, kind: 'view', targetType: subject.type, targetId: subject.id, requestId: actor.requestId });
    return { success: true, data: await this.entitlements.subjectDetail(subject) };
  }
}
