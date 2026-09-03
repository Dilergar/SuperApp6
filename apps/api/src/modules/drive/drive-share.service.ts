import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  DRIVE_NODE_REF_TYPE,
  DRIVE_ROLES,
  WORKSPACE_ROLE_RANK,
  type DriveRole,
  type DriveShareDto,
  type AudienceKind,
} from '@superapp/shared';
import { ChatterService } from '../../core/chatter/chatter.service';
import { ChatterRefRegistry } from '../../core/chatter/chatter-ref.registry';
import { DatabaseService } from '../../shared/database/database.service';
import { ContactsService } from '../contacts/contacts.service';
import { PersonalGraphRegistry } from '../contacts/personal-graph.registry';
import { NotificationsService } from '../notifications/notifications.service';
import { DriveAccessService, principalRelation } from './drive-access.service';
import { DriveService } from './drive.service';
import { AudiencesService } from '../../core/audiences/audiences.service';

const ROLE_LABEL: Record<DriveRole, string> = {
  viewer: 'смотрит',
  editor: 'правит',
  manager: 'управляет доступом',
};

/**
 * Шеринг узлов Диска.
 *
 * Грант — ОДНА строка в core/access на самом узле; наследование вглубь бесплатно
 * (его считает предикат по массиву предков), поэтому «открыть папку отделу» это одна
 * запись, а не проход по тысяче файлов внутри.
 */
@Injectable()
export class DriveShareService implements OnModuleInit {
  private readonly logger = new Logger(DriveShareService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly acl: DriveAccessService,
    private readonly drive: DriveService,
    private readonly contacts: ContactsService,
    private readonly graphHooks: PersonalGraphRegistry,
    private readonly notifications: NotificationsService,
    private readonly chatter: ChatterService,
    private readonly chatterRegistry: ChatterRefRegistry,
    private readonly audiences: AudiencesService,
  ) {}

  onModuleInit(): void {
    // Правило платформы: выдал грант «человеку из окружения» — зарегистрируй отзыв.
    // Иначе доступ переживёт разрыв связи (так когда-то жили календарь, витрины и книги).
    this.graphHooks.register('drive', {
      onUnlinked: (a, b) => this.revokeBetween(a, b),
    });
    // Хронику узла видит тот, кто видит сам узел.
    this.chatterRegistry.register(DRIVE_NODE_REF_TYPE, {
      canView: async (viewerId, nodeId) => {
        try {
          await this.drive.requireNode(viewerId, nodeId, 'viewer');
          return true;
        } catch {
          return false;
        }
      },
    });
  }

  // ============================================================
  // Чтение
  // ============================================================

  /**
   * Доступ к узлу: гранты на нём самом и на всех его предках. Унаследованные видны
   * отдельной пометкой — человек должен понимать, что «доступ у Ани» появился не
   * здесь, и снимать его надо там, где он выдан.
   */
  async listShares(userId: string, nodeId: string): Promise<DriveShareDto[]> {
    const { node } = await this.drive.requireNode(userId, nodeId, 'viewer');
    const chain = [...node.ancestorIds, node.id];
    const [tuples, names] = await Promise.all([
      this.acl.listGrants(chain),
      this.db.driveNode.findMany({ where: { id: { in: chain } }, select: { id: true, name: true } }),
    ]);
    const nameById = new Map(names.map((n) => [n.id, n.name]));
    const relevant = tuples.filter((t) => (DRIVE_ROLES as readonly string[]).includes(t.relation));
    // Имена получателей — БАТЧЕМ по типам: панель доступа папки, открытой десятку людей,
    // иначе делала бы по запросу на строку.
    const labels = await this.principalLabels(relevant.map((t) => ({ type: t.subjectType, id: t.subjectId })));
    return relevant.map((t) => ({
      principalType: t.subjectType,
      principalId: t.subjectId,
      // Имя нужно уже здесь: человек в интерфейсе рисуется карточкой, а ей нужно имя.
      principalName: labels.get(`${t.subjectType}:${t.subjectId}`) ?? t.subjectType,
      role: t.relation as DriveRole,
      nodeId: t.resourceId,
      nodeName: nameById.get(t.resourceId) ?? '',
      inherited: t.resourceId !== node.id,
    }));
  }

