import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ESUTD_KINDS, HR_DEADLINE_RULE_MAP, HR_LIMITS, hrMemberHref } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { JobsRegistry } from '../../core/jobs/jobs.registry';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { RedisService } from '../../shared/redis/redis.service';
import { HrActionsService } from './hr-actions.service';
import { HrCalendarService } from './hr-calendar.service';
import { HR_APPLY_JOB, HR_BATCH_JOB, HR_QUEUE } from './hr.constants';
import { fullName } from '../../shared/utils/user-name';

/**
 * Фоновая работа КЭДО: применение действия в дату вступления (transactional
 * outbox), исполнение массовых операций, ежедневные предупреждения о сроках
 * (ЕСУТД, испытательные, срочные договоры).
 */
@Injectable()
export class HrJobs implements OnModuleInit {
  private readonly logger = new Logger(HrJobs.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: JobsRegistry,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
    private readonly actions: HrActionsService,
    private readonly calendar: HrCalendarService,
  ) {}

  onModuleInit(): void {
    // Применение идемпотентно (статус-клейм в applyAction) — at-least-once безопасен.
    // Ошибка проверки законности — НЕ throw: applyAction сам пишет failed.
    this.registry.register(HR_APPLY_JOB, (p) => this.actions.applyAction(String(p.hrActionId)), {
      queue: HR_QUEUE,
      maxAttempts: 5,
      leaseMs: 5 * 60 * 1000,
    });
    this.registry.register(HR_BATCH_JOB, (p) => this.actions.runBatch(String(p.batchId)), {
      queue: HR_QUEUE,
      maxAttempts: 3,
      // Пачка до 500 действий с созданием документов — щедрая аренда
      leaseMs: 30 * 60 * 1000,
    });
  }

  /**
   * Ежедневные предупреждения (09:05 по серверу): ЕСУТД-сроки, вручения актов,
   * испытательные, срочные договоры. Дедуп — `Notification.dedupKey` с датой.
   */
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async dailyWarnings(): Promise<void> {
    await this.redis.withLock('hr:daily-warnings', 10 * 60_000, async () => {
      try {
        await this.warnEsutd();
        await this.warnDeliveries();
        await this.warnProbations();
        await this.warnContracts();
      } catch (e) {
        this.logger.error(`hr daily warnings: ${(e as Error).message}`);
      }
    });
  }

  private async managersOf(workspaceId: string): Promise<string[]> {
    const rows = await this.db.userRole.findMany({
      where: {
        context: 'workspace',
        tenantId: workspaceId,
        isActive: true,
        role: { in: ['manager', 'admin', 'owner'] },
      },
      select: { userId: true },
    });
    return [...new Set(rows.map((r) => r.userId))];
  }

