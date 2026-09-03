import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AUDIENCE_ANCHOR_LABELS,
  AUDIENCE_ERROR_CODES,
  AUDIENCE_KIND_DEFS,
  TEAM_WORKSPACE_ROLES,
  isAudienceAnchor,
  type AudienceAnchor,
  type AudienceContext,
  type AudienceKind,
  type AudienceLabelDto,
  type AudienceRef,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { principalSubjectRelation } from '../access/access-schema';
import type { SubjectRef } from '../access/access.types';
import { fullName } from '../../shared/utils/user-name';
import { AudiencesRegistry } from './audiences.registry';

const WS_CONTEXT = 'workspace';

/**
 * Одна карта «ось оргструктуры → отношения проекции», по которым ось разворачивается в
 * людей. Голова отдела/объекта записана `head` и ВХОДИТ в состав отдела/объекта — как
 * и в лестнице ROLE_LADDERS движка прав (единое правило для check/grantSetFor/адресатов).
 */
const AXIS_RELATIONS: Record<'department' | 'position' | 'branch', string[]> = {
  department: ['member', 'head'],
  position: ['holder'],
  branch: ['member', 'head'],
};

export interface ResolveOptions {
  /** Потолок состава */
  max: number;
  /** Превышение: честный отказ кодом `audience_overflow` или молчаливая обрезка (семантика вызывающего) */
  onOverflow: 'throw' | 'truncate';
  /** Какие виды допускает потребитель (иначе — все из словаря); чужой вид → 400 */
  allowedKinds?: readonly AudienceKind[];
}

const coded = (message: string, code: string) => new BadRequestException({ message, details: { code } });

/**
 * core/audiences — 16-й движок: единый словарь и разворот АДРЕСАТОВ в людей.
 *
 * Правила:
 *  - движок РЕШАЕТ, кому адресовано, и НЕ пишет гранты (шаблоны/Диск пишут рёбра сами,
 *    `principalsFor` отдаёт им форму субъекта);
 *  - якорь (`$initiator`/`$subject`/`$self`) подставляется из контекста ДО любого
 *    Prisma-`where`; якорь без контекста → `audience_anchor_unavailable`, не `[]`;
 *  - организация скоупит всё: чужой отдел → пусто, человек вне команды → пусто,
 *    подрядчики никогда не в составе (в личном контексте — только живые аккаунты);
 *  - относительные виды регистрирует StaffModule, `circle` — ContactsModule;
 *    сам движок читает только `relationTuple` и `user_roles` (ребро core → modules
 *    роняет CI).
 */
