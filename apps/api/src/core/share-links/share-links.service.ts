import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type ShareLink } from '@prisma/client';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import {
  APP_TIMEZONE,
  SHARE_LINK_LIMITS,
  buildShareLinkUrl,
  shareLinkStatus,
  type CreateShareLinkInput,
  type MineShareLinksQuery,
  type ShareLinkActorLite,
  type ShareLinkDto,
  type ShareLinkMinePage,
  type ShareLinkOrgPage,
  type ShareLinkStatsDto,
  type ShareLinksPage,
  type ShareLinkVisitsPage,
  type UpdateShareLinkInput,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { utcTs } from '../../shared/database/sql-time';
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
    this.assertConstraints(dto.refType, dto.maxOpens ?? null);

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
          // Снимок объекта на момент выдачи — на нём стоит раздел «Ссылки наружу»
          // (без него список звал бы резолвер на каждую строку и врал бы про удалённые).
          refTitle: ctx.title,
          refIcon: ctx.icon ?? null,
          expiresAt: dto.expiresAt ?? null,
          maxOpens: dto.maxOpens ?? null,
          ...(dto.allowDownload !== undefined ? { allowDownload: dto.allowDownload } : {}),
          ...(dto.notifyOnOpen !== undefined ? { notifyOnOpen: dto.notifyOnOpen } : {}),
          // Тип объекта может ТРЕБОВАТЬ личность независимо от того, что прислал
          // клиент (подпись), — иначе документ на подпись читал бы любой, кому
          // переслали адрес.
          ...(this.forcedIdentity(dto.refType)
            ? { requireIdentity: true }
            : dto.requireIdentity !== undefined
              ? { requireIdentity: dto.requireIdentity }
              : {}),
          passwordHash,
        },
      });
    });

    await this.logChatter(userId, link, 'share.link_created');
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
   * Ограничения самой ссылки, объявленные потребителем.
   *
   * Единственное живое — запрет лимита открытий на подписных ссылках: он запирал
   * бы подписанта снаружи ровно в тот момент, когда он вернулся с ключом ЭЦП.
   */
  private assertConstraints(refType: string, maxOpens: number | null): void {
    if (maxOpens === null) return;
    if (this.registry.get(refType)?.constraints?.forbidMaxOpens) {
      throw new BadRequestException(
        'Для такой ссылки нельзя задать лимит открытий: получатель должен иметь возможность вернуться к документу',
      );
    }
  }

  /**
   * Подтверждение личности, продиктованное типом объекта, а не выбором создателя.
   *
   * Тип, который объявил `requireIdentity`, обязан получать его ВСЕГДА: у подписи
   * анонимная ссылка означала бы, что документ, ушедший на подпись контрагенту,
   * читает любой, кому переслали адрес, — а сам движок подписи считает, что личность
   * уже подтверждена. Выключить настройку такому типу тоже нельзя.
   */
  private forcedIdentity(refType: string): boolean {
    return this.registry.get(refType)?.constraints?.requireIdentity === true;
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
    if (dto.maxOpens !== undefined) {
      this.assertConstraints(link.refType, dto.maxOpens);
      data.maxOpens = dto.maxOpens;
    }
    if (dto.allowDownload !== undefined) data.allowDownload = dto.allowDownload;
    if (dto.notifyOnOpen !== undefined) data.notifyOnOpen = dto.notifyOnOpen;
    if (dto.requireIdentity !== undefined) {
      // Снять подтверждение личности там, где его требует сам тип объекта, нельзя:
      // правка не должна уметь того, чего не умеет создание.
      if (!dto.requireIdentity && this.forcedIdentity(link.refType)) {
        throw new BadRequestException(
          'Для такой ссылки подтверждение номера обязательно: по ней подписывают документ',
        );
      }
      data.requireIdentity = dto.requireIdentity;
      // ВКЛЮЧЕНИЕ подтверждения номера гасит уже открытые АНОНИМНЫЕ сессии бампом
      // поколения пропусков — иначе тот, кто открыл ссылку минуту назад, досматривал
      // бы содержимое ещё час, и настройка не делала бы того, что обещает.
      // Выключение поколение не трогает: подтверждённая сессия строго сильнее.
      if (dto.requireIdentity && !link.requireIdentity) {
        data.sessionEpoch = { increment: 1 };
      }
    }
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

  // ============================================================
  // «Мои ссылки»: всё, что человек раздал наружу, из всех сервисов сразу
  // ============================================================

  /**
   * Свои ссылки одним списком. Право — АВТОРСТВО: раздавал человек, отвечать ему.
   * Резолвер потребителя здесь не спрашивается на каждую строку (это N проверок прав на
   * страницу), но подпись объекта берётся у него же — батчем через `describeRef`.
   *
   * Объект мог исчезнуть — строку всё равно показываем: это история раздачи, и отозвать
   * такую ссылку человек тоже должен уметь.
   */
  async listMine(userId: string, q: MineShareLinksQuery): Promise<ShareLinkMinePage> {
    return this.pageLinks({ createdById: userId }, q);
  }

  /**
   * Страница ссылок по произвольному скоупу — общая для «Моих ссылок» и «Ссылок
   * организации». Скоуп задаёт вызывающий, права он же и проверил.
   */
  private async pageLinks(
    scope: Prisma.ShareLinkWhereInput,
    q: MineShareLinksQuery,
  ): Promise<ShareLinkMinePage> {
    const take = Math.min(q.limit ?? SHARE_LINK_LIMITS.minePageSize, SHARE_LINK_LIMITS.minePageSize);
    // Курсор СОСТАВНОЙ — время плюс id. По одному времени страница теряла бы строки:
    // ссылки, созданные в одну миллисекунду (а пачку выдают именно так), отсекались бы
    // условием «строго раньше» целиком.
    const cursor = this.parseMineCursor(q.cursor);

    // «Действующая» — состояние ВЫЧИСЛЯЕМОЕ (не отозвана, не истекла), колонки статуса
    // нет, поэтому в SQL оно выражается условиями. Исчерпанный лимит сюда не входит:
    // сравнение open_count с max_opens Prisma не выражает, а держать ради фильтра
    // сырой запрос дороже, чем показать такую ссылку среди действующих со своим чипом.
    const now = new Date();
    const liveWhere: Prisma.ShareLinkWhereInput = {
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    };
    const where: Prisma.ShareLinkWhereInput = {
      ...scope,
      ...(q.status === 'active' ? liveWhere : {}),
      ...(q.status === 'inactive' ? { NOT: liveWhere } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };

    const rows = await this.db.shareLink.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;

    // Резолвер зовём ТОЛЬКО для строк без снимка (созданных до его появления).
    const refs = await this.describeRefs(page.filter((r) => !r.refTitle));
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        ...this.serialize(r),
        ref: r.refTitle
          ? { title: r.refTitle, ...(r.refIcon ? { icon: r.refIcon } : {}) }
          : (refs.get(`${r.refType}:${r.refId}`) ?? null),
      })),
      nextCursor: hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
    };
  }

  /** Составной курсор «время|id» — по одному времени страница теряла бы строки-близнецы */
  private parseMineCursor(cursor?: string): { createdAt: Date; id: string } | null {
    if (!cursor) return null;
    const [iso, id] = cursor.split('|');
    const createdAt = new Date(iso);
    if (!id || Number.isNaN(createdAt.getTime())) throw new BadRequestException('Неверный курсор');
    return { createdAt, id };
  }

  /**
   * Сводка над списком. Открытия считаются по ЖУРНАЛУ ВИЗИТОВ, а не по `openCount`:
   * тот показывает «всего за жизнь ссылки», а человеку нужно «что происходит сейчас».
   */
  async statsMine(userId: string): Promise<ShareLinkStatsDto> {
    return this.statsFor({ createdById: userId }, Prisma.sql`l.created_by_id = ${userId}`);
  }

  /**
   * Сводка по скоупу. Скоуп приходит ДВАЖДЫ — условием Prisma для «действующих» и
   * фрагментом SQL для гистограммы визитов: гистограмма считается на стороне БД
   * (тянуть визиты в приложение у активного скоупа значит читать таблицу целиком),
   * а сырой SQL и Prisma-фильтры не выражаются друг через друга.
   */
  private async statsFor(
    scope: Prisma.ShareLinkWhereInput,
    visitScope: Prisma.Sql,
  ): Promise<ShareLinkStatsDto> {
    const days = SHARE_LINK_LIMITS.statsDays;
    const now = new Date();
    // Сутки — МЕСТНЫЕ (APP_TIMEZONE), а не UTC. Иначе у человека в Алматы открытия с
    // полуночи до пяти утра падали бы во «вчера», и сегодняшний столбик выглядел бы
    // пустым до рассвета. Ту же дату считает и SQL ниже, поэтому ключи сходятся.
    const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: APP_TIMEZONE });
    const from = new Date(Date.now() - (days - 1) * 86_400_000);

    const [live, opens] = await Promise.all([
      this.db.shareLink.findMany({
        where: {
          ...scope,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { refType: true, refId: true },
      }),
      // Группировка по дню — на стороне БД: тянуть все визиты в приложение ради
      // гистограммы значило бы читать таблицу целиком у активного пользователя.
      // Группировка по МЕСТНОМУ дню на стороне БД: `opened_at` — наивный UTC, поэтому
      // сначала объявляем его поясом, потом переводим в APP_TIMEZONE и только затем
      // режем по суткам. Тянуть визиты в приложение ради гистограммы нельзя — у
      // активного человека это чтение всей таблицы.
      this.db.$queryRaw<{ day: string; opens: bigint }[]>`
        SELECT to_char(
                 date_trunc('day', (v.opened_at AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE}),
                 'YYYY-MM-DD'
               ) AS day,
               COUNT(*)::bigint AS opens
          FROM share_link_visits v
          JOIN share_links l ON l.id = v.link_id
         WHERE ${visitScope}
           AND v.opened_at >= ${utcTs(from)}
         GROUP BY 1
         ORDER BY 1
      `,
    ]);

    const byDay = new Map(opens.map((r) => [r.day, Number(r.opens)]));
    const daily: { date: string; opens: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = dayKey(new Date(Date.now() - i * 86_400_000));
      daily.push({ date, opens: byDay.get(date) ?? 0 });
    }

    return {
      activeLinks: live.length,
      sharedObjects: new Set(live.map((a) => `${a.refType}:${a.refId}`)).size,
      opensInPeriod: daily.reduce((s, d) => s + d.opens, 0),
      periodDays: days,
      daily,
    };
  }

  /**
   * Массовый отзыв СВОИХ ссылок. Право — авторство, а не текущие права на объект:
   * человек, потерявший доступ к папке (сняли грант, уволился), обязан уметь закрыть
   * то, что раздал сам. Отзыв только сужает доступ и потому безопасен по определению.
   */
  async revokeMine(userId: string, ids: string[]): Promise<number> {
    // Сначала забираем то, что реально отзовём: после updateMany эти строки уже не
    // отличить от отозванных раньше, а они нужны для хроники.
    const targets = await this.db.shareLink.findMany({
      where: { id: { in: ids }, createdById: userId, revokedAt: null },
    });
    if (!targets.length) return 0;

    const { count } = await this.db.shareLink.updateMany({
      where: { id: { in: targets.map((t) => t.id) }, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: userId },
    });

    // Массовый отзыв пишется в хронику ровно как одиночный: закрытие доступа наружу
    // не должно происходить тише, чем его открытие.
    for (const link of targets) await this.logChatter(userId, link, 'share.link_revoked');
    return count;
  }

  /** Подписи объектов батчем — по одному `describeRef` на УНИКАЛЬНЫЙ объект страницы */
  private async describeRefs(rows: ShareLink[]): Promise<Map<string, { title: string; icon?: string }>> {
    const out = new Map<string, { title: string; icon?: string }>();
    const unique = new Map<string, { refType: string; refId: string }>();
    for (const r of rows) unique.set(`${r.refType}:${r.refId}`, { refType: r.refType, refId: r.refId });

    await Promise.all(
      [...unique].map(async ([key, ref]) => {
        const provider = this.registry.get(ref.refType);
        if (!provider?.describeRef) return;
        // Резолвер ходит в свою базу и может упасть на удалённом объекте — это не повод
        // ронять весь список: строка просто останется без подписи.
        const described = await provider.describeRef(ref.refId).catch(() => null);
        if (described) out.set(key, described);
      }),
    );
    return out;
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
    await this.logChatter(userId, updated, 'share.link_revoked');
    return this.serialize(updated);
  }

  /**
   * Сменить АДРЕС ссылки, не создавая новую.
   *
   * Зачем отдельная операция, если есть «отозвать и создать»: та теряет журнал визитов
   * и настройки, а они и есть ценность долгоживущей ссылки — по ним потом разбираются,
   * кому и когда объект уходил. Здесь остаётся всё, кроме адреса.
   *
   * Бамп `sessionEpoch` обязателен: гостевой пропуск подписан по linkId, и без него тот,
   * у кого утёк СТАРЫЙ адрес, продолжил бы смотреть содержимое ещё час — то есть смена
   * адреса не сделала бы ровно того, ради чего её делают.
   */
  async rotateToken(userId: string, id: string): Promise<ShareLinkDto> {
    const link = await this.loadOrThrow(id);
    await this.authorize(userId, link.refType, link.refId);
    if (link.revokedAt) throw new BadRequestException('Ссылка отозвана — создайте новую');

    const updated = await this.db.shareLink.update({
      where: { id: link.id },
      data: {
        token: randomBytes(SHARE_LINK_LIMITS.tokenBytes).toString('base64url'),
        sessionEpoch: { increment: 1 },
        tokenRotatedAt: new Date(),
        // Блокировку подбора снимаем: она относилась к старому адресу, а новый получат
        // другие люди — незачем встречать их чужой блокировкой.
        pwdFailedAttempts: 0,
        pwdLockedUntil: null,
      },
    });
    // Смена адреса пишется в хронику наравне с выдачей и отзывом: у части получателей
    // доступ в этот момент пропадает, и молча такое происходить не должно.
    await this.logChatter(userId, updated, 'share.link_rotated');
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
      // Кто открывал (ссылка требовала подтверждение номера). Владелец видит номер
      // ПОЛНОСТЬЮ: он сам отправлял ссылку этому человеку, маскировать не от кого.
      include: { guest: { select: { name: true, phone: true } } },
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return {
      items: page.map((v) => ({
        id: v.id.toString(),
        openedAt: v.openedAt.toISOString(),
        ip: v.ip,
        userAgent: v.userAgent,
        guestName: v.guest?.name ?? null,
        guestPhone: v.guest?.phone ?? null,
      })),
      nextCursor: hasMore && page.length ? page[page.length - 1].id.toString() : null,
    };
  }

  // ============================================================
  // «Ссылки организации» — системный API: право проверил ВЫЗЫВАЮЩИЙ
  // ============================================================
  // Гейт (роль ≥ Менеджер) живёт в модуле workspaces: понятие «роль в организации»
  // принадлежит ему, а движок ссылок ролей не знает — иначе core начал бы зависеть
  // от функционального модуля. Прецедент — «Журнал организации» на core/chatter.

  /**
   * Всё, что раздала наружу ВСЯ команда организации. Скоуп — денормализованный
   * `workspaceId` на строке ссылки (его кладёт резолвер потребителя из своего
   * контекста), а не «владелец объекта»: организация — это ещё и контекст, в котором
   * личный объект бывает роздан по работе, и такие ссылки обязаны быть видны команде.
   */
  async listForWorkspace(workspaceId: string, q: MineShareLinksQuery): Promise<ShareLinkOrgPage> {
    const page = await this.pageLinks({ workspaceId }, q);
    // «Кто это раздал» — главный вопрос организационного списка, и ответ на него
    // обязан быть карточкой человека (принцип 2), а не идентификатором.
    const ids = [...new Set(page.items.map((i) => i.createdById))];
    const users = ids.length
      ? await this.db.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, firstName: true, lastName: true, avatar: true },
        })
      : [];
    const actors: Record<string, ShareLinkActorLite> = {};
    for (const u of users) actors[u.id] = u;
    return { ...page, actors };
  }

  /**
   * Массовый отзыв ссылок ОРГАНИЗАЦИИ — в том числе чужих.
   *
   * Ради этого раздел и заводится: менеджер раздал наружу три десятка ссылок и
   * уволился, а закрыть их было некому — «Мои ссылки» показывают только свои, а
   * пообъектный обход требует помнить все объекты. Отзыв лишь СУЖАЕТ доступ, поэтому
   * право на него совпадает с правом видеть список; каждая строка пишется в хронику
   * своего объекта — массовое закрытие не должно происходить тише открытия.
   */
  async revokeForWorkspace(actorId: string, workspaceId: string, ids: string[]): Promise<number> {
    // Скоуп в WHERE, а не проверка после выборки: чужой id из тела запроса не должен
    // отзывать ссылку соседней организации даже теоретически.
    const targets = await this.db.shareLink.findMany({
      where: { id: { in: ids }, workspaceId, revokedAt: null },
    });
    if (!targets.length) return 0;

    const { count } = await this.db.shareLink.updateMany({
      where: { id: { in: targets.map((t) => t.id) }, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: actorId },
    });
    for (const link of targets) await this.logChatter(actorId, link, 'share.link_revoked');
    return count;
  }

  /** Сводка организации — та же форма, что личная (`statsMine`), другой скоуп */
  async statsForWorkspace(workspaceId: string): Promise<ShareLinkStatsDto> {
    return this.statsFor({ workspaceId }, Prisma.sql`l.workspace_id = ${workspaceId}`);
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
    typeKey: 'share.link_created' | 'share.link_revoked' | 'share.link_rotated',
  ): Promise<void> {
    const user = await this.db.user
      .findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } })
      .catch(() => null);
    await this.chatter
      .log(null, {
        refType: link.refType,
        refId: link.refId,
        // Всё берётся из САМОЙ строки ссылки: она несёт и организацию, и снимок имени,
        // поэтому запись в хронику не требует похода к резолверу потребителя — а значит
        // работает и там, где резолвер звать не за что (массовый отзыв, смена адреса).
        workspaceId: link.workspaceId,
        actorId: userId,
        actorName: user ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}` : null,
        typeKey,
        payload: {
          targetName: link.refTitle ?? 'объект',
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
      allowDownload: row.allowDownload,
      notifyOnOpen: row.notifyOnOpen,
      requireIdentity: row.requireIdentity,
      tokenRotatedAt: row.tokenRotatedAt ? row.tokenRotatedAt.toISOString() : null,
      createdById: row.createdById,
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      revokedById: row.revokedById,
    };
  }
}
