import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  PLATFORM_ERROR_CODES,
  PLATFORM_LIMITS,
  maskIdNumber,
  maskPhoneForConsole,
  platformPiiRevealInputSchema,
  platformPolicySetInputSchema,
  platformStaffAddInputSchema,
  platformStaffRoleGrantInputSchema,
  platformStaffRoleRevokeInputSchema,
  platformStaffSuspendInputSchema,
  type PlatformPiiRevealInput,
  type PlatformPiiRevealResultDto,
  type PlatformPolicySetInput,
  type PlatformStaffAddInput,
  type PlatformStaffRoleGrantInput,
  type PlatformStaffRoleRevokeInput,
  type PlatformStaffSuspendInput,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, notFound, tooMany } from '../../shared/errors/api-error';
import { PlatformAccessService } from './platform-access.service';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformCommandRegistry } from './platform-commands.registry';
import { PlatformLookupRegistry, PlatformPanelRegistry } from './platform-lookup.registry';
import { PlatformPolicyService } from './platform-policy.service';
import { PlatformNotifier } from './platform.notifications';

/**
 * Команды и панели самого кабинета: сотрудники, роли, политика, раскрытие PII.
 * Раскрытие PII — команда (medium, причина обязательна, 20/час): каждое — строка
 * журнала команд и журнала чтений.
 */
@Injectable()
export class PlatformProvider implements OnModuleInit {
  private readonly logger = new Logger(PlatformProvider.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly commands: PlatformCommandRegistry,
    private readonly panels: PlatformPanelRegistry,
    private readonly lookup: PlatformLookupRegistry,
    private readonly access: PlatformAccessService,
    private readonly audit: PlatformAuditService,
    private readonly auth: PlatformAuthService,
    private readonly policy: PlatformPolicyService,
    private readonly notifier: PlatformNotifier,
  ) {}

  onModuleInit(): void {
    this.registerCommands();
    this.registerPanels();
  }

