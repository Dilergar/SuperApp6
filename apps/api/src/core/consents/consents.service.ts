import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CONSENT_BUNDLES,
  CONSENT_DOCUMENT_KEYS,
  CONSENT_ERROR_CODES,
  CONSENT_KINDS,
  PD_FIELD_CODES,
  PD_RECIPIENTS,
  PD_RECIPIENT_KEYS,
  consentKind,
  isLocale,
  type ConsentAcceptResultDto,
  type ConsentActorRole,
  type ConsentBundleKey,
  type ConsentChannel,
  type ConsentDocumentKey,
  type ConsentHistoryItemDto,
  type ConsentLocalizedText,
  type ConsentPendingDto,
  type ConsentPendingItemDto,
  type ConsentReceiptDto,
  type ConsentRevokeReason,
  type ConsentStateItemDto,
  type ConsentSubjectType,
  type Locale,
  type PdFieldCode,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors/api-error';
import { AnalyticsService } from '../analytics/analytics.service';
import { KeysEnvelopeService } from '../keys/keys.envelope.service';
import { KeysFieldRegistry } from '../keys/keys.registry';
import { NotificationRefRegistry } from '../notifications/notifications.registry';
import { NotificationsService } from '../notifications/notifications.service';
import { CONSENT_ACCEPTANCE_ENTITY, CONSENT_DOCUMENT_REF_TYPE } from './consents.constants';
import { ConsentsActionsService } from './consents.actions.service';
import { ConsentsDocumentsService } from './consents.documents.service';
import { ConsentsRevokeRegistry } from './consents.registry';
import { ConsentsGateService, type ConsentPendingLite } from './gate/consents-gate.service';

type Tx = Prisma.TransactionClient;

const PLATFORM = { type: 'platform' } as const;
const aad = (field: string) => ({ entity: CONSENT_ACCEPTANCE_ENTITY, field, ownerType: 'platform', ownerId: 'platform' });

export interface ConsentEvidence {
  ip?: string | null;
  userAgent?: string | null;
  /** SMS-цепочка, до отправки которой человек принял документы (регистрация) */
  verifyChallengeId?: string | null;
}

export interface ConsentAcceptInput {
  subject: { type: ConsentSubjectType; id: string };
  actorUserId: string;
  actorRole: ConsentActorRole;
  actorBasis?: string | null;
  /** id версий, которые человеку ПОКАЗАЛИ */
  versionIds: string[];
  locale: Locale;
  channel: ConsentChannel;
  bundleKey?: ConsentBundleKey | null;
  /** Пакет, чьи обязательные документы ОБЯЗАНЫ быть среди `versionIds` (иначе `consents.required`) */
  requireBundle?: ConsentBundleKey | null;
  evidence: ConsentEvidence;
  /** Момент приёмки (регистрация: момент старта SMS-цепочки, а не шага 3) */
  acceptedAt?: Date;
  /** Квитанция человеку (по умолчанию да) */
  notify?: boolean;
}

export interface ConsentAcceptOutcome extends ConsentAcceptResultDto {
  /** Сброс кэшей шлюза — ПОСЛЕ коммита транзакции вызывающего (сброс внутри гонится с чтением) */
  afterCommit: () => Promise<void>;
}

/**
 * core/consents — движок согласий (24-й). Контракт потребителя:
 *
 *   const out = await consents.accept(tx, {...});   // В ТРАНЗАКЦИИ действия (регистрация,
 *   …commit…; await out.afterCommit();              // создание организации, подключение интеграции)
 *
 * Приёмка вне транзакции невозможна по сигнатуре: `tx` обязателен. Запись приёмки, учёт
 * действия (срок согласия), зеркала (`analyticsOptOut`), эпоха человека — один коммит с
 * действием, ради которого согласие дано. Прав движок НЕ проверяет сверх «владелец ли актор
 * организации»: кто субъект и вправе ли актор принимать за него — знает вызывающий.
 */
@Injectable()
export class ConsentsService implements OnModuleInit {
  private readonly logger = new Logger(ConsentsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly gate: ConsentsGateService,
    private readonly documents: ConsentsDocumentsService,
    private readonly actions: ConsentsActionsService,
    private readonly envelope: KeysEnvelopeService,
    private readonly fields: KeysFieldRegistry,
    private readonly notifications: NotificationsService,
    private readonly analytics: AnalyticsService,
    private readonly revokeHooks: ConsentsRevokeRegistry,
    private readonly notificationRefs: NotificationRefRegistry,
  ) {}

