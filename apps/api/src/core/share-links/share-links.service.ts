import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type ShareLink } from '@prisma/client';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import {
  SHARE_LINK_LIMITS,
  buildShareLinkUrl,
  shareLinkStatus,
  type CreateShareLinkInput,
  type ShareLinkDto,
  type ShareLinksPage,
  type ShareLinkVisitsPage,
  type UpdateShareLinkInput,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { ChatterService } from '../chatter/chatter.service';
import { ShareLinksRegistry, type ShareRefContext } from './share-links.registry';

const BCRYPT_ROUNDS = 12;

/**
 * Управление гостевыми ссылками: создать, посмотреть, поправить, отозвать, прочитать
 * журнал визитов. Гостевую половину (открытие ссылки) ведёт ShareLinksGuestService.
 *
 * Право управлять решает РЕЗОЛВЕР ПОТРЕБИТЕЛЯ (ShareLinksRegistry) — движок не знает
 * ни Диска, ни документов. core/access здесь не участвует вовсе: гость не принципал,
 * а строка ссылки и есть выданный ему грант.
 */
@Injectable()
export class ShareLinksService {
  private readonly logger = new Logger(ShareLinksService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: ShareLinksRegistry,
    private readonly chatter: ChatterService,
  ) {}

  // ============================================================
  // Управление
  // ============================================================

  async create(userId: string, dto: CreateShareLinkInput): Promise<ShareLinkDto> {
    const ctx = await this.authorize(userId, dto.refType, dto.refId);

    // Хэш считаем ДО транзакции: bcrypt на 12 раундах — это сотни миллисекунд, и
    // держать на них открытую транзакцию с взятым локом незачем.
    const passwordHash = dto.password ? await bcrypt.hash(dto.password, BCRYPT_ROUNDS) : null;

    const link = await this.db.$transaction(async (tx) => {
      // Потолок «на объект» проверяется ПОД advisory-локом этого объекта: посчитать до
      // локa значит посчитать состояние, которого к моменту вставки уже нет, и два
      // параллельных запроса дают 21-ю ссылку. Образец — lockSpace Диска; hashtext
      // отдаёт int4, коллизия двух объектов стоит лишь лишней сериализации.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${dto.refType}:${dto.refId}`}))`;

      // Потолки: на объект — чтобы список ссылок оставался обозримым, на человека —
      // анти-мусорный (ссылка бесплатна, а раздаёт доступ наружу). Второй под локом не
      // сидит намеренно: это потолок от мусора, а не инвариант, и запирать под общий
      // ключ все объекты человека ради него — дороже, чем изредка пропущенная 501-я.
      const [onRef, byCreator] = await Promise.all([
        tx.shareLink.count({ where: { refType: dto.refType, refId: dto.refId, revokedAt: null } }),
        tx.shareLink.count({ where: { createdById: userId, revokedAt: null } }),
      ]);
      if (onRef >= SHARE_LINK_LIMITS.maxActivePerRef) {
        throw new BadRequestException(
          `У объекта уже ${SHARE_LINK_LIMITS.maxActivePerRef} действующих ссылок — отзовите ненужные`,
        );
      }
      if (byCreator >= SHARE_LINK_LIMITS.maxActivePerCreator) {
        throw new BadRequestException('Достигнут лимит действующих гостевых ссылок');
      }

      return tx.shareLink.create({
        data: {
          token: randomBytes(SHARE_LINK_LIMITS.tokenBytes).toString('base64url'),
          refType: dto.refType,
          refId: dto.refId,
          ownerType: ctx.ownerType,
          ownerId: ctx.ownerId,
          workspaceId: ctx.workspaceId,
          createdById: userId,
          label: dto.label ?? null,
          expiresAt: dto.expiresAt ?? null,
          maxOpens: dto.maxOpens ?? null,
          passwordHash,
        },
      });
    });

    await this.logChatter(userId, link, ctx, 'share.link_created');
    return this.serialize(link);
  }

  /**
   * Ссылки объекта, включая отозванные и истёкшие: это ещё и история раздачи наружу.
   *
   * Список обрезан потолком: отозванные не удаляются никогда, и без предела ответ рос
   * бы без границ. `total` говорит, сколько их всего, — молча обрезать историю раздачи
   * данных наружу нельзя, ровно в ней и разбираются, когда файл где-то всплыл.
   *
   * `nulls: 'first'` обязателен: в Postgres `ORDER BY revoked_at ASC` кладёт NULL в
   * КОНЕЦ, то есть действующие ссылки уезжали бы за потолок страницы, а на первом
   * экране оставалась одна история.
   */
  async list(userId: string, refType: string, refId: string): Promise<ShareLinksPage> {
    await this.authorize(userId, refType, refId);
    const [rows, total] = await Promise.all([
      this.db.shareLink.findMany({
        where: { refType, refId },
        orderBy: [{ revokedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
        take: SHARE_LINK_LIMITS.listPageSize,
      }),
      this.db.shareLink.count({ where: { refType, refId } }),
    ]);
    return { items: rows.map((r) => this.serialize(r)), total };
  }

  /**
   * Правка. Право берётся у объекта ЗАНОВО (а не «автор ссылки»): управляющий
   * объектом обязан уметь поправить чужую ссылку на него — иначе уволенный
   * сотрудник оставлял бы после себя вечные ссылки, которые некому закрыть.
   */
  async update(userId: string, id: string, dto: UpdateShareLinkInput): Promise<ShareLinkDto> {
    const link = await this.loadOrThrow(id);
    await this.authorize(userId, link.refType, link.refId);
    if (link.revokedAt) throw new BadRequestException('Ссылка отозвана — создайте новую');

    const data: Prisma.ShareLinkUpdateInput = {};
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.expiresAt !== undefined) data.expiresAt = dto.expiresAt;
    if (dto.maxOpens !== undefined) data.maxOpens = dto.maxOpens;
    if (dto.password !== undefined) {
      data.passwordHash = dto.password === null ? null : await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
      // Новый пароль обнуляет счёт неудач и снимает блокировку подбора: попытки
      // относились к СТАРОМУ паролю, а смена — это ещё и способ владельца разблокировать
      // получателя, который сам себя запер опечатками.
      data.pwdFailedAttempts = 0;
      data.pwdLockedUntil = null;
    }

    const updated = await this.db.shareLink.update({ where: { id: link.id }, data });
    return this.serialize(updated);
  }

  /**
   * Отзыв. Идемпотентен: повторный вызов возвращает ту же отозванную ссылку.
   *
   * Что отзыв гасит мгновенно: страницу, листинг папки, любой следующий запрос гостя —
   * строка ссылки перечитывается на КАЖДОМ из них, и живая гостевая сессия умирает сразу.
   *
   * Чего он не может: ссылки на БАЙТЫ, которые гость уже получил. Они подписаны на
   * ~10 минут (FILE_LIMITS.urlTtlSec) и живут своей жизнью — как presigned-ссылка S3.
   * Это осознанный размен: сверять каждую отдачу байтов с состоянием ссылки значит
   * добавить запрос к базе на каждый кусок видео. Владельцу это стоит знать: отзыв
   * закрывает доступ, но не отменяет уже начатое скачивание.
   */
  async revoke(userId: string, id: string): Promise<ShareLinkDto> {
    const link = await this.loadOrThrow(id);
    const ctx = await this.authorize(userId, link.refType, link.refId);
    if (link.revokedAt) return this.serialize(link);

    const updated = await this.db.shareLink.update({
      where: { id: link.id },
      data: { revokedAt: new Date(), revokedById: userId },
    });
    await this.logChatter(userId, updated, ctx, 'share.link_revoked');
    return this.serialize(updated);
  }

  async listVisits(
    userId: string,
    id: string,
    q: { cursor?: string; limit?: number },
  ): Promise<ShareLinkVisitsPage> {
    const link = await this.loadOrThrow(id);
    await this.authorize(userId, link.refType, link.refId);

    const take = Math.min(q.limit ?? SHARE_LINK_LIMITS.visitsPageSize, SHARE_LINK_LIMITS.maxVisitsPageSize);
    const cursor = this.parseCursor(q.cursor);
    const rows = await this.db.shareLinkVisit.findMany({
      where: { linkId: link.id, ...(cursor !== null ? { id: { lt: cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return {
      items: page.map((v) => ({
        id: v.id.toString(),
        openedAt: v.openedAt.toISOString(),
        ip: v.ip,
        userAgent: v.userAgent,
      })),
      nextCursor: hasMore && page.length ? page[page.length - 1].id.toString() : null,
    };
  }

  // ============================================================
  // Сервисный API потребителям
  // ============================================================

  /**
   * Системный отзыв: объект умер насовсем (Диск — окончательное удаление, документ —
   * архивация). Права не проверяются — по контракту их проверил вызывающий, который
   * и решил судьбу объекта; `revokedById` остаётся null, и это видно в интерфейсе как
   * «отозвана системой».
   *
   * Ссылки на объект в КОРЗИНЕ отзывать нельзя: оттуда он возвращается, и восстановление
   * не должно молча оставлять мёртвые ссылки. Пока объект в корзине, гостю отвечает
   * резолвер потребителя (null → 410).
   */
  async revokeAllForRefs(
    tx: Prisma.TransactionClient | null,
    refType: string,
    refIds: string[],
  ): Promise<number> {
    if (!refIds.length) return 0;
    const client = tx ?? this.db;
    const { count } = await client.shareLink.updateMany({
      where: { refType, refId: { in: refIds }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count > 0) {
      this.logger.log(`системный отзыв гостевых ссылок: ${refType} × ${refIds.length} → ${count}`);
    }
    return count;
  }

  /** Сколько действующих ссылок у объекта — для значка «доступно по ссылке» в интерфейсе */
  async countActiveForRefs(refType: string, refIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!refIds.length) return out;
    const rows = await this.db.shareLink.groupBy({
      by: ['refId'],
      where: { refType, refId: { in: refIds }, revokedAt: null },
      _count: { _all: true },
    });
    for (const r of rows) out.set(r.refId, r._count._all);
    return out;
  }

  // ============================================================
  // Внутреннее
  // ============================================================

  private async authorize(userId: string, refType: string, refId: string): Promise<ShareRefContext> {
    const provider = this.registry.get(refType);
    if (!provider) {
      throw new BadRequestException('Для этого типа объектов гостевые ссылки не поддерживаются');
    }
    const ctx = await provider.authorizeManage(userId, refId);
    // Единый ответ и на «нет объекта», и на «нет прав»: существование чужого объекта
    // подтверждать нельзя — иначе перебором id виден чужой Диск.
    if (!ctx) throw new NotFoundException('Объект не найден');
    return ctx;
  }

  private async loadOrThrow(id: string): Promise<ShareLink> {
    const link = await this.db.shareLink.findUnique({ where: { id } });
    if (!link) throw new NotFoundException('Ссылка не найдена');
    return link;
  }

  private parseCursor(cursor?: string): bigint | null {
    if (!cursor) return null;
    try {
      return BigInt(cursor);
    } catch {
      throw new BadRequestException('Неверный курсор');
    }
  }

  /**
   * Хроника объекта: раздача доступа ВНЕ платформы не должна происходить тихо.
   * Best-effort — журнал не имеет права уронить уже совершённое действие.
   */
  private async logChatter(
    userId: string,
    link: ShareLink,
    ctx: ShareRefContext,
    typeKey: 'share.link_created' | 'share.link_revoked',
  ): Promise<void> {
    const user = await this.db.user
      .findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } })
      .catch(() => null);
    await this.chatter
      .log(null, {
        refType: link.refType,
        refId: link.refId,
        workspaceId: ctx.workspaceId,
        actorId: userId,
        actorName: user ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}` : null,
        typeKey,
        payload: {
          targetName: ctx.title,
          // Суффикс собирается здесь, а не в шаблоне: шаблонизатор реестра не умеет
          // условий, и «ссылка ()» с пустыми скобками была бы видна человеку.
          labelSuffix: link.label ? ` («${link.label}»)` : '',
          shareLinkId: link.id,
        },
      })
      .catch(() => undefined);
  }

  private serialize(row: ShareLink): ShareLinkDto {
    const webUrl = process.env.WEB_URL || 'http://localhost:3000';
    return {
      id: row.id,
      refType: row.refType,
      refId: row.refId,
      url: buildShareLinkUrl(webUrl, row.token),
      label: row.label,
      status: shareLinkStatus(row),
      hasPassword: !!row.passwordHash,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      maxOpens: row.maxOpens,
      openCount: row.openCount,
      lastOpenedAt: row.lastOpenedAt ? row.lastOpenedAt.toISOString() : null,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      revokedById: row.revokedById,
    };
  }
}
