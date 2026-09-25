import { Injectable } from '@nestjs/common';
import { Prisma, type LifecycleHold } from '@prisma/client';
import {
  WORKSPACE_ROLE_RANK,
  decodeCursor,
  encodeCursor,
  lifecycleHoldableClasses,
  lifecyclePolicy,
  type CursorPage,
  type LifecycleHoldCreateInput,
  type LifecycleHoldDto,
  type LifecycleHoldReason,
  type LifecycleHoldsQuery,
  type WorkspaceRole,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { conflict, forbidden, notFound } from '../../shared/errors/api-error';
import { AuditService } from '../audit/audit.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { RolesService } from '../roles/roles.service';
import { LifecycleMetrics } from './lifecycle.metrics';
import { KeysEnvelopeService } from '../keys/keys.envelope.service';
import { colSql, deletableSql, deleteNeedsHoldCheck, eqSql, holdsCoveringRowSql, lifecycleTableOf, lockHoldsExclusive, lockHoldsShared, releasableIds } from './lifecycle.sql';

type Tx = Prisma.TransactionClient;
const WS = 'workspace';
const PAGE = { at: 'date', i: 'uuid' } as const;

/** Цель заморозки: область + её поля; `workspaceId` пуст — заморозка платформы. */
export type LifecycleHoldTarget = LifecycleHoldCreateInput & { workspaceId: string | null };

/** Кто ставит/снимает: человек организации или сотрудник Кабинета (командой). */
export interface LifecycleHoldActor {
  id: string;
  kind: 'user' | 'platform';
}

/**
 * Заморозки (legal hold): останавливают КАЖДЫЙ путь удаления по области — раннер сроков и
 * каскад организации (NOT EXISTS в операторе), стирание человека, корзины «навсегда»,
 * реап файлов, сброс партиций. Заморозка держит ДАННЫЕ, не доступы: отзыв сессий, ключей и
 * токенов («Это не я», стирание аккаунта) идёт всегда.
 *
 * Постановка берёт ИСКЛЮЧИТЕЛЬНЫЙ замок заморозок в своей транзакции: идущая пачка удаления
 * (общий замок) дожидается, и следующая уже видит заморозку — окна «проверил → удалил» нет.
 * Хранителю заморозка не показывается (M365, Google Vault): её видят админы организации
 * и Кабинет; путь удаления под заморозкой отвечает нейтральным «сохраняется по требованию
 * хранения данных».
 */
@Injectable()
export class LifecycleHoldsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly roles: RolesService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly metrics: LifecycleMetrics,
    private readonly envelope: KeysEnvelopeService,
  ) {}

  // ============================================================
  // Организация: владелец и админ живой организации, тариф `lifecycle.holds`
  // ============================================================

  private async roleIn(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    let best: WorkspaceRole | null = null;
    for (const r of await this.roles.getUserRoles(userId)) {
      if (r.context !== WS || r.tenantId !== workspaceId) continue;
      const rr = r.role as WorkspaceRole;
      if (!(rr in WORKSPACE_ROLE_RANK)) continue;
      if (!best || WORKSPACE_ROLE_RANK[rr] > WORKSPACE_ROLE_RANK[best]) best = rr;
    }
    return best;
  }

  /** Заморозки организации ведут владелец и админ. Чужому — 404 (не оракул существования). */
  async assertManager(userId: string, workspaceId: string): Promise<void> {
    const role = await this.roleIn(userId, workspaceId);
    if (role !== 'owner' && role !== 'admin') throw notFound('workspace.notFound');
    const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { isActive: true } });
    if (!ws) throw notFound('workspace.notFound');
    if (!ws.isActive) throw forbidden('workspace.inactive');
  }

  async createForWorkspace(userId: string, workspaceId: string, input: LifecycleHoldCreateInput): Promise<LifecycleHoldDto> {
    await this.assertManager(userId, workspaceId);
    await this.entitlements.assertFeature(userId, 'lifecycle.holds', { type: 'workspace', id: workspaceId });
    return this.create({ ...input, workspaceId }, { id: userId, kind: 'user' });
  }

  /** Снять можно только заморозку СВОЕЙ организации — заморозку платформы организация не видит и не снимает. */
  async releaseForWorkspace(userId: string, workspaceId: string, holdId: string, note: string | undefined): Promise<LifecycleHoldDto> {
    await this.assertManager(userId, workspaceId);
    return this.release(holdId, note, { id: userId, kind: 'user' }, { workspaceId });
  }

  async listForWorkspace(userId: string, workspaceId: string, q: LifecycleHoldsQuery): Promise<CursorPage<LifecycleHoldDto>> {
    await this.assertManager(userId, workspaceId);
    return this.list({ workspaceId }, q);
  }

  // ============================================================
  // Общее ядро (организация и команды Кабинета)
  // ============================================================

  async create(target: LifecycleHoldTarget, actor: LifecycleHoldActor, tx?: Tx): Promise<LifecycleHoldDto> {
    await this.assertTarget(target);
    const run = async (t: Tx) => {
      // Идущие пачки удаления (общий замок) дожидаются этой транзакции — следующая видит заморозку
      await lockHoldsExclusive(t);
      const row = await t.lifecycleHold.create({
        data: {
          scope: target.scope,
          workspaceId: target.workspaceId,
          custodianUserId: target.scope === 'custodian' ? target.custodianUserId! : null,
          spaceType: target.scope === 'space' ? target.spaceType! : null,
          spaceId: target.scope === 'space' ? target.spaceId! : null,
          recordType: target.scope === 'record' ? target.recordType! : null,
          recordId: target.scope === 'record' ? target.recordId! : null,
          dataClass: target.scope === 'class' ? target.dataClass! : null,
          reasonCode: target.reasonCode,
          note: target.note?.trim() || null,
          createdById: actor.id,
          createdByKind: actor.kind,
        },
      });
      // Хранителю событие не показывается: видимость — организация и платформа, субъект не ставится
      await this.audit.record(t, {
        key: 'lifecycle.hold.created',
        workspaceId: target.workspaceId,
        subjectUserId: null,
        target: { type: 'lifecycle_hold', id: row.id },
        details: { scope: target.scope, holdId: row.id },
      });
      return row;
    };
    const row = tx ? await run(tx) : await this.db.$transaction(run);
    this.metrics.holdsChanged('created', target.scope);
    return this.toDto(row);
  }

  /** `scope.workspaceId` задан — снимается только заморозка этой организации (путь организации). */
  async release(holdId: string, note: string | undefined, actor: LifecycleHoldActor, scope: { workspaceId?: string } = {}, tx?: Tx): Promise<LifecycleHoldDto> {
    const run = async (t: Tx) => {
      const where = { id: holdId, ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}) };
      const { count } = await t.lifecycleHold.updateMany({
        where: { ...where, releasedAt: null },
        data: { releasedAt: new Date(), releasedById: actor.id, releaseNote: note?.trim() || null },
      });
      const row = await t.lifecycleHold.findFirst({ where });
      if (!row) throw notFound('lifecycle.holdNotFound');
      if (count === 0) throw conflict('lifecycle.holdReleased');
      await this.audit.record(t, {
        key: 'lifecycle.hold.released',
        workspaceId: row.workspaceId,
        subjectUserId: null,
        target: { type: 'lifecycle_hold', id: row.id },
        details: { scope: row.scope as LifecycleHoldDto['scope'], holdId: row.id },
      });
      return row;
    };
    const row = tx ? await run(tx) : await this.db.$transaction(run);
    this.metrics.holdsChanged('released', row.scope);
    return this.toDto(row);
  }

  /** `workspaceId: null` — заморозки платформы; поле не задано — все (Кабинет). */
  async list(filter: { workspaceId?: string | null }, q: LifecycleHoldsQuery): Promise<CursorPage<LifecycleHoldDto>> {
    const take = q.limit ?? 50;
    const c = decodeCursor(q.cursor, PAGE);
    const rows = await this.db.lifecycleHold.findMany({
      where: {
        ...(filter.workspaceId !== undefined ? { workspaceId: filter.workspaceId } : {}),
        ...(q.active ? { releasedAt: null } : {}),
        ...(c ? { OR: [{ createdAt: { lt: c.at } }, { createdAt: c.at, id: { lt: c.i } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });
    const page = rows.slice(0, take);
    const last = page[page.length - 1];
    return { items: page.map((r) => this.toDto(r)), nextCursor: rows.length > take && last ? encodeCursor({ at: last.createdAt, i: last.id }) : null };
  }

  // ============================================================
  // Проверки путей удаления
  // ============================================================

  /**
   * Путь «навсегда» (корзина, реап) над строками политики: хоть одна под заморозкой — 409
   * `lifecycle.held`, НИЧЕГО не удаляется (частичное удаление поддерева оставило бы детей
   * без родителя). Зовётся В транзакции удаления: общий замок заморозок держится до коммита.
   */
  async assertReleasable(tx: Tx, policyId: string, ids: readonly string[]): Promise<void> {
    if (!(await this.allReleasable(tx, policyId, ids))) throw conflict('lifecycle.held');
  }

  /**
   * Все строки (корень и поддерево) свободны от заморозок — в транзакции удаления, под общим
   * замком: удаление родителя каскадом FK унесло бы удерживаемого ребёнка, поэтому проверяется
   * ВСЁ поддерево, а не корень. `false` — ничего не удалять (частично удалённое поддерево
   * оставило бы детей без родителя).
   */
  async allReleasable(tx: Tx, policyId: string, ids: readonly string[]): Promise<boolean> {
    if (!ids.length) return true;
    const policy = lifecyclePolicy(policyId);
    if (!policy) throw new Error(`lifecycle holds: unknown policy ${policyId}`);
    const ok = await releasableIds(tx, policy, ids);
    return ok.length >= new Set(ids).size;
  }

  /**
   * Заморозка ПЛАТФОРМЫ держит данные человека в этих политиках: хранитель — он сам, класс
   * данных политики или запись политики. Предохранитель шага стирания: личное (Диск, Заметки,
   * книга, магазин) держит только платформа — заморозки организаций до личного не дотягиваются
   * (цель проверена при постановке), в данных организаций проверка идёт построчно в шагах.
   * Запись любой из политик под заморозкой платформы держит шаг целиком (грубо, но в сторону
   * сохранения: шаги модулей не умеют пропустить одну запись поддерева).
   */
  async platformHeld(userId: string, policyIds: readonly string[], tx?: Tx): Promise<boolean> {
    const classes = [...new Set(policyIds.map((id) => lifecyclePolicy(id)?.dataClass).filter((c): c is NonNullable<typeof c> => !!c))];
    const n = await (tx ?? this.db).lifecycleHold.count({
      where: {
        releasedAt: null,
        workspaceId: null,
        OR: [
          { scope: 'custodian', custodianUserId: userId },
          ...(classes.length ? [{ scope: 'class', dataClass: { in: classes } }] : []),
          ...(policyIds.length ? [{ scope: 'record', recordType: { in: [...policyIds] } }] : []),
        ],
      },
    });
    return n > 0;
  }

  /**
   * Сохранить оригинал строки ПЕРЕД правкой или удалением, если её держит заморозка (модель
   * Slack / M365 preservation: человек не блокируется и не узнаёт о заморозке — оригинал
   * остаётся у процесса). По копии на каждую покрывающую заморозку; конверт — под KEK
   * организации заморозки или платформы (переживает стирание автора и его KEK). Зовётся в
   * транзакции изменения — под общим замком заморозок. Возвращает число копий.
   */
  async preserve(tx: Tx, policyId: string, rowId: string, row: Record<string, unknown>): Promise<number> {
    const policy = lifecyclePolicy(policyId);
    const t = policy ? lifecycleTableOf(policy) : null;
    if (!policy || !t) throw new Error(`lifecycle holds: ${policyId} has no table to preserve`);
    if (!policy.holdAware) return 0;
    await lockHoldsShared(tx);
    const holds = await tx.$queryRaw<Array<{ id: string; workspaceId: string | null }>>(holdsCoveringRowSql(policy, t, rowId));
    for (const h of holds) {
      const scope = h.workspaceId ? ({ type: 'workspace', id: h.workspaceId } as const) : ({ type: 'platform' } as const);
      const sealed = await this.envelope.encrypt(scope, { entity: 'lifecycle_hold_store', field: 'row', ownerType: 'lifecycle_hold', ownerId: h.id }, JSON.stringify(row));
      await tx.lifecycleHoldStore.create({
        data: {
          holdId: h.id,
          policyId,
          sourceTable: t.name,
          sourcePk: rowId,
          rowEnc: Buffer.from(sealed, 'utf8'),
          keyScope: h.workspaceId ? `workspace:${h.workspaceId}` : 'platform',
        },
      });
    }
    return holds.length;
  }

  /**
   * Среди строк политики, выбранных условием (`where` — SQL над алиасом `t`), есть такие, что
   * удалять нельзя: под заморозкой сами или держат удерживаемых потомков (`deletableSql`).
   */
  async anyHeldWhere(tx: Tx, policyId: string, where: Prisma.Sql): Promise<boolean> {
    const policy = lifecyclePolicy(policyId);
    const t = policy ? lifecycleTableOf(policy) : null;
    if (!policy || !t || !deleteNeedsHoldCheck(policy)) return false;
    await lockHoldsShared(tx);
    const [r] = await tx.$queryRaw<Array<{ held: boolean }>>`SELECT EXISTS (SELECT 1 FROM ${t.ident} t WHERE ${where} AND NOT ${deletableSql(policy, t)}) AS held`;
    return !!r?.held;
  }

  /** Человек — хранитель действующей заморозки (любой организации или платформы). */
  async custodianHeld(userId: string, tx?: Tx): Promise<boolean> {
    const n = await (tx ?? this.db).lifecycleHold.count({ where: { custodianUserId: userId, releasedAt: null } });
    return n > 0;
  }

  // ============================================================
  // Цель: существует и принадлежит организации заморозки
  // ============================================================

  private async assertTarget(target: LifecycleHoldTarget): Promise<void> {
    const ws = target.workspaceId;
    if (ws) {
      const exists = await this.db.workspace.findUnique({ where: { id: ws }, select: { id: true } });
      if (!exists) throw notFound('workspace.notFound');
    }
    switch (target.scope) {
      case 'custodian': {
        const userId = target.custodianUserId!;
        const user = await this.db.user.findUnique({ where: { id: userId }, select: { id: true } });
        if (!user) throw notFound('lifecycle.holdTargetInvalid');
        // Организация держит только своих: хранитель — её член (бывших держит платформа)
        if (ws && !(await this.db.workspaceMember.findFirst({ where: { workspaceId: ws, userId }, select: { userId: true } }))) {
          throw notFound('lifecycle.holdTargetInvalid');
        }
        return;
      }
      case 'space': {
        if (target.spaceType === 'workspace') {
          // Организация держит только себя целиком; платформа — любую существующую
          if (ws ? target.spaceId !== ws : !(await this.db.workspace.findUnique({ where: { id: target.spaceId! }, select: { id: true } }))) {
            throw notFound('lifecycle.holdTargetInvalid');
          }
          return;
        }
        const chat = await this.db.chat.findUnique({ where: { id: target.spaceId! }, select: { workspaceId: true } });
        if (!chat || (ws && chat.workspaceId !== ws)) throw notFound('lifecycle.holdTargetInvalid');
        return;
      }
      case 'record':
        return this.assertRecord(target.recordType!, target.recordId!, ws);
      case 'class':
        if (!lifecycleHoldableClasses().includes(target.dataClass!)) throw conflict('lifecycle.holdClassUnsupported');
        return;
    }
  }

  /**
   * Запись держится, только если движок проверит её в операторе удаления: политика модели с
   * одним ключом и `holdAware`. Организации — только своя запись (колонка организации в ключе
   * владельца); запись, чью организацию движок не выводит из строки, организация держит
   * хранителем или классом.
   */
  private async assertRecord(recordType: string, recordId: string, ws: string | null): Promise<void> {
    const policy = lifecyclePolicy(recordType);
    const t = policy ? lifecycleTableOf(policy) : null;
    if (!policy || !t || t.pk.length !== 1 || !policy.holdAware) throw conflict('lifecycle.holdRecordTypeUnsupported');
    const pkField = [...t.fields.values()].find((f) => f.column === t.pk[0])!;
    let org: Prisma.Sql = Prisma.sql`TRUE`;
    if (ws) {
      const ok = policy.ownerKey;
      if (ok.kind === 'workspace' && 'column' in ok) org = eqSql(t, ok.column, ws);
      else if (ok.kind === 'scoped') org = eqSql(t, ok.workspaceColumn, ws);
      else if (ok.kind === 'polymorphic' && ok.kinds.includes('workspace')) org = Prisma.sql`${colSql(t, ok.typeColumn)}::text = 'workspace' AND ${eqSql(t, ok.column, ws)}`;
      else throw conflict('lifecycle.holdRecordTypeUnsupported');
    }
    const [row] = await this.db.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok FROM ${t.ident} t WHERE ${eqSql(t, pkField.name, recordId)} AND ${org} LIMIT 1`;
    if (!row) throw notFound('lifecycle.holdTargetInvalid');
  }

  toDto(r: LifecycleHold): LifecycleHoldDto {
    return {
      id: r.id,
      scope: r.scope as LifecycleHoldDto['scope'],
      workspaceId: r.workspaceId,
      custodianUserId: r.custodianUserId,
      spaceType: r.spaceType,
      spaceId: r.spaceId,
      recordType: r.recordType,
      recordId: r.recordId,
      dataClass: r.dataClass,
      reasonCode: r.reasonCode as LifecycleHoldReason,
      note: r.note,
      createdById: r.createdById,
      createdAt: r.createdAt.toISOString(),
      releasedAt: r.releasedAt?.toISOString() ?? null,
      releasedById: r.releasedById,
      releaseNote: r.releaseNote,
    };
  }
}