  private async nameOf(userId: string): Promise<string> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
    return u ? fullName(u) : 'Сотрудник';
  }

  /** ЕСУТД: осталось ≤ 2 рабочих дней (или просрочено) — управляющим */
  private async warnEsutd(): Promise<void> {
    const today = this.calendar.today();
    const rows = await this.db.esutdSubmission.findMany({
      where: { status: 'pending' },
      orderBy: { dueAt: 'asc' },
      take: 500,
    });
    for (const r of rows) {
      const due = r.dueAt.toISOString().slice(0, 10);
      const left = await this.calendar.workDaysLeft(today, due);
      if (left === null || left > 2) continue;
      const managers = await this.managersOf(r.workspaceId);
      const kindLabel = ESUTD_KINDS.find((k) => k.value === r.kind)?.label ?? r.kind;
      const daysLeft = left < 0 ? `просрочено (${-left} раб. дн.)` : left === 0 ? 'сегодня' : `${left} раб. дн.`;
      for (const uid of managers) {
        await this.notifications
          .notify(
            uid,
            'hr.esutd.due_soon',
            { kindLabel, targetName: await this.nameOf(r.userId), daysLeft, workspaceId: r.workspaceId },
            {
              actionUrl: `/workspaces/${r.workspaceId}/members?tab=deadlines`,
              dedupKey: `esutd:${r.id}:${today}:${uid}`,
            },
          )
          .catch(() => undefined);
      }
    }
  }

  /**
   * Вручение актов (виды со specialDelivery): подписанный акт без фиксации
   * вручения, осталось ≤ 1 рабочего дня из трёх (или просрочено) — управляющим
   * (ст. 61 п. 3 ТК РК). Пассивная секция «Кадровые сроки» показывает то же,
   * но срок в 3 РД слишком короток, чтобы полагаться на «кадровик сам зайдёт».
   */
  private async warnDeliveries(): Promise<void> {
    const today = this.calendar.today();
    const rows = await this.db.orgDocument.findMany({
      where: {
        deliveredAt: null,
        status: { in: ['signed', 'registered', 'active'] },
        docType: { specialDelivery: true },
      },
      orderBy: { signedAt: 'asc' },
      take: 500,
      select: { id: true, workspaceId: true, title: true, number: true, signedAt: true, createdAt: true },
    });
    for (const r of rows) {
      const base = (r.signedAt ?? r.createdAt).toISOString().slice(0, 10);
      let due: string;
      try {
        due = await this.calendar.addWorkDays(base, HR_DEADLINE_RULE_MAP.termination_act_delivery.amount);
      } catch {
        continue; // за горизонтом календаря — предупреждать не по чему
      }
      const left = await this.calendar.workDaysLeft(today, due);
      if (left === null || left > 1) continue;
      const title = r.number ? `${r.title} № ${r.number}` : r.title;
      for (const uid of await this.managersOf(r.workspaceId)) {
        await this.notifications
          .notify(
            uid,
            'hr.delivery.due',
            { title, workspaceId: r.workspaceId },
            {
              actionUrl: `/workspaces/${r.workspaceId}/documents/${r.id}`,
              dedupKey: `hrdel:${r.id}:${today}:${uid}`,
            },
          )
          .catch(() => undefined);
      }
    }
  }

  /** Испытательные сроки: за N дней до конца — управляющим (ст. 37 ТК РК) */
  private async warnProbations(): Promise<void> {
    const today = this.calendar.today();
    const horizon = this.calendar.addCalendarDays(today, HR_LIMITS.probationWarnDays);
    const rows = await this.db.employment.findMany({
      where: {
        status: { in: ['draft', 'active'] },
        probationUntil: { gte: new Date(today), lte: new Date(horizon) },
      },
      take: 500,
      select: { id: true, workspaceId: true, userId: true, probationUntil: true },
    });
    for (const r of rows) {
      const until = r.probationUntil!.toISOString().slice(0, 10).split('-').reverse().join('.');
      for (const uid of await this.managersOf(r.workspaceId)) {
        await this.notifications
          .notify(
            uid,
            'hr.probation.ending',
            { targetName: await this.nameOf(r.userId), until, workspaceId: r.workspaceId },
            // Ключ с датой рубежа: перенесли испытание — предупреждение придёт заново
            { actionUrl: hrMemberHref(r.workspaceId, r.userId), dedupKey: `hrprob:${r.id}:${until}:${uid}` },
          )
          .catch(() => undefined);
      }
    }
  }

  /** Срочные договоры: за N дней до конца — управляющим (ст. 30 ТК РК) */
  private async warnContracts(): Promise<void> {
    const today = this.calendar.today();
    const horizon = this.calendar.addCalendarDays(today, HR_LIMITS.contractWarnDays);
    const rows = await this.db.employment.findMany({
      where: {
        status: { in: ['draft', 'active'] },
        contractType: { in: ['fixed_term', 'seasonal', 'task_based'] },
        contractEndAt: { gte: new Date(today), lte: new Date(horizon) },
      },
      take: 500,
      select: { id: true, workspaceId: true, userId: true, contractEndAt: true },
    });
    for (const r of rows) {
      const until = r.contractEndAt!.toISOString().slice(0, 10).split('-').reverse().join('.');
      for (const uid of await this.managersOf(r.workspaceId)) {
        await this.notifications
          .notify(
            uid,
            'hr.contract.expiring',
            { targetName: await this.nameOf(r.userId), until, workspaceId: r.workspaceId },
            { actionUrl: hrMemberHref(r.workspaceId, r.userId), dedupKey: `hrcontr:${r.id}:${until}:${uid}` },
          )
          .catch(() => undefined);
      }
    }
  }
}
