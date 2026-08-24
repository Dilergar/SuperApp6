import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import { createHash } from 'node:crypto';
import {
  DOC_CAMPAIGN_REF_TYPE,
  HR_LIMITS,
  ORG_DOCUMENT_REF_TYPE,
  SIGN_FILE_PROFILES,
  WORKSPACE_ROLE_RANK,
  signRequestHref,
  type CreateCampaignInput,
  type DocCampaignDetailDto,
  type DocCampaignDto,
  type HrActorLite,
  type InboxItemDto,
  type MyCampaignTaskDto,
  type WorkspaceRole,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RolesService } from '../../core/roles/roles.service';
import { ChatterService } from '../../core/chatter/chatter.service';
import { JobsRegistry } from '../../core/jobs/jobs.registry';
import { JobsService } from '../../core/jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ApprovalsRegistry } from '../../core/approvals/approvals.registry';
import { SignRegistry } from '../../core/sign/sign.registry';
import { SignService } from '../../core/sign/sign.service';
import { FilesService } from '../../core/files/files.service';
import { RedisService } from '../../shared/redis/redis.service';
import { withTempFile } from '../../shared/fs/temp-file.util';
import { fullName } from '../../shared/utils/user-name';

const WS_CONTEXT = 'workspace';
const CAMPAIGN_RUN_JOB = 'documents.campaign.run';

/**
 * Кампании ознакомления (Этап 5 КЭДО). Ст. 23 п. 2 пп. 6 ТК РК: факт
 * ознакомления подписи НЕ требует — режим `click` (дефолт) фиксирует
 * acknowledgedAt + sha256 замороженного предмета + хронику; `sms` — акты ПЭП
 * на заявке refType='doc_campaign' (усиленное доказательство для критичных ЛНА).
 *
 * Одна заморозка предмета на ВСЮ кампанию; потолок 5000 адресатов, исполнение
 * пачками через core/jobs; недоставленная SMS — отдельный исход `sms_failed`.
 */
@Injectable()
export class DocCampaignsService implements OnModuleInit {
  private readonly logger = new Logger(DocCampaignsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly roles: RolesService,
    private readonly chatter: ChatterService,
    private readonly jobsRegistry: JobsRegistry,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
    private readonly approvalsRegistry: ApprovalsRegistry,
    private readonly signRegistry: SignRegistry,
    private readonly sign: SignService,
    private readonly files: FilesService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    // Материализация адресатов — пачками (транзакционный outbox, идемпотентно)
    this.jobsRegistry.register(CAMPAIGN_RUN_JOB, (p) => this.runCampaign(String(p.campaignId)), {
      queue: 'documents',
      maxAttempts: 5,
      leaseMs: 15 * 60 * 1000,
    });

    // ---- Стопка «Ждут решения»: источник hr_campaign ----
    // Заявок approvals НЕ создаётся намеренно: это обошло бы кап снимка 500,
    // maxSteps и перф awaitingUserIds — кампания живёт своей моделью.
    this.approvalsRegistry.registerSource('hr_campaign', {
      label: 'Ознакомления',
      count: (userId, scope) =>
        this.db.docCampaignTarget.count({
          where: {
            userId,
            status: 'pending',
            campaign: {
              status: 'active',
              ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
              // Кампании всегда в организации — «только личное» их не показывает
              ...(scope.personalOnly ? { workspaceId: '__none__' } : {}),
            },
          },
        }),
      list: (userId, limit, scope) => this.inboxList(userId, limit, scope),
      // Ушёл из организации — снимаем с него незакрытые задания (движок зовёт
      // это из общего каскада увольнения, тем же правилом, что снимает с шагов).
      releaseUser: (userId, workspaceId) => this.releaseUser(userId, workspaceId),
    });

    // ---- Движок подписи: кампания как предмет (sms-режим) ----
    this.signRegistry.register(DOC_CAMPAIGN_REF_TYPE, {
      resolveSubject: async (refId) => {
        const campaign = await this.db.docCampaign.findUnique({ where: { id: refId } });
        if (!campaign || campaign.status === 'cancelled') return null;
        return {
          fileId: campaign.subjectFileId,
          title: campaign.title,
          icon: 'eye',
          workspaceId: campaign.workspaceId,
          ownerType: 'workspace',
          ownerId: campaign.workspaceId,
        };
      },
      canRequestSign: async (userId, refId) => {
        const campaign = await this.db.docCampaign.findUnique({ where: { id: refId }, select: { workspaceId: true } });
        if (!campaign) return false;
        return this.isManager(await this.roleOf(userId, campaign.workspaceId));
      },
      canView: async (userId, refId) => {
        const campaign = await this.db.docCampaign.findUnique({ where: { id: refId }, select: { workspaceId: true } });
        if (!campaign) return false;
        const target = await this.db.docCampaignTarget.count({ where: { campaignId: refId, userId } });
        if (target > 0) return true;
        return this.isManager(await this.roleOf(userId, campaign.workspaceId));
      },
      describeForVerify: async (refId) => {
        const campaign = await this.db.docCampaign.findUnique({
          where: { id: refId },
          include: { workspace: { select: { name: true } } },
        });
        if (!campaign) return null;
        return { title: campaign.title, kindLabel: 'Ознакомление', orgLabel: campaign.workspace.name };
      },
      onActFinished: async (refId, info) => {
        if (info.outcome !== 'signed' || !info.signerUserId) return;
        await this.markAcknowledged(refId, info.signerUserId, { signActId: info.actId }).catch((e) =>
          this.logger.warn(`campaign ack ${refId}: ${(e as Error).message}`),
        );
      },
    });
  }