  onModuleInit(): void {
    // Документ платформы публичен: видеть ссылку вправе любой адресат; deep link — витрина /legal
    this.notificationRefs.register(CONSENT_DOCUMENT_REF_TYPE, {
      canViewMany: async (userIds) => userIds,
      href: (ref) => `/legal/${ref.id}`,
    });
    // Перешивка envelope после ротации платформенного KEK (колонки — шифротекст, не открытый текст)
    for (const [column, field] of [['ip_enc', 'ip'], ['user_agent_enc', 'userAgent']] as const) {
      this.fields.register({ table: 'consent_acceptances', idColumn: 'id', column, scope: 'platform', entity: CONSENT_ACCEPTANCE_ENTITY, field });
    }
  }

  /**
   * Страж «приёмка только в транзакции вызывающего». Типы этого не ловят: корневой клиент базы
   * структурно совместим с транзакционным, и `accept(this.db, …)` компилируется. Отличие — в
   * рантайме: у транзакционного клиента нет `$transaction`. Приёмка вне транзакции = аккаунт
   * или организация могут появиться без записи согласия (и наоборот) — это ошибка разработчика,
   * поэтому обычный Error (500), а не отказ человеку.
   */
  private assertInTransaction(tx: Tx, method: string): void {
    if (typeof (tx as unknown as { $transaction?: unknown }).$transaction === 'function') {
      throw new Error(`ConsentsService.${method} must be called with the transaction client of the caller (tx), not the root database client`);
    }
  }

  // ------------------------------------------------------------
  // Приёмка
  // ------------------------------------------------------------

