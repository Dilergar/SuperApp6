import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AUDIT_ACTOR_KIND_CODE,
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_CODE,
  AUDIT_LIMITS,
  AUDIT_OUTCOME_CODE,
  AUDIT_WINDOW_EXEMPT_KEYS,
  auditEventDef,
  type AuditActorDto,
  type AuditActorKind,
  type AuditCategory,
  type AuditDeviceClass,
  type AuditOutcome,
  type AuditPersonDto,
  type SecurityEventDto,
  type SecurityEventIpDto,
  type SecurityEventPageDto,
} from '@superapp/shared';
import type { Locale } from '@superapp/i18n';
import { DatabaseService } from '../../shared/database/database.service';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';
import { deviceFromFamily } from '../../shared/utils/user-agent';
import { KeysEnvelopeService } from '../keys/keys.envelope.service';
import { AUDIT_EVENT_ENTITY } from './audit.constants';
import { AuditMetrics } from './audit.metrics';
import { AuditRenderer } from './audit.render';
import { AUDIT_PLATFORM_ONLY_DETAILS, auditActorKindOf, auditCategoryOf, auditClientOf, auditOutcomeOf, auditSeverityOf } from './audit.codes';

/**
 * Зритель журнала — проекция одного и того же события:
 * - subject — сам человек: `vis_subject` и своя лента, окно 365 дней (кроме `pd`/`consents`);
 * - workspace — админ организации: `vis_workspace` своей организации, окно по тарифу;
 * - platform — безопасность платформы: всё (чтения учитывает вызывающий — `audit.viewed`).
 */
export type AuditViewer =
  | { kind: 'subject'; userId: string }
  | { kind: 'workspace'; workspaceId: string; retentionDays: number }
  | { kind: 'platform'; actorId: string };

export interface AuditQueryFilter {
  /** Ключи событий (чип фильтра) — `null`/нет — все */
  keys?: readonly string[] | null;
  categories?: readonly AuditCategory[];
  actorId?: string;
  actorKind?: AuditActorKind;
  subjectUserId?: string;
  workspaceId?: string;
  requestId?: string;
  ipHmacs?: readonly string[];
  op?: string;
  outcome?: AuditOutcome;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
}

export const AUDIT_ROW_SELECT = {
  id: true,
  eventId: true,
  occurredAt: true,
  eventKey: true,
  op: true,
  category: true,
  severity: true,
  outcome: true,
  reasonCode: true,
  actorKind: true,
  actorId: true,
  actorSessionId: true,
  onBehalfOfId: true,
  actorRoles: true,
  subjectUserId: true,
  workspaceId: true,
  targetType: true,
  targetId: true,
  targetLabel: true,
  ipNet: true,
  country: true,
  city: true,
  uaFamily: true,
  deviceId: true,
  client: true,
  requestId: true,
  details: true,
  refType: true,
  refId: true,
} satisfies Prisma.SecurityEventSelect;

const ROW_SELECT = AUDIT_ROW_SELECT;

export type AuditRow = Prisma.SecurityEventGetPayload<{ select: typeof ROW_SELECT }>;

const PLATFORM_ONLY_DETAILS = AUDIT_PLATFORM_ONLY_DETAILS;
const USER_LITE = { id: true, firstName: true, lastName: true, avatar: true } as const;

/** Курсор keyset (occurred_at DESC, id DESC) — непрозрачная строка base64url. */
export function encodeAuditCursor(at: Date, id: bigint | string): string {
  return Buffer.from(`${at.toISOString()}|${id.toString()}`).toString('base64url');
}

export function decodeAuditCursor(raw: string | undefined): { at: Date; id: bigint } | null {
  if (!raw) return null;
  try {
    const [at, id] = Buffer.from(raw, 'base64url').toString().split('|');
    const d = new Date(at ?? '');
    if (Number.isNaN(d.getTime()) || !id || !/^\d{1,19}$/.test(id)) return null;
    return { at: d, id: BigInt(id) };
  } catch {
    return null;
  }
}

/**
 * Чтение журнала безопасности. Права решает вызывающий (контроллер: «я сам», owner/admin
 * организации, сотрудник с `security.read`); здесь — проекция зрителя, которую обойти
 * фильтром нельзя: видимость и окно — всегда в WHERE, фильтры только сужают.
 */
