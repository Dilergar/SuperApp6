import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DRIVE_NODE_REF_TYPE,
  DRIVE_ROLE_RANK,
  WORKSPACE_ROLE_RANK,
  type DriveAccess,
  type DriveRole,
  type WorkspaceRole,
} from '@superapp/shared';
import { AccessService } from '../../core/access/access.service';
import { principalSubjectRelation } from '../../core/access/access-schema';
import { RolesService } from '../../core/roles/roles.service';
import { DatabaseService } from '../../shared/database/database.service';

type SpaceRow = {
  id: string;
  kind: string;
  ownerType: string;
  ownerId: string;
  rootId: string | null;
};

/**
 * Грант-сет зрителя по узлам Диска, развёрнутый в три набора id.
 * Наборы НАКОПИТЕЛЬНЫЕ: у кого есть manager, у того есть и editor, и viewer.
 */
export interface DriveGrants {
  viewer: string[];
  editor: string[];
  manager: string[];
  /** Закрытые папки: на них обрывается наследование прав сверху (см. nodeAccess) */
  restricted: string[];
}

const EMPTY_GRANTS: DriveGrants = { viewer: [], editor: [], manager: [], restricted: [] };

/**
 * Права Диска.
 *
 * Разделение обязанностей: `core/access` ХРАНИТ гранты (по одной строке на шеринг) и
 * умеет их массово отдать (`grantSetFor`), а наследование по дереву считает Диск —
 * материализованным массивом предков и одним условием в SQL:
 *
 *     владелец пространства  OR  id = ANY(:granted)  OR  ancestor_ids && :granted
 *
 * Рекурсивная схема в движке отвергнута гриллом: у папки до 32 уровней предков, и
 * поштучный обход стоил бы десятки запросов на КАЖДУЮ проверку, а тип-эпоха кэша
 * сбрасывала бы права всей платформы при каждом шеринге. Прецеденты «движок хранит,
 * домен считает массово» в проекте уже есть — closure отделов и поиск сообщений.
 *
 * ⚠️ `check()`/`can()` движка для типов Диска НЕ используются: у них пустой фанаут
 * эпох, то есть кэш никто не инвалидирует. Все решения принимаются здесь, по живым
 * tuples.
 */