  async accept(tx: Tx, input: ConsentAcceptInput): Promise<ConsentAcceptOutcome> {
    this.assertInTransaction(tx, 'accept');
    const ids = [...new Set(input.versionIds)];
    if (!ids.length) throw badRequest(CONSENT_ERROR_CODES.required);
    if (!isLocale(input.locale)) throw badRequest(CONSENT_ERROR_CODES.versionMismatch);

    const published = await this.gate.publishedVersions();
    const now = new Date();
    const chosen = new Map<ConsentDocumentKey, (typeof published)[number]>();
    for (const id of ids) {
      const v = published.find((p) => p.id === id);
      if (!v) throw conflict(CONSENT_ERROR_CODES.versionMismatch);
      const kind = CONSENT_KINDS[v.documentKey];
      if (kind.subject !== input.subject.type) throw badRequest(CONSENT_ERROR_CODES.versionMismatch);
      // Принять можно действующую версию либо опубликованную на будущее («принять заранее»);
      // заменённую — нельзя: клиент показал человеку устаревший текст
      const current = this.gate.currentOf(published, v.documentKey, now);
      const isUpcoming = v.effectiveFrom > now;
      if (!isUpcoming && current?.id !== v.id) throw conflict(CONSENT_ERROR_CODES.versionMismatch);
      if (chosen.has(v.documentKey)) throw badRequest(CONSENT_ERROR_CODES.versionMismatch);
      chosen.set(v.documentKey, v);
    }

    if (input.requireBundle) {
      const def = CONSENT_BUNDLES[input.requireBundle];
      for (const key of def.documents) {
        // Обязательный документ пакета принимается ДЕЙСТВУЮЩЕЙ версией (а не только «заранее»)
        const v = chosen.get(key);
        if (!v || v.effectiveFrom > now) throw badRequest(CONSENT_ERROR_CODES.required);
      }
      const allowed = new Set<string>([...def.documents, ...def.optional]);
      for (const key of chosen.keys()) if (!allowed.has(key)) throw badRequest(CONSENT_ERROR_CODES.versionMismatch);
    }

    if (input.subject.type === 'workspace') {
      if (input.actorRole !== 'org_owner') throw forbidden(CONSENT_ERROR_CODES.workspacePending);
    } else if (input.actorRole === 'org_owner') {
      throw badRequest(CONSENT_ERROR_CODES.versionMismatch);
    }

    const ipEnc = input.evidence.ip ? await this.envelope.encrypt(PLATFORM, aad('ip'), input.evidence.ip.slice(0, 64)) : null;
    const userAgentEnc = input.evidence.userAgent ? await this.envelope.encrypt(PLATFORM, aad('userAgent'), input.evidence.userAgent.slice(0, 512)) : null;
    const acceptedAt = input.acceptedAt ?? now;

    const accepted: ConsentAcceptResultDto['accepted'] = [];
    for (const [key, lite] of chosen) {
      // Текст версии сверяется с подписью ПЕРЕД записью: приёмка подменённого текста — не доказательство
      const row = await this.documents.loadVerified(lite.id, tx);
      const contentHash = (row.hashes as unknown as ConsentLocalizedText)[input.locale];
      const live = await tx.consentAcceptance.findFirst({ where: { subjectType: input.subject.type, subjectId: input.subject.id, versionId: lite.id, revokedAt: null }, select: { id: true } });
      if (live) {
        accepted.push({ acceptanceId: live.id, documentKey: key, version: lite.version });
        continue;
      }
      // Одна живая приёмка на документ: прошлые версии закрываются причиной `superseded`
      await tx.consentAcceptance.updateMany({
        where: { subjectType: input.subject.type, subjectId: input.subject.id, documentKey: key, revokedAt: null },
        data: { revokedAt: acceptedAt, revokedReason: 'superseded' satisfies ConsentRevokeReason },
      });
      const created = await tx.consentAcceptance.create({
        data: {
          subjectType: input.subject.type,
          subjectId: input.subject.id,
          documentKey: key,
          versionId: lite.id,
          locale: input.locale,
          contentHash,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          actorBasis: input.actorBasis ?? null,
          acceptedAt,
          channel: input.channel,
          ipEnc,
          userAgentEnc,
          verifyChallengeId: input.evidence.verifyChallengeId ?? null,
          bundleKey: input.bundleKey ?? null,
        },
        select: { id: true },
      });
      accepted.push({ acceptanceId: created.id, documentKey: key, version: lite.version });
      await this.actions.record(tx, {
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        actionType: 'consent_term',
        basis: 'consent',
        fields: [],
        purpose: 'consent_accepted',
        consentAcceptanceId: created.id,
        workspaceId: input.subject.type === 'workspace' ? input.subject.id : null,
        refType: 'consent_version',
        refId: lite.id,
        // Момент ЗАПИСИ, а не приёмки: учёт — партиционированная таблица, и момент из прошлого
        // (старт SMS-цепочки на стыке месяцев) мог бы не найти своей партиции внутри транзакции
      });
      await this.analytics.track(
        tx,
        'consents.document.accepted',
        { document: key, ...(input.bundleKey ? { bundle: input.bundleKey } : {}), subject: input.subject.type, channel: input.channel, version: lite.version },
        { userId: input.actorUserId, workspaceId: input.subject.type === 'workspace' ? input.subject.id : null },
      );
      // Зеркало отказа от аналитики: правда — приёмка, `users.analytics_opt_out` её повторяет
      if (key === 'analytics' && input.subject.type === 'user') await this.analytics.applyOptOut(tx, input.subject.id, false);
    }

    if (input.subject.type === 'user') {
      // Порядок несущий: G читается ДО проверки «всё ли принято». Версия, вступившая в силу между
      // двумя чтениями, иначе попала бы в G, но не в проверку — и человек получил бы эпоху
      // «принято всё» без единой приёмки этой версии (быстрый путь шлюза пропускал бы его всегда).
      const g = await this.gate.globalEpoch();
      const { blocking } = await this.gate.pendingOf('user', input.subject.id, tx);
      if (!blocking.length) await tx.user.updateMany({ where: { id: input.subject.id, consentEpoch: { lt: g } }, data: { consentEpoch: g } });
    }

    if (input.notify !== false && accepted.length) {
      await this.notifications.send(tx, {
        type: 'consents.accepted',
        to: [{ userId: input.actorUserId }],
        payload: { count: accepted.length, subject: input.subject.type },
        actorId: input.actorUserId,
        includeActor: true,
        workspaceId: input.subject.type === 'workspace' ? input.subject.id : null,
        actionUrl: '/profile/my-data',
        reason: 'system',
      });
    }

    const analyticsAccepted = chosen.has('analytics') && input.subject.type === 'user';
    return {
      accepted,
      afterCommit: async () => {
        if (input.subject.type === 'user') await this.gate.forgetUser(input.subject.id);
        else await this.gate.forgetWorkspace(input.subject.id);
        if (analyticsAccepted) await this.analytics.publishOptOut(input.subject.id, false);
      },
    };
  }