  private registerCommands(): void {
    this.commands.register<PlatformStaffAddInput>({
      key: 'platform.staff.add',
      version: 1,
      group: 'platform',
      titleKey: 'platform.commands.platformStaffAdd.title',
      descriptionKey: 'platform.commands.platformStaffAdd.description',
      input: platformStaffAddInputSchema,
      capability: 'platform.staff.write',
      risk: 'critical',
      // Состав штата платформы меняем вдвоём (мягко: при единственном владельце —
      // напрямую, иначе второго сотрудника некому было бы добавить)
      dualControl: true,
      dualControlSoft: true,
      entities: ['user'],
      target: (i) => ({ type: 'user', id: i.userId }),
      execute: async (ctx, input, tx) => {
        const after = await this.access.addStaff(tx, ctx.actor.userId, input, ctx.reason ?? '');
        await this.notifier.securityAlert(tx, ctx.actor.userId, 'staffAdded', input.userId);
        return { after, invalidateStaff: [input.userId] };
      },
    });

    this.commands.register<PlatformStaffSuspendInput>({
      key: 'platform.staff.suspend',
      version: 1,
      group: 'platform',
      titleKey: 'platform.commands.platformStaffSuspend.title',
      descriptionKey: 'platform.commands.platformStaffSuspend.description',
      input: platformStaffSuspendInputSchema,
      capability: 'platform.staff.write',
      risk: 'critical',
      // Состав штата платформы меняем вдвоём (мягко: при единственном владельце —
      // напрямую, иначе второго сотрудника некому было бы добавить)
      dualControl: true,
      dualControlSoft: true,
      entities: ['user'],
      target: (i) => ({ type: 'user', id: i.userId }),
      execute: async (ctx, input, tx) => {
        const res = await this.access.suspendStaff(tx, ctx.actor.userId, input.userId);
        await this.auth.revokeAll(tx, input.userId);
        await this.notifier.securityAlert(tx, ctx.actor.userId, 'staffSuspended', input.userId);
        return { ...res, invalidateStaff: [input.userId] };
      },
    });

    this.commands.register<PlatformStaffRoleGrantInput>({
      key: 'platform.staff.role.grant',
      version: 1,
      group: 'platform',
      titleKey: 'platform.commands.platformStaffRoleGrant.title',
      descriptionKey: 'platform.commands.platformStaffRoleGrant.description',
      input: platformStaffRoleGrantInputSchema,
      capability: 'platform.staff.write',
      risk: 'critical',
      // Состав штата платформы меняем вдвоём (мягко: при единственном владельце —
      // напрямую, иначе второго сотрудника некому было бы добавить)
      dualControl: true,
      dualControlSoft: true,
      entities: ['user'],
      target: (i) => ({ type: 'user', id: i.userId }),
      execute: async (ctx, input, tx) => {
        const before = await this.access.staffOf(input.userId);
        const after = await this.access.grantRole(tx, ctx.actor.userId, input, ctx.reason ?? '');
        await this.notifier.securityAlert(tx, ctx.actor.userId, 'roleGranted', `${input.role} → ${input.userId}`);
        return { before, after, invalidateStaff: [input.userId] };
      },
    });

    this.commands.register<PlatformStaffRoleRevokeInput>({
      key: 'platform.staff.role.revoke',
      version: 1,
      group: 'platform',
      titleKey: 'platform.commands.platformStaffRoleRevoke.title',
      input: platformStaffRoleRevokeInputSchema,
      capability: 'platform.staff.write',
      risk: 'critical',
      // Состав штата платформы меняем вдвоём (мягко: при единственном владельце —
      // напрямую, иначе второго сотрудника некому было бы добавить)
      dualControl: true,
      dualControlSoft: true,
      entities: ['user'],
      target: (i) => ({ type: 'user', id: i.userId }),
      execute: async (ctx, input, tx) => {
        const res = await this.access.revokeRole(tx, ctx.actor.userId, input.userId, input.role);
        await this.notifier.securityAlert(tx, ctx.actor.userId, 'roleRevoked', `${input.role} ← ${input.userId}`);
        return { ...res, invalidateStaff: [input.userId] };
      },
    });

    this.commands.register<PlatformPolicySetInput>({
      key: 'platform.policy.set',
      version: 1,
      group: 'platform',
      titleKey: 'platform.commands.platformPolicySet.title',
      descriptionKey: 'platform.commands.platformPolicySet.description',
      input: platformPolicySetInputSchema,
      capability: 'platform.policy.write',
      risk: 'critical',
      // Сам тумблер «четырёх глаз» тоже под ними: иначе один человек выключал бы контроль
      // и делал что угодно (мягко — пока владелец один)
      dualControl: true,
      dualControlSoft: true,
      target: () => ({ type: 'platform_policy', id: 'default' }),
      execute: async (ctx, input, tx) => {
        const res = await this.policy.set(tx, ctx.actor.userId, input);
        await this.notifier.securityAlert(tx, ctx.actor.userId, 'policyChanged', `dualControlEnabled=${input.dualControlEnabled}`);
        return res;
      },
    });

    this.commands.register<PlatformPiiRevealInput>({
      key: 'platform.pii.reveal',
      version: 1,
      group: 'platform',
      titleKey: 'platform.commands.platformPiiReveal.title',
      descriptionKey: 'platform.commands.platformPiiReveal.description',
      input: platformPiiRevealInputSchema,
      capability: 'platform.pii.reveal',
      risk: 'medium',
      // Раскрытие персональных данных — под SMS-подтверждением: у украденной сессии
      // телефона сотрудника нет, а окно sudo (15 минут) не мучает серию обращений
      stepUp: true,
      // Причина обязательна и у medium: раскрытие персональных данных — всегда с объяснением
      // (гейт в исполнителе, паспорт несёт флаг вебу); результат (полный телефон) в журнал
      // НЕ пишется — только факт и поля (S7)
      reasonRequired: true,
      redact: [],
      persistResult: false,
      entities: ['user', 'workspace'],
      target: (i) => ({ type: i.entity, id: i.id }),
      execute: async (ctx, input) => {
        // Страховка: гейт причины стоит в исполнителе (reasonRequired), но команда
        // вызывается и одобренной заявкой — без причины она не исполняется никогда.
        if (!ctx.reason || ctx.reason.length < PLATFORM_LIMITS.reasonMinLength) {
          throw badRequest('platform.reason_required', { min: PLATFORM_LIMITS.reasonMinLength }, { code: PLATFORM_ERROR_CODES.reasonRequired });
        }
        const reveals = await this.audit.accessCount(ctx.actor.userId, 'reveal', 3_600_000);
        if (reveals >= PLATFORM_LIMITS.piiRevealsPerHour) {
          throw tooMany('platform.rate_limited', undefined, { code: PLATFORM_ERROR_CODES.rateLimited, resendInSec: 3600 });
        }
        const result = await this.reveal(input);
        this.audit.logAccess({ actorId: ctx.actor.userId, kind: 'reveal', targetType: input.entity, targetId: input.id, fields: input.fields, requestId: ctx.actor.requestId });
        if (reveals + 1 === PLATFORM_LIMITS.piiRevealsPerHour) {
          await this.notifier.securityAlert(null, ctx.actor.userId, 'piiRevealBurst', `${reveals + 1}/h`);
        }
        // В журнал команд результат НЕ кладём (S7): раскрытое значение живёт только в ответе
        return { result, after: { revealed: input.fields } };
      },
    });
  }

