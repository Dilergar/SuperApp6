import { Injectable } from '@nestjs/common';
import {
  AUDIENCE_ERROR_CODES,
  AUDIENCE_KIND_DEFS,
  AUDIENCE_LABEL_FORMS,
  TEAM_WORKSPACE_ROLES,
  audienceAnchorKey,
  audienceKindKey,
  isAudienceAnchor,
  type AudienceAnchor,
  type AudienceContext,
  type AudienceKind,
  type AudienceLabelDto,
  type AudienceLabelSnapshot,
  type AudienceRef,
} from '@superapp/shared';
import { renderAudienceLabel } from '@superapp/i18n';
import { DatabaseService } from '../../shared/database/database.service';
import { badRequest, type ErrorParams } from '../../shared/errors/api-error';
import { I18nService } from '../../shared/i18n/i18n.service';
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
  /**
   * Сузить вид `workspace` до ролей (например, `['owner', 'admin']` — «владельцу и
   * админам» у уведомлений тарифа). Без фильтра — вся команда (`TEAM_WORKSPACE_ROLES`).
   * На другие виды не действует: у них роли организации нет.
   */
  roles?: readonly string[];
}

/**
 * Отказ движка: слова берёт каталог по ключу, а машинный код остаётся прежним —
 * клиенты движка ветвятся по `details.code`, а не по фразе.
 */