  /**
   * Версии, действующие сейчас, для пакета — то, что сервер принимает «за» актора там, где
   * согласие не требуется средой (development/test: сьюты и сиды живут без правок; образец —
   * `VERIFY_REQUIRED` движка подтверждений). В production этим путём не ходят.
   */
  async currentBundleVersionIds(bundleKey: ConsentBundleKey): Promise<string[]> {
    const bundle = await this.documents.bundle(bundleKey);
    return bundle.documents.map((d) => d.versionId);
  }

  // ------------------------------------------------------------
  // Отзыв
  // ------------------------------------------------------------

  /**
   * Отзыв согласия. `system: true` — служебные причины (удаление аккаунта, purge организации):
   * отзывается и неотзывное. Вид opt-out без живой приёмки записывает ОТКАЗ строкой
   * «принято и сразу отозвано» — отказ тоже требует доказательства.
   */
  async revoke(
    tx: Tx,
    input: { subject: { type: ConsentSubjectType; id: string }; documentKey: ConsentDocumentKey; actorUserId: string; reason: ConsentRevokeReason; system?: boolean; locale?: Locale; channel?: ConsentChannel; evidence?: ConsentEvidence },
  ): Promise<{ revoked: number; afterCommit: () => Promise<void> }> {
    this.assertInTransaction(tx, 'revoke');
    const kind = CONSENT_KINDS[input.documentKey];
    if (!kind || kind.subject !== input.subject.type) throw badRequest(CONSENT_ERROR_CODES.notFound);
    if (!input.system && !kind.revocable) throw badRequest(CONSENT_ERROR_CODES.notRevocable);
    const now = new Date();
    const live = await tx.consentAcceptance.findMany({ where: { subjectType: input.subject.type, subjectId: input.subject.id, documentKey: input.documentKey, revokedAt: null }, select: { id: true, versionId: true } });
    let revoked = 0;
    if (live.length) {
      const res = await tx.consentAcceptance.updateMany({ where: { id: { in: live.map((l) => l.id) }, revokedAt: null }, data: { revokedAt: now, revokedReason: input.reason } });
      revoked = res.count;
    } else if (kind.mode === 'opt_out' && !input.system) {
      const current = this.gate.currentOf(await this.gate.publishedVersions(), input.documentKey, now);
      if (current) {
        const row = await this.documents.loadVerified(current.id, tx);
        const locale = input.locale ?? 'en';
        const ev = input.evidence ?? {};
        await tx.consentAcceptance.create({
          data: {
            subjectType: input.subject.type,
            subjectId: input.subject.id,
            documentKey: input.documentKey,
            versionId: current.id,
            locale,
            contentHash: (row.hashes as unknown as ConsentLocalizedText)[locale],
            actorUserId: input.actorUserId,
            actorRole: 'self',
            acceptedAt: now,
            channel: input.channel ?? 'web',
            ipEnc: ev.ip ? await this.envelope.encrypt(PLATFORM, aad('ip'), ev.ip.slice(0, 64)) : null,
            userAgentEnc: ev.userAgent ? await this.envelope.encrypt(PLATFORM, aad('userAgent'), ev.userAgent.slice(0, 512)) : null,
            revokedAt: now,
            revokedReason: 'declined' satisfies ConsentRevokeReason,
          },
        });
        revoked = 1;
      }
    }
    if (revoked > 0) {
      await this.actions.record(tx, {
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        actionType: 'consent_term',
        basis: 'consent',
        fields: [],
        purpose: input.reason === 'account_deleted' ? 'account_deletion_requested' : 'consent_revoked',
        consentAcceptanceId: live[0]?.id ?? null,
        workspaceId: input.subject.type === 'workspace' ? input.subject.id : null,
        refType: 'consent_document',
        refId: input.documentKey,
        occurredAt: now,
      });
      await this.analytics.track(tx, 'consents.document.revoked', { document: input.documentKey, reason: input.reason }, { userId: input.actorUserId, workspaceId: input.subject.type === 'workspace' ? input.subject.id : null });
    }
    // Отозван блокирующий документ → эпоха человека сбрасывается: быстрый путь шлюза (сравнение
    // эпох) иначе пропускал бы вернувшегося из грейса человека без единого живого согласия
    if (revoked > 0 && kind.gate === 'block' && input.subject.type === 'user') {
      await tx.user.updateMany({ where: { id: input.subject.id }, data: { consentEpoch: 0 } });
    }
    const analyticsOff = input.documentKey === 'analytics' && input.subject.type === 'user' && !input.system;
    if (analyticsOff) await this.analytics.applyOptOut(tx, input.subject.id, true);
    // Владелец данных, зависящих от согласия, гасит их в той же транзакции (Google Calendar — отключение)
    const hookEffects = !input.system || input.reason === 'account_deleted' ? await this.revokeHooks.run(tx, input.documentKey, input.subject, input.reason) : [];
    return {
      revoked,
      afterCommit: async () => {
        if (input.subject.type === 'user') await this.gate.forgetUser(input.subject.id);
        else await this.gate.forgetWorkspace(input.subject.id);
        if (analyticsOff) await this.analytics.publishOptOut(input.subject.id, true);
        // Внешние эффекты хуков (отзыв токена у Google) — best-effort: отзыв в базе уже состоялся
        for (const fn of hookEffects) await fn().catch((err) => this.logger.warn(`consent revoke hook effect (${input.documentKey}): ${(err as Error).message}`));
      },
    };
  }