  /** Имена получателей доступа — единый словарь core/audiences (label через движок адресатов) */
  private async principalLabels(refs: Array<{ type: string; id: string }>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!refs.length) return out;
    const uniq = [...new Map(refs.map((r) => [`${r.type}:${r.id}`, r])).values()];
    const labels = await this.audiences.labelMany(
      uniq.map((r) => ({ type: r.type as AudienceKind, id: r.id })),
      { workspaceId: null },
    );
    for (const l of labels) out.set(`${l.type}:${l.id}`, l.label);
    return out;
  }

  // ============================================================
  // Запись
  // ============================================================

  async share(
    userId: string,
    nodeId: string,
    input: { principalType: string; principalId: string; role: DriveRole },
  ): Promise<DriveShareDto[]> {
    const { node } = await this.drive.requireNode(userId, nodeId, 'manager');
    const space = await this.drive.loadSpace(node.spaceId);
    await this.assertPrincipalAllowed(userId, space, input);

    // Одна роль на принципала: смена роли не должна оставлять старую строку —
    // иначе «понизил до просмотра» не понижало бы ничего.
    for (const role of DRIVE_ROLES) {
      if (role !== input.role) {
        await this.acl.revokeNode(nodeId, role, { type: input.principalType, id: input.principalId });
      }
    }
    await this.acl.grantNode(nodeId, input.role, { type: input.principalType, id: input.principalId });

    const label = await this.principalLabel(input.principalType, input.principalId);
    await this.chatter
      .log(null, {
        refType: DRIVE_NODE_REF_TYPE,
        refId: nodeId,
        workspaceId: space.ownerType === 'workspace' ? space.ownerId : null,
        actorId: userId,
        actorName: await this.actorName(userId),
        typeKey: 'drive.shared',
        payload: { targetName: node.name, principalLabel: label, roleLabel: ROLE_LABEL[input.role] },
      })
      .catch(() => undefined);

    await this.notifyRecipients(userId, node.id, node.name, input);
    return this.listShares(userId, nodeId);
  }

  async unshare(userId: string, nodeId: string, principalType: string, principalId: string): Promise<DriveShareDto[]> {
    const { node } = await this.drive.requireNode(userId, nodeId, 'manager');
    const space = await this.drive.loadSpace(node.spaceId);
    for (const role of DRIVE_ROLES) {
      await this.acl.revokeNode(nodeId, role, { type: principalType, id: principalId });
    }
    await this.chatter
      .log(null, {
        refType: DRIVE_NODE_REF_TYPE,
        refId: nodeId,
        workspaceId: space.ownerType === 'workspace' ? space.ownerId : null,
        actorId: userId,
        actorName: await this.actorName(userId),
        typeKey: 'drive.unshared',
        payload: {
          targetName: node.name,
          principalLabel: await this.principalLabel(principalType, principalId),
        },
      })
      .catch(() => undefined);
    return this.listShares(userId, nodeId);
  }

  /**
   * Связь между людьми разорвана (удаление из окружения или блок) — снимаем ЛИЧНЫЕ
   * гранты в обе стороны. Групповые рёбра (`@circle#member`) умирают вместе с
   * членством сами, их трогать не нужно. Идемпотентно: хук зовут и при удалении, и
   * при блокировке.
   */
  async revokeBetween(userAId: string, userBId: string): Promise<void> {
    for (const [owner, other] of [
      [userAId, userBId],
      [userBId, userAId],
    ]) {
      const spaces = await this.db.driveSpace.findMany({
        where: { ownerType: 'user', ownerId: owner },
        select: { id: true },
      });
      if (!spaces.length) continue;
      const grantedIds = await this.db.relationTuple.findMany({
        where: { resourceType: DRIVE_NODE_REF_TYPE, subjectType: 'user', subjectId: other },
        select: { id: true, resourceId: true },
      });
      if (!grantedIds.length) continue;
      const spaceIds = new Set(spaces.map((s) => s.id));
      const nodes = await this.db.driveNode.findMany({
        where: { id: { in: grantedIds.map((g) => g.resourceId) } },
        select: { id: true, spaceId: true },
      });
      const mine = new Set(nodes.filter((n) => spaceIds.has(n.spaceId)).map((n) => n.id));
      const doomed = grantedIds.filter((g) => mine.has(g.resourceId)).map((g) => g.id);
      if (!doomed.length) continue;
      await this.db.relationTuple.deleteMany({ where: { id: { in: doomed } } });
      this.logger.log(`отозвано ${doomed.length} грантов Диска между ${owner} и ${other}`);
    }
  }

  // ============================================================
  // Кому вообще можно выдавать доступ
  // ============================================================

  /**
   * Принципал обязан ПРИНАДЛЕЖАТЬ той же области, что и сам объект.
   *
   * Раньше проверялся только `user`, а остальные пять типов принимались как есть —
   * и это обходило все гейты платформы разом: указав ЧУЖУЮ Группу, человек раздавал
   * личный файл людям вне своего окружения (проверено: участник чужой Группы читал и
   * переименовывал папку), а указав отдел чужой организации — пробивал B2B-изоляцию.
   * Отдельная беда была бы дальше: `PersonalGraphRegistry` снимает только `user`-рёбра,
   * поэтому такой грант пережил бы и удаление контакта, и блокировку.
   *
   * Правило простое: на личном диске — человек из окружения и СВОЯ Группа; на диске
   * организации — её сотрудник и её же оси (вся команда, отдел, должность, филиал).
   */
  private async assertPrincipalAllowed(
    userId: string,
    space: { ownerType: string; ownerId: string },
    input: { principalType: string; principalId: string },
  ): Promise<void> {
    const personal = space.ownerType === 'user';

    switch (input.principalType) {
      case 'user': {
        if (input.principalId === userId) throw new BadRequestException('Себе доступ выдавать не нужно');
        if (personal) {
          // ЛИЧНЫЙ ресурс: «рабочий пропуск» здесь не годится — иначе грант достанется
          // коллеге вне окружения, а снимать его при разрыве связи будет нечему.
          await this.contacts.assertReachable(
            userId,
            [input.principalId],
            'Открыть доступ можно только человеку из вашего окружения',
            { personalOnly: true },
          );
        } else {
          const rank = await this.acl.workspaceRank(input.principalId, space.ownerId);
          if (rank < WORKSPACE_ROLE_RANK.trainee) {
            throw new BadRequestException('Этот человек не состоит в организации');
          }
        }
        return;
      }

      case 'circle': {
        // Группа — понятие ЛИЧНОГО окружения. На диске организации она означала бы
        // «пустить в рабочие файлы своих родственников», поэтому там её нет вовсе.
        if (!personal) throw new BadRequestException('На диске организации доступ выдаётся её сотрудникам, отделам, должностям и филиалам');
        const circle = await this.db.circle.findUnique({
          where: { id: input.principalId },
          select: { ownerId: true },
        });
        if (!circle || circle.ownerId !== userId) throw new BadRequestException('Такой Группы у вас нет');
        return;
      }

      case 'workspace': {
        // Единственный осмысленный случай — «вся команда» СВОЕЙ организации: ровно тот
        // грант, что стоит на корне её диска.
        if (personal || input.principalId !== space.ownerId) {
          throw new BadRequestException('Открыть доступ всей команде можно только на диске этой организации');
        }
        return;
      }

      case 'department':
      case 'position':
      case 'branch': {
        if (personal) throw new BadRequestException('Отделы, должности и филиалы бывают только у организации');
        const owner = await this.staffOwnerWorkspace(input.principalType, input.principalId);
        if (owner !== space.ownerId) throw new BadRequestException('Этот справочник принадлежит другой организации');
        return;
      }

      default:
        throw new BadRequestException('Неизвестный тип получателя доступа');
    }
  }

  /** Какой организации принадлежит ось оргструктуры (или null, если её нет) */
  private async staffOwnerWorkspace(type: string, id: string): Promise<string | null> {
    const row =
      type === 'department'
        ? await this.db.staffDepartment.findUnique({ where: { id }, select: { workspaceId: true } })
        : type === 'position'
          ? await this.db.staffPosition.findUnique({ where: { id }, select: { workspaceId: true } })
          : await this.db.staffBranch.findUnique({ where: { id }, select: { workspaceId: true } });
    return row?.workspaceId ?? null;
  }

  // ============================================================
  // Служебное
  // ============================================================

  private async notifyRecipients(
    actorId: string,
    nodeId: string,
    nodeName: string,
    input: { principalType: string; principalId: string; role: DriveRole },
  ): Promise<void> {
    // Уведомляем только адресный шеринг человеку: рассылка «всему отделу» о каждой
    // расшаренной папке быстро стала бы шумом, ради которого выключают уведомления.
    if (input.principalType !== 'user') return;
    const ownerName = await this.actorName(actorId);
    await this.notifications
      .notify(
        input.principalId,
        'drive.shared',
        { ownerName, nodeName, roleLabel: ROLE_LABEL[input.role], nodeId },
        { actionUrl: `/drive/n/${nodeId}` },
      )
      .catch(() => undefined);
  }

  private async actorName(userId: string): Promise<string> {
    const u = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    return u ? `${u.firstName}${u.lastName ? ` ${u.lastName}` : ''}` : 'Кто-то';
  }

  /** Как принципал называется в хронике («Аня Н.», «Группа Семья», «Отдел Продажи») */
  private async principalLabel(type: string, id: string): Promise<string> {
    return this.audiences.label({ type: type as AudienceKind, id }, { workspaceId: null });
  }

  /** Отношение принципала в tuple — общая карта движка Диска */
  relationOf(type: string): string {
    return principalRelation(type);
  }
}