@Injectable()
export class AuditQueryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ws: WorkspaceContextService,
    private readonly renderer: AuditRenderer,
    private readonly envelope: KeysEnvelopeService,
    private readonly metrics: AuditMetrics,
  ) {}

  /** WHERE проекции зрителя — единственное место, где решается «кому видно». */
  projection(viewer: AuditViewer, now = new Date()): Prisma.SecurityEventWhereInput {
    switch (viewer.kind) {
      case 'subject':
        return {
          visSubject: true,
          subjectUserId: viewer.userId,
          OR: [{ occurredAt: { gte: new Date(now.getTime() - AUDIT_LIMITS.personWindowDays * 86_400_000) } }, { eventKey: { in: [...AUDIT_WINDOW_EXEMPT_KEYS] } }],
        };
      case 'workspace':
        return { visWorkspace: true, workspaceId: viewer.workspaceId, occurredAt: { gte: new Date(now.getTime() - viewer.retentionDays * 86_400_000) } };
      case 'platform':
        return {};
    }
  }

  private filterWhere(f: AuditQueryFilter): Prisma.SecurityEventWhereInput[] {
    const and: Prisma.SecurityEventWhereInput[] = [];
    if (f.keys && f.keys.length) and.push({ eventKey: { in: [...f.keys] } });
    if (f.categories?.length) and.push({ category: { in: f.categories.map((c) => AUDIT_CATEGORY_CODE[c]) } });
    if (f.actorId) and.push({ actorId: f.actorId });
    if (f.actorKind) and.push({ actorKind: AUDIT_ACTOR_KIND_CODE[f.actorKind] });
    if (f.subjectUserId) and.push({ subjectUserId: f.subjectUserId });
    if (f.workspaceId) and.push({ workspaceId: f.workspaceId });
    if (f.requestId) and.push({ requestId: f.requestId });
    if (f.ipHmacs?.length) and.push({ ipHmac: { in: [...f.ipHmacs] } });
    if (f.op) and.push({ op: f.op });
    if (f.outcome) and.push({ outcome: AUDIT_OUTCOME_CODE[f.outcome] });
    if (f.targetType) and.push({ targetType: f.targetType });
    if (f.targetId) and.push({ targetId: f.targetId });
    if (f.from) and.push({ occurredAt: { gte: f.from } });
    if (f.to) and.push({ occurredAt: { lte: f.to } });
    return and;
  }

  async query(viewer: AuditViewer, f: AuditQueryFilter): Promise<SecurityEventPageDto> {
    const started = process.hrtime.bigint();
    const { rows, nextCursor } = await this.rows(viewer, f);
    const items = await this.toDtos(viewer, rows);
    this.metrics.queryLatency.observe({ viewer: viewer.kind }, Number(process.hrtime.bigint() - started) / 1e9);
    return {
      items,
      nextCursor,
      windowDays: viewer.kind === 'subject' ? AUDIT_LIMITS.personWindowDays : viewer.kind === 'workspace' ? viewer.retentionDays : null,
    };
  }

  /** Страница сырых строк в проекции зрителя — для проекций прежних журналов (ключи, Кабинет, «Мои данные»). */
  async rows(viewer: AuditViewer, f: AuditQueryFilter): Promise<{ rows: AuditRow[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(f.limit ?? AUDIT_LIMITS.feedPageSize, 1), 200);
    const cursor = decodeAuditCursor(f.cursor);
    const and = [this.projection(viewer), ...this.filterWhere(f)];
    if (cursor) and.push({ OR: [{ occurredAt: { lt: cursor.at } }, { occurredAt: cursor.at, id: { lt: cursor.id } }] });
    const rows = await this.db.securityEvent.findMany({
      where: { AND: and },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: ROW_SELECT,
    });
    const page = rows.slice(0, limit);
    const last = rows.length > limit ? page[page.length - 1] : null;
    return { rows: page, nextCursor: last ? encodeAuditCursor(last.occurredAt, last.id) : null };
  }


  /** Одно событие в проекции зрителя (модалка, deep link `?e=<id>`); чужое/вне окна — null. */
  async getOne(viewer: AuditViewer, id: string): Promise<SecurityEventDto | null> {
    if (!/^\d{1,19}$/.test(id)) return null;
    const row = await this.db.securityEvent.findFirst({ where: { AND: [this.projection(viewer), { id: BigInt(id) }] }, select: ROW_SELECT });
    if (!row) return null;
    const [dto] = await this.toDtos(viewer, [row]);
    return dto ?? null;
  }

  /** Сырая строка по id в проекции зрителя (для «Это не я»: ключ, исход, семейство). */
  async rawOne(viewer: AuditViewer, id: string) {
    if (!/^\d{1,19}$/.test(id)) return null;
    return this.db.securityEvent.findFirst({
      where: { AND: [this.projection(viewer), { id: BigInt(id) }] },
      select: { ...ROW_SELECT, actorFamilyId: true, ipHmac: true },
    });
  }

  /**
   * Полный IP события — только платформе и только отдельным запросом (вызывающий пишет
   * `platform.access.reveal` с перечнем полей). Расшифровка — платформенным KEK.
   */
  async ipOf(id: string): Promise<SecurityEventIpDto | null> {
    if (!/^\d{1,19}$/.test(id)) return null;
    const row = await this.db.securityEvent.findFirst({ where: { id: BigInt(id) }, select: { ipEnc: true, ipNet: true, ipHmac: true } });
    if (!row) return null;
    let ip: string | null = null;
    if (row.ipEnc) {
      const r = await this.envelope.tryDecrypt({ type: 'platform' }, { entity: AUDIT_EVENT_ENTITY, field: 'ip', ownerType: 'platform', ownerId: 'platform' }, row.ipEnc);
      ip = r.ok ? r.value : null;
    }
    return { ip, ipNet: row.ipNet, ipHmac: row.ipHmac };
  }

  // ============================================================
  // Проекция строк в DTO
  // ============================================================

  async toDtos(viewer: AuditViewer, rows: AuditRow[], locale: Locale = this.ws.locale): Promise<SecurityEventDto[]> {
    if (!rows.length) return [];
    const personIds = new Set<string>();
    for (const r of rows) {
      const kind = auditActorKindOf(r.actorKind);
      if (r.actorId && (kind === 'user' || kind === 'bot' || (kind === 'platform_staff' && viewer.kind === 'platform'))) personIds.add(r.actorId);
      if (r.subjectUserId && viewer.kind !== 'subject') personIds.add(r.subjectUserId);
      if (r.targetType === 'user' && r.targetId) personIds.add(r.targetId);
    }
    const wsIds = [...new Set(rows.map((r) => r.workspaceId).filter((v): v is string => !!v))];
    // Пары (человек, устройство) — без повторов: «Мои данные» — до 10 000 строк одного человека
    const deviceKeys = [...new Map(rows.filter((r) => r.deviceId && r.subjectUserId).map((r) => [`${r.subjectUserId}|${r.deviceId}`, { userId: r.subjectUserId!, deviceId: r.deviceId! }])).values()];
    const [people, workspaces, devices] = await Promise.all([
      personIds.size ? this.db.user.findMany({ where: { id: { in: [...personIds] } }, select: USER_LITE }) : Promise.resolve([]),
      wsIds.length ? this.db.workspace.findMany({ where: { id: { in: wsIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
      deviceKeys.length
        ? this.db.userDevice.findMany({
            where: { OR: deviceKeys.map((k) => ({ userId: k.userId, deviceId: k.deviceId })) },
            select: { userId: true, deviceId: true, label: true, customLabel: true, deviceClass: true },
          })
        : Promise.resolve([]),
    ]);
    const personById = new Map<string, AuditPersonDto>(people.map((p) => [p.id, { id: p.id, firstName: p.firstName, lastName: p.lastName, avatar: p.avatar }]));
    const wsName = new Map(workspaces.map((w) => [w.id, w.name]));
    const deviceOf = new Map(devices.map((d) => [`${d.userId}|${d.deviceId}`, d]));

    return rows.map((r) => {
      const key = r.eventKey;
      const def = auditEventDef(key);
      const actorKind = auditActorKindOf(r.actorKind);
      const outcome = auditOutcomeOf(r.outcome);
      const known = r.deviceId && r.subjectUserId ? deviceOf.get(`${r.subjectUserId}|${r.deviceId}`) : undefined;
      const fromFamily = deviceFromFamily(r.uaFamily);
      // Имя, которое человек дал устройству («Ноутбук Айгерим»), — его личное: организация
      // видит только автоподпись «Chrome · Windows»
      const deviceLabel = known ? ((viewer.kind !== 'workspace' ? known.customLabel : null) ?? known.label) : fromFamily.label;
      const deviceClass = (known?.deviceClass ?? fromFamily.deviceClass) as AuditDeviceClass | null;
      // Где и чем — данные АКТОРА. В ленте человека событие, совершённое над ним другим (админ сменил
      // роль, сотрудник платформы заморозил аккаунт), не раскрывает страну и устройство того, другого
      const foreignActor = viewer.kind === 'subject' && !!r.actorId && r.actorId !== r.subjectUserId && actorKind !== 'anonymous';
      const rawDetails = r.details && typeof r.details === 'object' && !Array.isArray(r.details) ? (r.details as Record<string, unknown>) : {};
      const details = viewer.kind === 'platform' ? rawDetails : Object.fromEntries(Object.entries(rawDetails).filter(([k]) => !PLATFORM_ONLY_DETAILS.has(k)));
      const text = this.renderer.render(locale, {
        eventKey: key,
        details: rawDetails,
        op: r.op,
        targetLabel: r.targetLabel,
        country: foreignActor ? null : r.country,
        workspaceName: r.workspaceId ? (wsName.get(r.workspaceId) ?? null) : null,
        deviceLabel: foreignActor ? null : deviceLabel,
      });
      return {
        id: r.id.toString(),
        eventId: r.eventId,
        occurredAt: r.occurredAt.toISOString(),
        key,
        category: auditCategoryOf(r.category) ?? (AUDIT_CATEGORIES[0] as AuditCategory),
        severity: auditSeverityOf(r.severity),
        outcome,
        reasonCode: r.reasonCode,
        op: viewer.kind === 'subject' && def?.category !== 'keys' ? null : r.op,
        title: text.title,
        body: text.body,
        actor: this.actorDto(viewer, actorKind, r.actorId, personById),
        subject: viewer.kind !== 'subject' && r.subjectUserId ? (personById.get(r.subjectUserId) ?? null) : null,
        workspaceId: r.workspaceId,
        target: r.targetType && r.targetId ? { type: r.targetType, id: r.targetId, label: r.targetLabel, ...(r.targetType === 'user' ? { person: personById.get(r.targetId) ?? null } : {}) } : null,
        client: auditClientOf(r.client),
        location: foreignActor ? { country: null, city: null } : { country: r.country, city: r.city, ...(viewer.kind === 'platform' ? { ipNet: r.ipNet } : {}) },
        device: foreignActor ? { label: null, class: null } : { label: deviceLabel, class: deviceClass },
        details,
        disputable: viewer.kind === 'subject' && !!def?.disputable && outcome === 'success',
        requestId: r.requestId,
        ref: r.refType && r.refId ? { type: r.refType, id: r.refId } : null,
      } satisfies SecurityEventDto;
    });
  }

  /** Актор в проекции: личность сотрудника платформы вне Кабинета не раскрывается никогда. */
  private actorDto(viewer: AuditViewer, kind: AuditActorKind, id: string | null, people: Map<string, AuditPersonDto>): AuditActorDto {
    switch (kind) {
      case 'user':
        return id ? { kind: 'user', id, person: people.get(id) ?? null } : { kind: 'anonymous' };
      case 'bot':
        // Имя бота — имя его теневого аккаунта (users.kind = bot)
        return id ? { kind: 'bot', id, name: people.get(id)?.firstName ?? null } : { kind: 'system' };
      case 'platform_staff':
        return viewer.kind === 'platform' && id ? { kind: 'platform_staff', id, person: people.get(id) ?? null } : { kind: 'platform' };
      case 'device':
        return { kind: 'device', id };
      case 'guest':
      case 'anonymous':
      case 'system':
        return { kind };
    }
  }
}