  /**
   * Прекращение субъекта = отзыв ВСЕХ его живых согласий одной транзакцией: удаление аккаунта
   * (`account_deleted`) и окончательное удаление организации (`workspace_purged`). Служебный
   * путь: отзывается и неотзывное. Записи приёмки остаются — это доказательство.
   */
  async revokeAllForSubject(tx: Tx, subject: { type: ConsentSubjectType; id: string }, reason: Extract<ConsentRevokeReason, 'account_deleted' | 'workspace_purged'>, actorUserId: string | null): Promise<{ afterCommit: () => Promise<void> }> {
    this.assertInTransaction(tx, 'revokeAllForSubject');
    const live = await tx.consentAcceptance.findMany({ where: { subjectType: subject.type, subjectId: subject.id, revokedAt: null }, select: { documentKey: true, actorUserId: true }, distinct: ['documentKey'] });
    const after: Array<() => Promise<void>> = [];
    for (const row of live) {
      if (!Object.prototype.hasOwnProperty.call(CONSENT_KINDS, row.documentKey)) continue;
      const out = await this.revoke(tx, { subject, documentKey: row.documentKey as ConsentDocumentKey, actorUserId: actorUserId ?? row.actorUserId, reason, system: true });
      after.push(out.afterCommit);
    }
    // Кэши шлюза и внешние эффекты хуков — ПОСЛЕ коммита вызывающего
    return { afterCommit: async () => { for (const fn of after) await fn().catch(() => undefined); } };
  }

  /** Живая приёмка документа у субъекта (основание передачи: интеграция, рассылка). */
  async hasLive(subject: { type: ConsentSubjectType; id: string }, documentKey: ConsentDocumentKey, client: Pick<DatabaseService, 'consentAcceptance'> = this.db): Promise<string | null> {
    const row = await client.consentAcceptance.findFirst({ where: { subjectType: subject.type, subjectId: subject.id, documentKey, revokedAt: null }, select: { id: true }, orderBy: { acceptedAt: 'desc' } });
    return row?.id ?? null;
  }

  // ------------------------------------------------------------
  // Чтения человека
  // ------------------------------------------------------------

  private toPendingItem(p: ConsentPendingLite): ConsentPendingItemDto {
    return { ...this.documents.toRef(p.version), acceptedVersion: p.acceptedVersion };
  }