  // ---------- Гейты (лестница ролей — прецедент documents) ----------

  private async roleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const roles = await this.roles.getRolesInContext(userId, WS_CONTEXT, workspaceId);
    if (roles.length === 0) return null;
    return roles
      .map((r) => r.role as WorkspaceRole)
      .sort((a, b) => (WORKSPACE_ROLE_RANK[b] ?? 0) - (WORKSPACE_ROLE_RANK[a] ?? 0))[0];
  }

  private isManager(role: WorkspaceRole | null): boolean {
    return !!role && (WORKSPACE_ROLE_RANK[role] ?? 0) >= WORKSPACE_ROLE_RANK.manager;
  }

  private async requireManager(userId: string, workspaceId: string): Promise<void> {
    if (!this.isManager(await this.roleOf(userId, workspaceId))) {
      throw new ForbiddenException('Кампании ознакомления ведёт Менеджер или выше');
    }
  }

  private async nameOf(userId: string): Promise<string> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
    return u ? fullName(u) : 'Кто-то';
  }

  // ============================================================
  // Создание
  // ============================================================

  async create(actorId: string, workspaceId: string, dto: CreateCampaignInput): Promise<DocCampaignDto> {
    await this.requireManager(actorId, workspaceId);
    const doc = await this.db.orgDocument.findFirst({
      where: { id: dto.orgDocumentId, workspaceId },
      include: { docType: { select: { name: true } } },
    });
    if (!doc) throw new NotFoundException('Документ не найден');
    // Кампания открывает предмет ВСЕМ адресатам (ветка campaignDocIds в
    // visibilityWhere) — по отменённому документу знакомить не с чем.
    if (doc.status === 'cancelled') {
      throw new BadRequestException('Документ отменён — кампания ознакомления по нему не запускается');
    }

    // Одна заморозка на всю кампанию: что видел КАЖДЫЙ адресат. Берём печатный
    // PDF (у builder-документа файл и есть PDF); без отпечатка — честный отказ.
    const sourceFileId = doc.builderDoc ? doc.fileId : (doc.pdfFileId ?? (doc.fileId && !doc.documentId ? doc.fileId : null));
    if (!sourceFileId) {
      throw new BadRequestException('У документа нет печатного PDF — сначала снимите отпечаток на карточке');
    }
    const variant = !doc.builderDoc && doc.pdfFileId === doc.fileId && !!doc.documentId ? 'pdf' : undefined;
    const { result, mime, name } = await this.files.openRawStream(sourceFileId, variant ?? null);
    const bytes = await streamToBuffer(result.stream);
    if (bytes.length === 0) throw new BadRequestException('Файл документа пуст');
    const frozen = await withTempFile(name, bytes, (filePath) =>
      this.files.ingestLocalFile({
        path: filePath,
        name,
        mime,
        // Профиль доказательств: вне квоты, вне реапа, не удаляется никем —
        // «с чем именно ознакомился» обязано жить вечно.
        profile: SIGN_FILE_PROFILES.subject,
        ownerUserId: actorId,
        ownerType: 'workspace',
        ownerId: workspaceId,
      }),
    );
    const sha256 = frozen.sha256 ?? createHash('sha256').update(bytes).digest('hex');

    const userIds = await this.resolveAudience(workspaceId, dto.audience);
    if (userIds.length === 0) throw new BadRequestException('Аудитория пуста — знакомить некого');
    if (userIds.length > HR_LIMITS.campaignMaxTargets) {
      throw new BadRequestException(
        `Потолок кампании — ${HR_LIMITS.campaignMaxTargets} адресатов (выбрано ${userIds.length})`,
      );
    }

    const fixMode = dto.fixMode ?? 'click';
    const campaign = await this.db.docCampaign.create({
      data: {
        workspaceId,
        title: dto.title ?? (doc.number ? `${doc.title} № ${doc.number}` : doc.title),
        orgDocumentId: doc.id,
        subjectFileId: frozen.id,
        subjectSha256: sha256,
        mode: dto.mode ?? 'one_off',
        fixMode,
        audience: dto.audience as object[],
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        createdById: actorId,
      },
    });

    // SMS-режим: одна ВЕЧНАЯ заявка ПЭП на кампанию (refType='doc_campaign' —
    // обходит партиальный уникум «одна живая свободная заявка на предмет» у
    // org_document, иначе standing-кампания блокировала бы любую другую подпись
    // документа); акты дописывает пачками джоб.
    if (fixMode === 'sms') {
      try {
        const request = await this.sign.createRequest(
          actorId,
          { refType: DOC_CAMPAIGN_REF_TYPE, refId: campaign.id, level: 'pep' },
          { neverExpires: true, noInitialActs: true, suppressOutcomeNotify: true },
        );
        await this.db.docCampaign.update({ where: { id: campaign.id }, data: { signRequestId: request.id } });
      } catch (e) {
        // Без заявки sms-кампания — ТУПИК: акты адресатам не заводятся, а клик в
        // ней запрещён, то есть ознакомиться нельзя ни одним путём. Гасим её и
        // отвечаем честно, вместо «создана» с неработающими заданиями.
        await this.db.docCampaign
          .update({ where: { id: campaign.id }, data: { status: 'cancelled', completedAt: new Date() } })
          .catch(() => undefined);
        throw new BadRequestException(
          `Кампания с подтверждением по SMS не запустилась: ${(e as Error).message}`,
        );
      }
    }

    await this.jobs.enqueue(null, {
      type: CAMPAIGN_RUN_JOB,
      payload: { campaignId: campaign.id },
      uniqueKey: `dcrun:${campaign.id}:init`,
    });

    await this.chatter
      .log(null, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: doc.id,
        workspaceId,
        actorId,
        actorName: await this.nameOf(actorId),
        typeKey: 'hr.campaign_started',
        payload: { title: campaign.title, total: userIds.length },
      })
      .catch(() => undefined);

    return this.serialize(campaign);
  }

  /**
   * Материализация адресатов пачками (идемпотентно: skipDuplicates + дедуп
   * уведомлений). Для standing-кампаний тот же джоб ДОГОНЯЕТ принятых позже —
   * его перезапускает ежедневный крон.
   */
  private async runCampaign(campaignId: string): Promise<void> {
    const campaign = await this.db.docCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.status !== 'active') return;
    const audience = (campaign.audience ?? []) as { type: string; id: string }[];
    const userIds = await this.resolveAudience(campaign.workspaceId, audience);
    // Создание отказывает честно выше потолка; сюда переполнение доходит только
    // у standing-кампании, чья аудитория ВЫРОСЛА после старта. Молчаливой
    // обрезки не оставляем — громкий след (правило «no silent caps»).
    if (userIds.length > HR_LIMITS.campaignMaxTargets) {
      this.logger.warn(
        `campaign ${campaignId}: аудитория ${userIds.length} превысила потолок ${HR_LIMITS.campaignMaxTargets} — лишние адресаты НЕ материализованы (разбейте кампанию по подразделениям)`,
      );
    }
    const capped = userIds.slice(0, HR_LIMITS.campaignMaxTargets);

    for (let i = 0; i < capped.length; i += HR_LIMITS.campaignChunkSize) {
      const chunk = capped.slice(i, i + HR_LIMITS.campaignChunkSize);
      const existing = await this.db.docCampaignTarget.findMany({
        where: { campaignId, userId: { in: chunk } },
        select: { userId: true },
      });
      const known = new Set(existing.map((e) => e.userId));
      const fresh = chunk.filter((id) => !known.has(id));
      if (!fresh.length) continue;
      await this.db.docCampaignTarget.createMany({
        data: fresh.map((userId) => ({ campaignId, userId })),
        skipDuplicates: true,
      });
      if (campaign.fixMode === 'sms' && campaign.signRequestId) {
        await this.sign.systemEnsureActs(campaign.signRequestId, fresh);
      }
      const ws = await this.db.workspace.findUnique({ where: { id: campaign.workspaceId }, select: { name: true } });
      for (const userId of fresh) {
        await this.notifications
          .notify(
            userId,
            'hr.campaign.assigned',
            { title: campaign.title, workspaceName: ws?.name ?? '', workspaceId: campaign.workspaceId },
            {
              actionUrl:
                campaign.fixMode === 'sms' && campaign.signRequestId
                  ? signRequestHref(campaign.signRequestId, campaign.workspaceId)
                  : `/workspaces/${campaign.workspaceId}/documents/${campaign.orgDocumentId}`,
              dedupKey: `dcassign:${campaignId}:${userId}`,
            },
          )
          .catch(() => undefined);
      }
    }
  }

  /** Ежедневно: standing-кампании догоняют новичков; напоминания по сроку */
  @Cron(CronExpression.EVERY_DAY_AT_10AM)
  async dailySweep(): Promise<void> {
    await this.redis.withLock('doc-campaigns:daily', 10 * 60_000, async () => {
      const standing = await this.db.docCampaign.findMany({
        where: { status: 'active', mode: 'standing' },
        select: { id: true },
        take: 500,
      });
      for (const c of standing) {
        await this.jobs
          .enqueue(null, {
            type: CAMPAIGN_RUN_JOB,
            payload: { campaignId: c.id },
            uniqueKey: `dcrun:${c.id}:${new Date().toISOString().slice(0, 10)}`,
          })
          .catch(() => undefined);
      }
      await this.remindPending().catch((e) => this.logger.warn(`campaign reminders: ${(e as Error).message}`));
    });
  }

  /** Напоминание неознакомившимся: раз в 3 дня после назначения (дедуп remindedAt) */
  private async remindPending(): Promise<void> {
    const threshold = new Date(Date.now() - 3 * 86_400_000);
    const targets = await this.db.docCampaignTarget.findMany({
      where: {
        status: 'pending',
        campaign: { status: 'active' },
        createdAt: { lte: threshold },
        OR: [{ remindedAt: null }, { remindedAt: { lte: threshold } }],
      },
      include: { campaign: { select: { id: true, title: true, workspaceId: true, fixMode: true, signRequestId: true, orgDocumentId: true } } },
      take: 500,
    });
    for (const t of targets) {
      await this.notifications
        .notify(
          t.userId,
          'hr.campaign.reminder',
          { title: t.campaign.title, workspaceId: t.campaign.workspaceId },
          {
            actionUrl:
              t.campaign.fixMode === 'sms' && t.campaign.signRequestId
                ? signRequestHref(t.campaign.signRequestId, t.campaign.workspaceId)
                : `/workspaces/${t.campaign.workspaceId}/documents/${t.campaign.orgDocumentId}`,
            dedupKey: `dcremind:${t.id}:${new Date().toISOString().slice(0, 10)}`,
          },
        )
        .catch(() => undefined);
      await this.db.docCampaignTarget.update({ where: { id: t.id }, data: { remindedAt: new Date() } }).catch(() => undefined);
    }
  }

  // ============================================================
  // Фиксация ознакомления
  // ============================================================

  /**
   * Отметка «Ознакомлен» (click-режим — сам адресат; sms-режим сюда приходит
   * из хука подписи с signActId). Вечный след: sha256 замороженного предмета
   * пишется В TARGET + хроника; личная запись-архив — kind 'acknowledged'.
   */
  async markAcknowledged(campaignId: string, userId: string, opts: { signActId?: string } = {}): Promise<void> {
    const campaign = await this.db.docCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new NotFoundException('Кампания не найдена');
    // Идемпотентность РАНЬШЕ статуса кампании: one_off закрывается последним
    // ознакомившимся, и его же повторный клик (двойной тап, ретрай хука) не должен
    // отвечать «кампания уже завершена» — событие уже записано, это успех.
    const mine = await this.db.docCampaignTarget.findFirst({
      where: { campaignId, userId },
      select: { status: true },
    });
    if (mine?.status === 'acknowledged') return;
    if (campaign.status !== 'active') throw new BadRequestException('Кампания уже завершена');
    if (campaign.fixMode === 'sms' && !opts.signActId) {
      throw new BadRequestException('В этой кампании ознакомление подтверждается кодом из SMS — откройте документ на подпись');
    }
    const claimed = await this.db.docCampaignTarget.updateMany({
      where: { campaignId, userId, status: 'pending' },
      data: {
        status: 'acknowledged',
        acknowledgedAt: new Date(),
        subjectSha256: campaign.subjectSha256,
        signActId: opts.signActId ?? null,
      },
    });
    if (claimed.count === 0) {
      const exists = await this.db.docCampaignTarget.count({ where: { campaignId, userId } });
      if (!exists) throw new ForbiddenException('Вы не адресат этой кампании');
      return; // уже ознакомлен — идемпотентно
    }

    await this.chatter
      .log(null, {
        refType: ORG_DOCUMENT_REF_TYPE,
        refId: campaign.orgDocumentId,
        workspaceId: campaign.workspaceId,
        actorId: userId,
        actorName: await this.nameOf(userId),
        typeKey: 'hr.campaign_acknowledged',
        payload: { title: campaign.title, targetName: await this.nameOf(userId) },
      })
      .catch(() => undefined);

    // Личный архив: «документ достиг человека» — через порт документов → hr
    // нельзя (мы уже в документах); пишем запись напрямую той же механикой.
    await this.recordPersonal(campaign, userId).catch(() => undefined);

    await this.maybeCompleteOneOff(campaign);
  }

  /**
   * one_off: незакрытых заданий не осталось → кампания завершена, автору сводка.
   * ОДНА точка на оба пути закрытия последнего pending — «Ознакомлен» И
   * `sms_failed`: иначе кампания, чей последний адресат закрыт исходом
   * «SMS не доставлена», зависала бы в active навсегда.
   */
  private async maybeCompleteOneOff(campaign: {
    id: string;
    mode: string;
    title: string;
    workspaceId: string;
    createdById: string;
  }): Promise<void> {
    if (campaign.mode !== 'one_off') return;
    const pending = await this.db.docCampaignTarget.count({ where: { campaignId: campaign.id, status: 'pending' } });
    if (pending > 0) return;
    const done = await this.db.docCampaign.updateMany({
      where: { id: campaign.id, status: 'active' },
      data: { status: 'done', completedAt: new Date() },
    });
    if (done.count === 0) return;
    const total = await this.db.docCampaignTarget.count({ where: { campaignId: campaign.id } });
    const acknowledged = await this.db.docCampaignTarget.count({
      where: { campaignId: campaign.id, status: 'acknowledged' },
    });
    await this.notifications
      .notify(
        campaign.createdById,
        'hr.campaign.done',
        { title: campaign.title, acknowledged, total, workspaceId: campaign.workspaceId },
        { actionUrl: `/workspaces/${campaign.workspaceId}/documents?tab=campaigns`, dedupKey: `dcdone:${campaign.id}` },
      )
      .catch(() => undefined);
  }

  /** Личная запись-архив адресата (переживает увольнение и purge организации) */
  private async recordPersonal(
    campaign: { id: string; workspaceId: string; orgDocumentId: string; title: string; subjectFileId: string; signRequestId: string | null },
    userId: string,
  ): Promise<void> {
    const ws = await this.db.workspace.findUnique({ where: { id: campaign.workspaceId }, select: { name: true } });
    try {
      await this.db.$transaction(async (tx) => {
        const record = await tx.personalDocRecord.create({
          data: {
            userId,
            workspaceId: campaign.workspaceId,
            workspaceName: ws?.name ?? 'Организация',
            orgDocumentId: campaign.orgDocumentId,
            title: campaign.title,
            docTypeName: 'Ознакомление',
            fileId: campaign.subjectFileId,
            signRequestId: campaign.signRequestId,
            kind: 'acknowledged',
          },
        });
        await this.files.linkSystemInTx(tx, {
          fileId: campaign.subjectFileId,
          refType: 'personal_doc',
          refId: record.id,
          createdById: userId,
        });
      });
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') return; // уже записано
      throw err;
    }
  }

  /**
   * «Догнать аудиторию сейчас» (standing-кампании): приняли человека — не ждать
   * ночного крона. Та же материализация, что у крона, — ДЖОБОМ, не синхронно:
   * прогон на 5000 адресатов (акты + уведомления) держал бы HTTP-запрос минуты,
   * а двойной клик дал бы два параллельных прогона. Живой uniqueKey дедупит.
   */
  async sweepNow(actorId: string, workspaceId: string, campaignId: string): Promise<void> {
    await this.requireManager(actorId, workspaceId);
    const campaign = await this.db.docCampaign.findFirst({
      where: { id: campaignId, workspaceId },
      select: { id: true, status: true },
    });
    if (!campaign) throw new NotFoundException('Кампания не найдена');
    if (campaign.status !== 'active') throw new BadRequestException('Кампания уже завершена');
    await this.jobs.enqueue(null, {
      type: CAMPAIGN_RUN_JOB,
      payload: { campaignId: campaign.id },
      uniqueKey: `dcrun:${campaign.id}:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  /**
   * Человек вышел из организации: снять его НЕЗАКРЫТЫЕ задания и досчитать
   * закрытие разовых кампаний. Уже зафиксированное ознакомление (acknowledged,
   * sms_failed) остаётся — это вечный юридический след, его удалять нельзя.
   */
  async releaseUser(userId: string, workspaceId: string): Promise<void> {
    const pending = await this.db.docCampaignTarget.findMany({
      where: { userId, status: 'pending', campaign: { workspaceId, status: 'active' } },
      include: { campaign: true },
      take: 500,
    });
    if (!pending.length) return;
    await this.db.docCampaignTarget.deleteMany({ where: { id: { in: pending.map((t) => t.id) } } });
    // Кампания могла ждать РОВНО его — пересчитываем закрытие (одна точка,
    // общая с «Ознакомлен» и «SMS не доставлена»).
    const seen = new Set<string>();
    for (const t of pending) {
      if (seen.has(t.campaignId)) continue;
      seen.add(t.campaignId);
      await this.maybeCompleteOneOff(t.campaign).catch(() => undefined);
    }
  }

  /** SMS не доставлена — отдельный исход, а не «не ознакомился» (Менеджер+) */
  async markSmsFailed(actorId: string, workspaceId: string, campaignId: string, userId: string): Promise<void> {
    await this.requireManager(actorId, workspaceId);
    const campaign = await this.db.docCampaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!campaign) throw new NotFoundException('Кампания не найдена');
    // Исход существует только там, где SMS вообще была: в click-кампании отметка
    // «SMS не доставлена» была бы ложью в необратимом журнале.
    if (campaign.fixMode !== 'sms') {
      throw new BadRequestException('Исход «SMS не доставлена» есть только у SMS-кампаний');
    }
    const claimed = await this.db.docCampaignTarget.updateMany({
      where: { campaignId, userId, status: 'pending' },
      data: { status: 'sms_failed' },
    });
    // Последний pending закрыт этим исходом → one_off обязан завершиться
    if (claimed.count > 0) await this.maybeCompleteOneOff(campaign);
  }

  async cancel(actorId: string, workspaceId: string, campaignId: string): Promise<void> {
    await this.requireManager(actorId, workspaceId);
    const campaign = await this.db.docCampaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!campaign) throw new NotFoundException('Кампания не найдена');
    const claimed = await this.db.docCampaign.updateMany({
      where: { id: campaignId, status: 'active' },
      data: { status: 'cancelled', completedAt: new Date() },
    });
    if (claimed.count === 0) throw new BadRequestException('Кампания уже завершена');
    if (campaign.signRequestId) {
      await this.sign.cancelRequest(actorId, campaign.signRequestId).catch(() => undefined);
    }
  }

  // ============================================================
  // Чтение
  // ============================================================

  async list(viewerId: string, workspaceId: string): Promise<{ items: DocCampaignDto[] }> {
    await this.requireManager(viewerId, workspaceId);
    const rows = await this.db.docCampaign.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    // Счётчики всех кампаний — ОДНИМ groupBy: на экране их до сотни, и запрос
    // на каждую строку превращал открытие вкладки в сотню обращений к БД.
    const grouped = await this.db.docCampaignTarget.groupBy({
      by: ['campaignId', 'status'],
      where: { campaignId: { in: rows.map((r) => r.id) } },
      _count: true,
    });
    const countsById = new Map<string, Record<'pending' | 'acknowledged' | 'sms_failed', number>>();
    for (const g of grouped) {
      const acc = countsById.get(g.campaignId) ?? { pending: 0, acknowledged: 0, sms_failed: 0 };
      acc[g.status as keyof typeof acc] = g._count;
      countsById.set(g.campaignId, acc);
    }
    const items: DocCampaignDto[] = [];
    for (const row of rows) items.push(await this.serialize(row, countsById.get(row.id)));
    return { items };
  }

  /** Аналитика ДО конкретного человека: кто не ознакомился — поимённо */
  async detail(viewerId: string, workspaceId: string, campaignId: string): Promise<DocCampaignDetailDto> {
    await this.requireManager(viewerId, workspaceId);
    const row = await this.db.docCampaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!row) throw new NotFoundException('Кампания не найдена');
    const targets = await this.db.docCampaignTarget.findMany({
      where: { campaignId },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      take: HR_LIMITS.campaignMaxTargets,
    });
    const actors = await this.actorsOf(targets.map((t) => t.userId));
    return {
      ...(await this.serialize(row)),
      targets: targets.map((t) => ({
        id: t.id,
        userId: t.userId,
        status: t.status as 'pending' | 'acknowledged' | 'sms_failed',
        acknowledgedAt: t.acknowledgedAt?.toISOString() ?? null,
        remindedAt: t.remindedAt?.toISOString() ?? null,
        subjectSha256: t.subjectSha256 ?? null,
      })),
      actors,
    };
  }

  private async serialize(row: {
    id: string;
    workspaceId: string;
    title: string;
    orgDocumentId: string;
    mode: string;
    fixMode: string;
    status: string;
    dueAt: Date | null;
    createdById: string;
    createdAt: Date;
    completedAt: Date | null;
  }, precounted?: Record<'pending' | 'acknowledged' | 'sms_failed', number>): Promise<DocCampaignDto> {
    const counts = { pending: 0, acknowledged: 0, sms_failed: 0 } as Record<'pending' | 'acknowledged' | 'sms_failed', number>;
    if (precounted) {
      Object.assign(counts, precounted);
    } else {
      const groups = await this.db.docCampaignTarget.groupBy({
        by: ['status'],
        where: { campaignId: row.id },
        _count: true,
      });
      for (const g of groups) counts[g.status as keyof typeof counts] = g._count;
    }
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      title: row.title,
      orgDocumentId: row.orgDocumentId,
      mode: row.mode as DocCampaignDto['mode'],
      fixMode: row.fixMode as DocCampaignDto['fixMode'],
      status: row.status as DocCampaignDto['status'],
      dueAt: row.dueAt ? row.dueAt.toISOString().slice(0, 10) : null,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      counts,
      total: counts.pending + counts.acknowledged + counts.sms_failed,
    };
  }

  private async actorsOf(userIds: string[]): Promise<Record<string, HrActorLite>> {
    const ids = [...new Set(userIds)];
    if (!ids.length) return {};
    const rows = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    return rows.reduce(
      (acc, u) => ({ ...acc, [u.id]: { id: u.id, firstName: u.firstName, lastName: u.lastName, avatar: u.avatar } }),
      {} as Record<string, HrActorLite>,
    );
  }

  // ---------- Стопка ----------

  private async inboxList(
    userId: string,
    limit: number,
    scope: { workspaceId?: string | null; personalOnly?: boolean },
  ): Promise<InboxItemDto[]> {
    if (scope.personalOnly) return [];
    const targets = await this.db.docCampaignTarget.findMany({
      where: {
        userId,
        status: 'pending',
        campaign: { status: 'active', ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}) },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { campaign: true },
    });
    const today = new Date().toISOString().slice(0, 10);
    return targets.map((t): InboxItemDto => {
      const c = t.campaign;
      const sms = c.fixMode === 'sms';
      return {
        sourceKey: 'hr_campaign',
        id: c.id,
        title: c.title,
        subtitle: sms ? 'Ознакомьтесь и подтвердите кодом из SMS' : 'Ознакомьтесь с документом',
        icon: 'eye',
        href:
          sms && c.signRequestId
            ? signRequestHref(c.signRequestId, c.workspaceId)
            : `/workspaces/${c.workspaceId}/documents/${c.orgDocumentId}`,
        // click: «Ознакомлен» прямо из стопки; sms: только через экран подписи
        actions: sms ? [] : [{ key: 'acknowledge', label: 'Ознакомлен', tone: 'primary', commentRequired: false }],
        requestedById: c.createdById,
        createdAt: t.createdAt.toISOString(),
        dueAt: c.dueAt ? c.dueAt.toISOString() : null,
        overdue: !!c.dueAt && c.dueAt.toISOString().slice(0, 10) < today,
        stepKind: 'acknowledgement',
      };
    });
  }

  /** «Мои задания» кампаний (кнопка «Ознакомлен» на карточке документа) */
  async myTaskForDocument(userId: string, documentId: string): Promise<MyCampaignTaskDto | null> {
    const target = await this.db.docCampaignTarget.findFirst({
      where: { userId, status: 'pending', campaign: { status: 'active', orgDocumentId: documentId } },
      include: { campaign: { select: { id: true, fixMode: true, signRequestId: true } } },
    });
    if (!target) return null;
    return {
      campaignId: target.campaign.id,
      fixMode: target.campaign.fixMode as MyCampaignTaskDto['fixMode'],
      signRequestId: target.campaign.signRequestId,
    };
  }

  // ---------- Аудитория ----------

  private async resolveAudience(workspaceId: string, audience: { type: string; id: string }[]): Promise<string[]> {
    const out = new Set<string>();
    for (const principal of audience) {
      if (principal.type === 'user') {
        out.add(principal.id);
        continue;
      }
      if (principal.type === 'workspace') {
        const members = await this.db.userRole.findMany({
          where: { context: WS_CONTEXT, tenantId: workspaceId, isActive: true, role: { notIn: ['contractor'] } },
          select: { userId: true },
        });
        members.forEach((m) => out.add(m.userId));
        continue;
      }
      const rows = await this.db.relationTuple.findMany({
        where: {
          resourceType: principal.type,
          resourceId: principal.id,
          relation: principal.type === 'position' ? 'holder' : 'member',
          subjectType: 'user',
          subjectRelation: '',
        },
        select: { subjectId: true },
        take: HR_LIMITS.campaignMaxTargets,
      });
      rows.forEach((r) => out.add(r.subjectId));
    }
    const ids = [...out];
    if (!ids.length) return [];
    // Команда (trainee+), подрядчики исключены — негласное правило платформы явно
    const live = await this.db.userRole.findMany({
      where: {
        userId: { in: ids },
        context: WS_CONTEXT,
        tenantId: workspaceId,
        isActive: true,
        role: { notIn: ['contractor'] },
      },
      select: { userId: true },
    });
    const alive = new Set(live.map((r) => r.userId));
    return ids.filter((id) => alive.has(id));
  }
}