  private async reveal(input: PlatformPiiRevealInput): Promise<PlatformPiiRevealResultDto> {
    const fields: Record<string, string | null> = {};
    if (input.entity === 'user') {
      const u = await this.db.user.findUnique({
        where: { id: input.id },
        select: { phone: true, iin: true, residentialAddress: true, idDocNumber: true, email: true },
      });
      if (!u) throw notFound('platform.entity_not_found');
      for (const f of input.fields) {
        if (f === 'phone') fields.phone = u.phone;
        else if (f === 'iin') fields.iin = u.iin;
        else if (f === 'residentialAddress') fields.residentialAddress = u.residentialAddress;
        else if (f === 'idDocNumber') fields.idDocNumber = u.idDocNumber;
        else if (f === 'email') fields.email = u.email;
      }
    } else {
      const w = await this.db.workspace.findUnique({ where: { id: input.id }, select: { contactPhone: true, contactEmail: true } });
      if (!w) throw notFound('platform.entity_not_found');
      // БИН — ГОЛОВНОГО юрлица (`isHead`), как в реквизитах; без головного берём старейшее живое
      const head =
        (await this.db.legalEntity.findFirst({ where: { workspaceId: input.id, isHead: true, archivedAt: null }, select: { bin: true } })) ??
        (await this.db.legalEntity.findFirst({ where: { workspaceId: input.id, archivedAt: null }, orderBy: { createdAt: 'asc' }, select: { bin: true } }));
      for (const f of input.fields) {
        if (f === 'phone') fields.phone = w.contactPhone;
        else if (f === 'bin') fields.bin = head?.bin ?? null;
        else if (f === 'email') fields.email = w.contactEmail;
      }
    }
    return { entity: input.entity, id: input.id, fields };
  }

  private registerPanels(): void {
    this.panels.register({
      key: 'user.staff',
      entity: 'user',
      titleKey: 'platform.panels.userStaff',
      capability: 'platform.staff.read',
      order: 40,
      load: async (_actor, id) => this.access.staffOf(id),
    });
    this.panels.register({
      key: 'user.audit',
      entity: 'user',
      titleKey: 'platform.panels.userAudit',
      capability: 'platform.audit.read',
      order: 90,
      load: async (_actor, id) => this.audit.list({ targetType: 'user', targetId: id, limit: 20 }),
    });
    this.panels.register({
      key: 'workspace.audit',
      entity: 'workspace',
      titleKey: 'platform.panels.workspaceAudit',
      capability: 'platform.audit.read',
      order: 90,
      load: async (_actor, id) => this.audit.list({ targetType: 'workspace', targetId: id, limit: 20 }),
    });
    // Маски для провайдеров поиска (владельцы сущностей подставляют их в свои хиты)
    void maskPhoneForConsole;
    void maskIdNumber;
    void this.lookup;
  }
}