@Injectable()
export class AudiencesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly registry: AudiencesRegistry,
  ) {}

  /** Развернуть список адресатов в уникальных живых людей (порядок — первого появления) */
  async resolve(refs: AudienceRef[], ctx: AudienceContext, opts: ResolveOptions): Promise<string[]> {
    const out = new Set<string>();
    const limit = opts.max + 1;
    for (const ref of refs) {
      if (opts.allowedKinds && !opts.allowedKinds.includes(ref.type)) {
        throw coded(`Адресат вида «${ref.type}» здесь недопустим`, AUDIENCE_ERROR_CODES.kindNotAllowed);
      }
      const ids = await this.resolveOne(ref, ctx, limit);
      for (const id of ids) {
        out.add(id);
        if (out.size > opts.max && opts.onOverflow === 'truncate') break;
      }
      if (out.size > opts.max && opts.onOverflow === 'truncate') break;
    }
    let ids = [...out];
    if (ids.length > opts.max) {
      if (opts.onOverflow === 'throw') {
        throw coded(
          `Адресатов больше потолка (${opts.max}) — сузьте аудиторию или используйте массовый инструмент`,
          AUDIENCE_ERROR_CODES.overflow,
        );
      }
      ids = ids.slice(0, opts.max);
    }
    if (!ids.length) return [];
    return this.liveOnly(ids, ctx.workspaceId);
  }

  /** Один адресат → люди (без фильтра живости и потолка — сырой разворот) */
  async resolveOne(ref: AudienceRef, ctx: AudienceContext, limit: number): Promise<string[]> {
    const id = this.substituteAnchor(ref, ctx);
    switch (ref.type) {
      case 'user': {
        if (ctx.workspaceId && !(await this.isTeamMember(id, ctx.workspaceId))) return [];
        return [id];
      }
      case 'workspace': {
        if (!ctx.workspaceId || ctx.workspaceId !== id) return [];
        const rows = await this.db.userRole.findMany({
          where: { context: WS_CONTEXT, tenantId: id, isActive: true, role: { in: [...TEAM_WORKSPACE_ROLES] } },
          select: { userId: true },
          take: limit,
        });
        return [...new Set(rows.map((r) => r.userId))];
      }
      case 'department':
      case 'position':
      case 'branch': {
        if (ctx.workspaceId && !(await this.belongsToWorkspace(ref.type, id, ctx.workspaceId))) return [];
        const rows = await this.db.relationTuple.findMany({
          where: {
            resourceType: ref.type,
            resourceId: id,
            relation: { in: AXIS_RELATIONS[ref.type] },
            subjectType: 'user',
            subjectRelation: '',
          },
          select: { subjectId: true },
          take: limit,
        });
        return [...new Set(rows.map((r) => r.subjectId))];
      }
      default: {
        const resolver = this.registry.get(ref.type);
        if (!resolver) throw new Error(`audiences: вид «${ref.type}» никем не зарегистрирован`);
        return resolver.resolve(id, ctx, limit);
      }
    }
  }

  /** Подпись адресата для витрин («Отдел «Продажи»», «Руководитель инициатора») */
  async label(ref: AudienceRef, ctx: AudienceContext): Promise<string> {
    const def = AUDIENCE_KIND_DEFS[ref.type];
    const anchor = isAudienceAnchor(ref.id) ? ref.id : null;
    if (def.relative) {
      const who = anchor
        ? AUDIENCE_ANCHOR_LABELS[anchor]
        : await this.userName(ref.id);
      switch (ref.type) {
        case 'manager_of':
          return anchor ? `Руководитель ${who}` : `Руководитель: ${who}`;
        case 'subordinates_of':
          return anchor ? `Команда ${who}` : `Команда: ${who}`;
        case 'branch_head_of': {
          const custom = await this.registry.get(ref.type)?.label?.(ref.id, ctx);
          if (custom) return custom;
          return anchor ? `Руководитель объекта ${who}` : `Руководитель объекта: ${who}`;
        }
        default:
          return def.label;
      }
    }
    switch (ref.type) {
      case 'user':
        return anchor ? AUDIENCE_ANCHOR_LABELS[anchor] : await this.userName(ref.id);
      case 'workspace':
        return 'вся команда';
      case 'department': {
        const row = await this.db.staffDepartment.findUnique({ where: { id: ref.id }, select: { name: true } });
        return row ? `Отдел «${row.name}»` : def.label;
      }
      case 'position': {
        const row = await this.db.staffPosition.findUnique({ where: { id: ref.id }, select: { name: true } });
        return row ? `Должность «${row.name}»` : def.label;
      }
      case 'branch': {
        const row = await this.db.staffBranch.findUnique({ where: { id: ref.id }, select: { name: true } });
        return row ? `Объект «${row.name}»` : def.label;
      }
      default: {
        const custom = await this.registry.get(ref.type)?.label?.(ref.id, ctx);
        return custom ?? def.label;
      }
    }
  }

  async labelMany(refs: AudienceRef[], ctx: AudienceContext): Promise<AudienceLabelDto[]> {
    return Promise.all(refs.map(async (ref) => ({ ...ref, label: await this.label(ref, ctx) })));
  }

  /** Принадлежит ли ось оргструктуры организации (человек — команде; вся команда — ей самой) */
  async belongsToWorkspace(type: AudienceKind, id: string, workspaceId: string): Promise<boolean> {
    switch (type) {
      case 'department':
        return (await this.db.staffDepartment.count({ where: { id, workspaceId } })) > 0;
      case 'position':
        return (await this.db.staffPosition.count({ where: { id, workspaceId } })) > 0;
      case 'branch':
        return (await this.db.staffBranch.count({ where: { id, workspaceId } })) > 0;
      case 'workspace':
        return id === workspaceId;
      case 'user':
      case 'manager_of':
      case 'subordinates_of':
        return isAudienceAnchor(id) || this.isTeamMember(id, workspaceId);
      case 'branch_head_of':
        return (
          isAudienceAnchor(id) ||
          (await this.isTeamMember(id, workspaceId)) ||
          (await this.db.staffBranch.count({ where: { id, workspaceId } })) > 0
        );
      default:
        return false;
    }
  }

  /**
   * Форма субъекта ребра прав для ГРАНТУЕМЫХ видов (шаблоны/Диск пишут рёбра сами).
   * Относительный вид — не принципал: `audience_kind_not_allowed`.
   */
  principalsFor(refs: AudienceRef[]): SubjectRef[] {
    return refs.map((ref) => {
      if (!AUDIENCE_KIND_DEFS[ref.type].grantable || isAudienceAnchor(ref.id)) {
        throw coded(`Адресат вида «${ref.type}» не может быть получателем доступа`, AUDIENCE_ERROR_CODES.kindNotAllowed);
      }
      return { subjectType: ref.type, subjectId: ref.id, subjectRelation: principalSubjectRelation(ref.type) };
    });
  }

  // ------------------------------------------------------------

  private substituteAnchor(ref: AudienceRef, ctx: AudienceContext): string {
    if (!isAudienceAnchor(ref.id)) return ref.id;
    const value = this.anchorValue(ref.id, ctx);
    if (!value) {
      throw coded(
        `Адресат «${AUDIENCE_KIND_DEFS[ref.type].label} ${AUDIENCE_ANCHOR_LABELS[ref.id]}» здесь неизвестен: у вызова нет такого контекста`,
        AUDIENCE_ERROR_CODES.anchorUnavailable,
      );
    }
    return value;
  }

  private anchorValue(anchor: AudienceAnchor, ctx: AudienceContext): string | null {
    switch (anchor) {
      case '$initiator':
        return ctx.initiatorId ?? null;
      case '$subject':
        return ctx.subjectId ?? null;
      case '$self':
        return ctx.selfId ?? null;
      default:
        return null;
    }
  }

  private async isTeamMember(userId: string, workspaceId: string): Promise<boolean> {
    return (
      (await this.db.userRole.count({
        where: { userId, context: WS_CONTEXT, tenantId: workspaceId, isActive: true, role: { in: [...TEAM_WORKSPACE_ROLES] } },
      })) > 0
    );
  }

  /** Живые: в организации — только команда (подрядчики вне), в личном — существующие аккаунты */
  private async liveOnly(ids: string[], workspaceId: string | null): Promise<string[]> {
    if (workspaceId) {
      const live = await this.db.userRole.findMany({
        where: { userId: { in: ids }, context: WS_CONTEXT, tenantId: workspaceId, isActive: true, role: { in: [...TEAM_WORKSPACE_ROLES] } },
        select: { userId: true },
      });
      const alive = new Set(live.map((r) => r.userId));
      return ids.filter((id) => alive.has(id));
    }
    const users = await this.db.user.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } });
    const alive = new Set(users.map((u) => u.id));
    return ids.filter((id) => alive.has(id));
  }

  private async userName(userId: string): Promise<string> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
    return fullName(u);
  }
}