  /** Что ждёт принятия: блокирующее, будущее и организации, где человек владелец или администратор. */
  async pendingFor(userId: string): Promise<ConsentPendingDto> {
    const mine = await this.gate.pendingOf('user', userId);
    const roles = await this.db.userRole.findMany({
      where: { userId, context: 'workspace', isActive: true, role: { in: ['owner', 'admin'] }, tenantId: { not: null } },
      select: { tenantId: true, role: true },
      take: 50,
    });
    const workspaces: ConsentPendingDto['workspaces'] = [];
    if (roles.length) {
      const ids = [...new Set(roles.map((r) => r.tenantId!))];
      const rows = await this.db.workspace.findMany({ where: { id: { in: ids }, archivedAt: null }, select: { id: true, name: true, ownerId: true } });
      for (const ws of rows) {
        const p = await this.gate.pendingOf('workspace', ws.id);
        if (!p.blocking.length && !p.upcoming.length) continue;
        workspaces.push({ workspaceId: ws.id, workspaceName: ws.name, canAccept: ws.ownerId === userId, blocking: p.blocking.map((x) => this.toPendingItem(x)), upcoming: p.upcoming.map((x) => this.toPendingItem(x)) });
      }
    }
    return { blocking: mine.blocking.map((x) => this.toPendingItem(x)), upcoming: mine.upcoming.map((x) => this.toPendingItem(x)), workspaces };
  }

  /** Раздел «Мои данные»: состояние каждого вида согласия человека. */
  async stateFor(userId: string): Promise<ConsentStateItemDto[]> {
    const published = await this.gate.publishedVersions();
    const rows = await this.db.consentAcceptance.findMany({
      where: { subjectType: 'user', subjectId: userId },
      select: { id: true, documentKey: true, acceptedAt: true, revokedAt: true, revokedReason: true, version: { select: { version: true } } },
      orderBy: { acceptedAt: 'desc' },
    });
    const out: ConsentStateItemDto[] = [];
    for (const key of CONSENT_DOCUMENT_KEYS) {
      const kind = consentKind(key);
      if (kind.subject !== 'user' || !kind.hasDocument) continue;
      const current = this.gate.currentOf(published, key);
      const floor = this.gate.floorOf(published, key);
      const mine = rows.filter((r) => r.documentKey === key);
      const live = mine.find((r) => !r.revokedAt) ?? null;
      const last = mine[0] ?? null;
      let status: ConsentStateItemDto['status'];
      if (live) status = floor !== null && live.version.version < floor ? 'outdated' : 'accepted';
      else if (last && last.revokedReason !== 'superseded') status = 'declined';
      else status = kind.mode === 'opt_out' ? 'default_on' : 'none';
      // Вид «по запросу» без истории человеку не показываем: согласия на интеграцию, которой он не пользовался, нет
      if (kind.onDemand && !mine.length) continue;
      out.push({
        documentKey: key,
        mode: kind.mode,
        required: kind.required,
        revocable: kind.revocable,
        status,
        acceptanceId: live?.id ?? null,
        acceptedVersion: live?.version.version ?? null,
        acceptedAt: live?.acceptedAt.toISOString() ?? null,
        currentVersion: current?.version ?? null,
        currentVersionId: current?.id ?? null,
      });
    }
    return out;
  }

  async historyFor(userId: string): Promise<ConsentHistoryItemDto[]> {
    const rows = await this.db.consentAcceptance.findMany({
      where: { OR: [{ subjectType: 'user', subjectId: userId }, { actorUserId: userId }] },
      select: { id: true, documentKey: true, locale: true, actorRole: true, channel: true, bundleKey: true, acceptedAt: true, revokedAt: true, revokedReason: true, version: { select: { version: true } } },
      orderBy: { acceptedAt: 'desc' },
      take: 200,
    });
    return rows
      .filter((r) => Object.prototype.hasOwnProperty.call(CONSENT_KINDS, r.documentKey))
      .map((r) => ({
        id: r.id,
        documentKey: r.documentKey as ConsentDocumentKey,
        version: r.version.version,
        locale: (isLocale(r.locale) ? r.locale : 'en') as Locale,
        actorRole: r.actorRole as ConsentActorRole,
        channel: r.channel as ConsentChannel,
        bundleKey: (r.bundleKey as ConsentBundleKey | null) ?? null,
        acceptedAt: r.acceptedAt.toISOString(),
        revokedAt: r.revokedAt?.toISOString() ?? null,
        revokedReason: (r.revokedReason as ConsentRevokeReason | null) ?? null,
      }));
  }