@Injectable()
export class DriveAccessService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: AccessService,
    private readonly roles: RolesService,
  ) {}

  // ------------------------------------------------------------
  // Гранты
  // ------------------------------------------------------------

  /** Все узлы, на которые зрителю что-то выдано (одним походом в движок) */
  async grantsFor(userId: string): Promise<DriveGrants> {
    const { granted } = await this.access.grantSetFor(userId, DRIVE_NODE_REF_TYPE);
    const manager = granted.get('manager') ?? [];
    const editor = [...new Set([...manager, ...(granted.get('editor') ?? [])])];
    const viewer = [...new Set([...editor, ...(granted.get('viewer') ?? [])])];
    // Закрытые папки грузим ОДНИМ списком, а не по цепочке на каждую проверку: их
    // единицы (личные дела организации), список ходит под партиальным индексом и
    // раздаётся всем путям проверки прав разом — иначе каждый забывший его путь
    // молча открывал бы закрытое. Вырастет число — список скоупится пространством.
    const restrictedRows = await this.db.driveNode.findMany({
      where: { restricted: true, trashedAt: null },
      select: { id: true },
    });
    return { viewer, editor, manager, restricted: restrictedRows.map((r) => r.id) };
  }

  /** Набор узлов, дающих зрителю право не ниже требуемого */
  grantedFor(grants: DriveGrants, need: DriveRole): string[] {
    return grants[need];
  }

  // ------------------------------------------------------------
  // Пространство
  // ------------------------------------------------------------

  /**
   * Что зритель может в пространстве САМ ПО СЕБЕ, без грантов на узлы.
   *
   * Личное пространство — только его хозяин. Пространство организации: владелец и
   * админ администрируют его целиком (они и так меняют роли — прятать от них папки
   * было бы театром), а вот менеджер получает силу через ГРАНТ на корне, а не по
   * должности: иначе папка, открытая только владельцу, всё равно светилась бы всем
   * менеджерам, и «закрытая папка» перестала бы что-то значить.
   */
  async spaceAccess(userId: string, space: SpaceRow): Promise<DriveAccess | null> {
    if (space.ownerType === 'user') return space.ownerId === userId ? 'owner' : null;
    const rank = await this.workspaceRank(userId, space.ownerId);
    if (rank >= WORKSPACE_ROLE_RANK.admin) return 'owner';
    return null;
  }

  /** Наивысшая роль зрителя в организации (0 — не в команде) */
  async workspaceRank(userId: string, workspaceId: string): Promise<number> {
    const rows = await this.roles.getRolesInContext(userId, 'workspace', workspaceId);
    let best = 0;
    for (const r of rows) best = Math.max(best, WORKSPACE_ROLE_RANK[r.role as WorkspaceRole] ?? 0);
    return best;
  }

  // ------------------------------------------------------------
  // Узел
  // ------------------------------------------------------------

  /**
   * Права зрителя на конкретном узле: максимум из «владею пространством» и всех
   * грантов на самом узле и его предках. Права СКЛАДЫВАЮТСЯ (модель Google Drive):
   * грант «смотреть» на папке и «править» на файле внутри дают право править.
   */
  nodeAccess(
    node: { id: string; ancestorIds: string[] },
    spaceAccess: DriveAccess | null,
    grants: DriveGrants,
  ): DriveAccess | null {
    if (spaceAccess === 'owner') return 'owner';

    // ЗАКРЫТАЯ ПАПКА обрывает наследование сверху: считаем права только от самой
    // глубокой закрытой папки на пути и ниже. Без этого «Личные дела» на диске
    // организации были бы открыты всей команде — корень раздаёт editor каждому
    // сотруднику, и грант с корня доставал бы внутрь любой папки.
    const path = [...node.ancestorIds, node.id]; // корень → сам узел
    let from = 0;
    if (grants.restricted.length) {
      const closed = new Set(grants.restricted);
      for (let i = path.length - 1; i >= 0; i--) {
        if (closed.has(path[i])) {
          from = i;
          break;
        }
      }
    }
    const chain = new Set(path.slice(from));
    // Пространственный доступ (не-owner) внутрь закрытой папки не проходит.
    let best: DriveAccess | null = from === 0 ? spaceAccess : null;
    for (const role of ['manager', 'editor', 'viewer'] as const) {
      if (grants[role].some((id) => chain.has(id))) {
        best = this.strongest(best, role);
        break; // наборы накопительные: нашли manager — сильнее уже не будет
      }
    }
    return best;
  }

  /** Бросить, если прав на узле не хватает */
  assertAccess(access: DriveAccess | null, need: DriveRole, what = 'этому объекту'): void {
    if (!access) throw new NotFoundException('Объект не найден');
    if (this.rank(access) < DRIVE_ROLE_RANK[need]) {
      throw new ForbiddenException(
        need === 'manager'
          ? 'Управлять доступом может только владелец объекта'
          : `Нет прав на изменение: доступ к ${what} только на просмотр`,
      );
    }
  }

  private rank(access: DriveAccess): number {
    return access === 'owner' ? 100 : DRIVE_ROLE_RANK[access];
  }

  private strongest(a: DriveAccess | null, b: DriveAccess): DriveAccess {
    if (!a) return b;
    return this.rank(a) >= this.rank(b) ? a : b;
  }

  // ------------------------------------------------------------
  // Предикат для массовых выборок
  // ------------------------------------------------------------

  /**
   * Условие видимости узла в сыром SQL. Владелец пространства видит всё — предикат
   * схлопывается в TRUE, и запрос идёт по обычному btree-индексу; постороннему с
   * грантами достаётся проверка «сам узел или кто-то из предков в выданном наборе»
   * (GIN по ancestor_ids).
   *
   * Алиас таблицы передаётся строкой и НЕ приходит из пользовательского ввода —
   * это литерал вызывающего кода.
   */
  visibilitySql(alias: string, spaceAccess: DriveAccess | null, granted: string[]): Prisma.Sql {
    if (spaceAccess === 'owner') return Prisma.sql`TRUE`;
    if (!granted.length) return Prisma.sql`FALSE`;
    const ids = Prisma.sql`${granted}::text[]`;
    const col = Prisma.raw(`"${alias}"`);
    return Prisma.sql`(${col}."id" = ANY(${ids}) OR ${col}."ancestor_ids" && ${ids})`;
  }

  // ------------------------------------------------------------
  // Гранты: запись
  // ------------------------------------------------------------

  /**
   * `principal.relation` задаётся явно только для служебных грантов «по должности в
   * организации» (корень диска организации: `#member` — вся команда, `#manager` —
   * управляющие). Человеческий шеринг его не передаёт и получает правильное
   * отношение из карты.
   */
  async grantNode(
    nodeId: string,
    role: DriveRole,
    principal: { type: string; id: string; relation?: string },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await this.access.grant(
      {
        resourceType: DRIVE_NODE_REF_TYPE,
        resourceId: nodeId,
        relation: role,
        subjectType: principal.type,
        subjectId: principal.id,
        subjectRelation: principal.relation ?? principalRelation(principal.type),
      },
      tx,
    );
  }

  async revokeNode(nodeId: string, role: DriveRole, principal: { type: string; id: string; relation?: string }): Promise<void> {
    await this.access.revoke({
      resourceType: DRIVE_NODE_REF_TYPE,
      resourceId: nodeId,
      relation: role,
      subjectType: principal.type,
      subjectId: principal.id,
      subjectRelation: principal.relation ?? principalRelation(principal.type),
    });
  }

  /** Все гранты на конкретных узлах (для панели «Доступ» и хроники) */
  async listGrants(nodeIds: string[]): Promise<
    Array<{ resourceId: string; relation: string; subjectType: string; subjectId: string; subjectRelation: string }>
  > {
    if (!nodeIds.length) return [];
    return this.db.relationTuple.findMany({
      where: { resourceType: DRIVE_NODE_REF_TYPE, resourceId: { in: nodeIds } },
      select: { resourceId: true, relation: true, subjectType: true, subjectId: true, subjectRelation: true },
    });
  }

  /** Снять ВСЕ гранты узла (узел уничтожен): tuples внешними ключами не связаны */
  async revokeAllOn(nodeIds: string[]): Promise<void> {
    for (const id of nodeIds) await this.access.revokeResource(DRIVE_NODE_REF_TYPE, id);
  }

  static readonly emptyGrants = EMPTY_GRANTS;
}

/**
 * Как принципал записывается в субъект tuple'а. Карта живёт в движке прав
 * (`principalSubjectRelation`) — она общая для всех, кто выдаёт гранты: ошибка здесь
 * означает «грант выдан, но никого не находит», и второй копии у неё быть не должно.
 */
export const principalRelation = principalSubjectRelation;