const coded = (key: string, code: string, params?: ErrorParams) => badRequest(key, params, { code });

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
    private readonly i18n: I18nService,
  ) {}

  /** Подпись вида адресата в языке ЗАПРОСА — только для отказов и витрин */
  private kindLabel(kind: AudienceKind): string {
    return this.i18n.translate(audienceKindKey(kind));
  }

  /** Слово якоря («инициатора», «меня») в языке ЗАПРОСА — только для отказов */
  private anchorLabel(anchor: AudienceAnchor): string {
    return this.i18n.translate(audienceAnchorKey(anchor));
  }

  /** Развернуть список адресатов в уникальных живых людей (порядок — первого появления) */
  async resolve(refs: AudienceRef[], ctx: AudienceContext, opts: ResolveOptions): Promise<string[]> {
    const out = new Set<string>();
    const limit = opts.max + 1;
    for (const ref of refs) {
      if (opts.allowedKinds && !opts.allowedKinds.includes(ref.type)) {
        throw coded('audiences.kindNotAllowed', AUDIENCE_ERROR_CODES.kindNotAllowed, {
          kind: this.kindLabel(ref.type),
        });
      }
      const ids = await this.resolveOne(ref, ctx, limit, opts.roles);
      for (const id of ids) {
        out.add(id);
        if (out.size > opts.max && opts.onOverflow === 'truncate') break;
      }
      if (out.size > opts.max && opts.onOverflow === 'truncate') break;
    }
    let ids = [...out];
    if (ids.length > opts.max) {
      if (opts.onOverflow === 'throw') {
        throw coded('audiences.overflow', AUDIENCE_ERROR_CODES.overflow, { max: opts.max });
      }
      ids = ids.slice(0, opts.max);
    }
    if (!ids.length) return [];
    return this.liveOnly(ids, ctx.workspaceId);
  }

  /** Один адресат → люди (без фильтра живости и потолка — сырой разворот) */
  async resolveOne(ref: AudienceRef, ctx: AudienceContext, limit: number, roles?: readonly string[]): Promise<string[]> {
    const id = this.substituteAnchor(ref, ctx);
    switch (ref.type) {
      case 'user': {
        if (ctx.workspaceId && !(await this.isTeamMember(id, ctx.workspaceId))) return [];
        return [id];
      }
      case 'workspace': {
        if (!ctx.workspaceId || ctx.workspaceId !== id) return [];
        // Фильтр ролей сужает команду (владелец + админы); вне команды роль не считается.
        const allowed = roles ? TEAM_WORKSPACE_ROLES.filter((r) => roles.includes(r)) : [...TEAM_WORKSPACE_ROLES];
        if (!allowed.length) return [];
        // Боты (core/keys) — теневые пользователи с ролью staff|manager: адресатами не бывают
        const rows = await this.db.userRole.findMany({
          where: { context: WS_CONTEXT, tenantId: id, isActive: true, role: { in: allowed }, user: { kind: { not: 'bot' } } },
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
        if (!resolver) throw new Error(`audiences: kind "${ref.type}" is registered by nobody`);
        return resolver.resolve(id, ctx, limit);
      }
    }
  }

  /**
   * СНИМОК подписи адресата: ключ формы + имя сущности данными. Единственный выход
   * подписи из движка наружу — слова здесь нет.
   *
   * Снимок ложится и в вечную запись (хроника, уведомление, шаг согласования), и в
   * витрину: разные пути читают одну структуру, поэтому «Отдел «Продажи»» на экране
   * и в истории собирается одной формулой. Слово даёт `renderAudienceLabel` при
   * ЧТЕНИИ, в языке зрителя (docs/i18n.md, render-at-read).
   *
   * Имя — снимком, а не ссылкой: справочник переименуют, отдел расформируют, а
   * запись обязана остаться читаемой («Согласовал Главный бухгалтер» — тот, что был
   * тогда). Якорь (`$initiator`) остаётся якорем: за ним стоит не человек, а правило.
   */
  async labelSnapshot(ref: AudienceRef, ctx: AudienceContext): Promise<AudienceLabelSnapshot> {
    const def = AUDIENCE_KIND_DEFS[ref.type];
    const anchor = isAudienceAnchor(ref.id) ? ref.id : null;
    const base = { kind: ref.type, id: ref.id };
    const nameOfPerson = async (): Promise<string | null> => (anchor ? null : await this.userName(ref.id));

    if (def.relative) {
      switch (ref.type) {
        case 'manager_of':
          return {
            ...base,
            key: anchor ? AUDIENCE_LABEL_FORMS.managerOfAnchor : AUDIENCE_LABEL_FORMS.managerOf,
            name: await nameOfPerson(),
          };
        case 'subordinates_of':
          return {
            ...base,
            key: anchor ? AUDIENCE_LABEL_FORMS.teamOfAnchor : AUDIENCE_LABEL_FORMS.teamOf,
            name: await nameOfPerson(),
          };
        case 'branch_head_of': {
          // Своя форма нужна ровно для ОБЪЕКТА: имя объекта по его id знает StaffModule.
          const custom = await this.registry.get(ref.type)?.label?.(ref.id, ctx);
          if (custom) return { ...base, ...custom };
          return {
            ...base,
            key: anchor ? AUDIENCE_LABEL_FORMS.siteHeadOfAnchor : AUDIENCE_LABEL_FORMS.siteHeadOf,
            name: await nameOfPerson(),
          };
        }
        default:
          return { ...base, key: null, name: null };
      }
    }

    switch (ref.type) {
      case 'user':
        return { ...base, key: null, name: await nameOfPerson() };
      case 'workspace':
        return { ...base, key: AUDIENCE_LABEL_FORMS.wholeTeam, name: null };
      case 'department': {
        const row = await this.db.staffDepartment.findUnique({ where: { id: ref.id }, select: { name: true } });
        return { ...base, key: row ? AUDIENCE_LABEL_FORMS.department : null, name: row?.name ?? null };
      }
      case 'position': {
        const row = await this.db.staffPosition.findUnique({ where: { id: ref.id }, select: { name: true } });
        return { ...base, key: row ? AUDIENCE_LABEL_FORMS.position : null, name: row?.name ?? null };
      }
      case 'branch': {
        const row = await this.db.staffBranch.findUnique({ where: { id: ref.id }, select: { name: true } });
        return { ...base, key: row ? AUDIENCE_LABEL_FORMS.branch : null, name: row?.name ?? null };
      }
      default: {
        const custom = await this.registry.get(ref.type)?.label?.(ref.id, ctx);
        return { ...base, key: custom?.key ?? null, name: custom?.name ?? null };
      }
    }
  }

  /** Снимки пачкой (панель доступа, список шагов маршрута) */
  async labelSnapshots(refs: AudienceRef[], ctx: AudienceContext): Promise<AudienceLabelSnapshot[]> {
    return Promise.all(refs.map((ref) => this.labelSnapshot(ref, ctx)));
  }

  /**
   * Подпись адресата ТЕКСТОМ в языке запроса — только для ВИТРИН (панель доступа,
   * список шагов, отказ движка). В вечную запись такой текст класть нельзя: он
   * застынет в языке того, кто нажал кнопку, — туда идёт `labelSnapshot`
   * (страж `i18n/no-viewer-text-in-payload` держит это правило механически).
   */
  async labelText(ref: AudienceRef, ctx: AudienceContext): Promise<string> {
    return renderAudienceLabel(this.i18n.t, await this.labelSnapshot(ref, ctx));
  }

  /** Подписи витрины пачкой (см. `labelText`) */
  async labelTexts(refs: AudienceRef[], ctx: AudienceContext): Promise<AudienceLabelDto[]> {
    const snaps = await this.labelSnapshots(refs, ctx);
    const t = this.i18n.t;
    return snaps.map((snap, i) => ({ ...refs[i], label: renderAudienceLabel(t, snap) }));
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
        throw coded('audiences.notGrantable', AUDIENCE_ERROR_CODES.kindNotAllowed, {
          kind: this.kindLabel(ref.type),
        });
      }
      return { subjectType: ref.type, subjectId: ref.id, subjectRelation: principalSubjectRelation(ref.type) };
    });
  }

  // ------------------------------------------------------------

  private substituteAnchor(ref: AudienceRef, ctx: AudienceContext): string {
    if (!isAudienceAnchor(ref.id)) return ref.id;
    const value = this.anchorValue(ref.id, ctx);
    if (!value) {
      throw coded('audiences.anchorUnavailable', AUDIENCE_ERROR_CODES.anchorUnavailable, {
        label: `${this.kindLabel(ref.type)} ${this.anchorLabel(ref.id)}`,
      });
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

  /**
   * Имя человека для снимка. Нет строки → null, а НЕ слово-заглушка: подпись живёт
   * в вечной записи, и запечённое «Someone» осталось бы английским у казахоязычного
   * читателя навсегда. Слово вместо пустого имени подставит рендер при чтении.
   */
  private async userName(userId: string): Promise<string | null> {
    const u = await this.db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
    return u ? fullName(u) : null;
  }
}