  /**
   * Персональный «Лист согласия» — 8 реквизитов ЗоПД ст. 8 п. 4. Видит тот, чьё согласие,
   * и тот, кто его дал (владелец организации, представитель); остальным — 404.
   */
  async receipt(userId: string, acceptanceId: string): Promise<ConsentReceiptDto> {
    const a = await this.db.consentAcceptance.findUnique({ where: { id: acceptanceId }, include: { version: true } });
    if (!a || !Object.prototype.hasOwnProperty.call(CONSENT_KINDS, a.documentKey)) throw notFound(CONSENT_ERROR_CODES.notFound);
    const isSubject = a.subjectType === 'user' && a.subjectId === userId;
    if (!isSubject && a.actorUserId !== userId) throw notFound(CONSENT_ERROR_CODES.notFound);
    const locale = (isLocale(a.locale) ? a.locale : 'en') as Locale;
    const key = a.documentKey as ConsentDocumentKey;
    const signatureValid = await this.documents.verifyVersion(a.version);

    const fullName = (u: { firstName: string | null; lastName: string | null; middleName: string | null } | null) => (u ? [u.lastName, u.firstName, u.middleName].filter(Boolean).join(' ') : '');
    const actor = await this.db.user.findUnique({ where: { id: a.actorUserId }, select: { firstName: true, lastName: true, middleName: true } });
    let subjectName = fullName(actor);
    let actorName: string | null = null;
    if (a.subjectType === 'workspace') {
      const ws = await this.db.workspace.findUnique({ where: { id: a.subjectId }, select: { name: true } });
      actorName = subjectName;
      subjectName = ws?.name ?? '';
    } else if (a.subjectId !== a.actorUserId) {
      const subj = await this.db.user.findUnique({ where: { id: a.subjectId }, select: { firstName: true, lastName: true, middleName: true } });
      actorName = subjectName;
      subjectName = fullName(subj);
    }

    // Получатели, чьё основание — этот документ (у `privacy` — ещё и базовые внутри РК)
    const recipients = PD_RECIPIENT_KEYS.filter((k) => PD_RECIPIENTS[k].active && PD_RECIPIENTS[k].consentDocument === key);
    const dataFields: PdFieldCode[] = key === 'privacy' ? [...PD_FIELD_CODES] : [...new Set(recipients.flatMap((k) => [...PD_RECIPIENTS[k].fields]))];
    return {
      acceptanceId: a.id,
      documentKey: key,
      version: a.version.version,
      locale,
      contentHash: a.contentHash,
      manifestHash: a.version.manifestHash ?? '',
      signatureKid: a.version.signatureKid ?? '',
      signatureValid,
      acceptedAt: a.acceptedAt.toISOString(),
      revokedAt: a.revokedAt?.toISOString() ?? null,
      channel: a.channel as ConsentChannel,
      actorRole: a.actorRole as ConsentActorRole,
      operator: (({ legalName, bin, address, privacyEmail }) => ({ legalName, bin, address, privacyEmail }))(this.documents.operatorValues(locale)),
      subject: { fullName: subjectName, actorFullName: actorName },
      term: { until: CONSENT_KINDS[key].revocable ? 'revocation' : 'account_deletion' },
      thirdParties: recipients.filter((k) => !PD_RECIPIENTS[k].crossBorder).map((k) => ({ key: k, name: PD_RECIPIENTS[k].name, fields: [...PD_RECIPIENTS[k].fields] })),
      crossBorder: recipients.filter((k) => PD_RECIPIENTS[k].crossBorder).map((k) => ({ key: k, name: PD_RECIPIENTS[k].name, country: PD_RECIPIENTS[k].country, fields: [...PD_RECIPIENTS[k].fields] })),
      publication: key === 'privacy',
      dataFields,
    };
  }

  /** Сводка для карточки 360 кабинета: состояние согласий человека без текста. */
  async summaryForUser(userId: string): Promise<{ consentEpoch: number; globalEpoch: number; blocked: boolean; state: ConsentStateItemDto[] }> {
    const [user, globalEpoch, state, pending] = await Promise.all([
      this.db.user.findUnique({ where: { id: userId }, select: { consentEpoch: true } }),
      this.gate.globalEpoch(),
      this.stateFor(userId),
      this.gate.pendingOf('user', userId),
    ]);
    return { consentEpoch: user?.consentEpoch ?? 0, globalEpoch, blocked: pending.blocking.length > 0, state };
  }
}
