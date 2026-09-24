import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type ShareLink, type ShareLinkGuest } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  APP_TIMEZONE,
  SHARE_LINK_ERROR_CODES,
  SOURCE_LOCALE,
  SHARE_LINK_LIMITS,
  maskPhone,
  type ShareGuestIdentityStartDto,
  type ShareGuestPeekDto,
  type ShareGuestSessionDto,
  type ShareLinkErrorCode,
} from '@superapp/shared';
import { NotificationsService } from '../notifications/notifications.service';
import { formatDayKey } from '@superapp/i18n';
import { DatabaseService } from '../../shared/database/database.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ApiError } from '../../shared/errors/api-error';
import { I18nService } from '../../shared/i18n/i18n.service';
import { utcTs } from '../../shared/database/sql-time';
import { VerifyService } from '../verify/verify.service';
import { ShareLinksRegistry } from './share-links.registry';
import { ShareLinksTokenService } from './share-links-token.service';
import { AuditService } from '../audit/audit.service';

/** Контекст запроса гостя — всё, что мы о нём знаем (и всё, что пишем в журнал) */
export interface GuestRequestInfo {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Результат проверки пропуска: ссылка + личность гостя (если ссылка её требовала).
 * Именно этим объектом живут гостевые контроллеры потребителей — будущие действия
 * (подпись, оплата, ответ на опрос) берут «кто по ту сторону» отсюда, а не заводят
 * собственные таблицы личностей.
 */
export interface GuestAccess {
  link: ShareLink;
  guest: ShareLinkGuest | null;
}

/**
 * Отказ в едином конверте платформы: машиночитаемый код в `details.code`, чтобы клиент
 * ветвился по нему, а не по русскому тексту. Функция модуля, а не метод класса, — так
 * компилятор видит `never` и сам сужает типы после вызова.
 */
/**
 * Отказ гостю: `key` — ключ каталога (слово подберёт фильтр в языке запроса), а
 * `code` остаётся машинным — гостевая страница ветвится по нему, а не по фразе.
 */
function deny(
  code: ShareLinkErrorCode,
  key: string,
  status: HttpStatus,
  extra?: Record<string, unknown>,
): never {
  throw new ApiError(status, { code: key, details: { code, ...extra } });
}

/**
 * Гостевая половина движка: открытие ссылки человеком БЕЗ аккаунта.
 *
 * Поток из двух шагов, и это не формальность:
 *  1. peek  — только состояние ссылки. Резолвер потребителя НЕ зовётся, счётчик НЕ
 *     двигается: запароленная ссылка не должна раскрывать даже название объекта.
 *  2. session — пароль проверен, открытие ЗАСЧИТАНО атомарно, выдан пропуск и
 *     содержимое. Пропуск живёт час, поэтому обновление страницы и хождение по
 *     папкам не накручивают счётчик: одно «открытие» = один человек, а не один клик.
 *
 * Ни одна ручка здесь НИКОГДА не отвечает 401 — только 403/404/410. У гостя нет и не
 * может быть токена платформы, а веб-клиент на 401 жёстко уводит на страницу входа:
 * «срок ссылки истёк» превратилось бы в «вас разлогинило».
 */
@Injectable()
export class ShareLinksGuestService {
  constructor(
    private readonly db: DatabaseService,
    private readonly registry: ShareLinksRegistry,
    private readonly tokens: ShareLinksTokenService,
    private readonly notifications: NotificationsService,
    private readonly verify: VerifyService,
    private readonly i18n: I18nService,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
  ) {}

  /** Шаг 1: жива ли ссылка, нужен ли пароль и предстоит ли подтверждение номера */
  async peek(token: string): Promise<ShareGuestPeekDto> {
    const link = await this.loadByToken(token);
    await this.assertUsable(link);
    return {
      state: link.passwordHash ? 'password_required' : 'ready',
      identityRequired: link.requireIdentity,
    };
  }

  /**
   * Запрос SMS-кода гостем (ссылка с «подтвердите номер»).
   *
   * Гейт по ССЫЛКЕ — то, что отличает этот путь от публичного /verify/start (тот эту
   * цель отвергает): SMS уходит только по живой ссылке с включённым тумблером, и пароль
   * (если есть) проверяется ДО отправки — со всеми счётчиками подбора. Иначе адрес
   * запароленной ссылки работал бы кнопкой SMS-расходов, а неверный пароль выяснялся
   * бы после сожжённого кода (правило step-up движка verify).
   *
   * Дальше гость проверяет код обычным публичным /verify/check — challengeId знает
   * только тот, кто цепочку начинал.
   */
  async startIdentity(
    token: string,
    dto: { phone: string; password?: string },
    ip?: string | null,
  ): Promise<ShareGuestIdentityStartDto> {
    const link = await this.loadByToken(token);
    await this.assertUsable(link);
    if (!link.requireIdentity) {
      // Ссылка кода не просит — эта ручка для неё не существует (не даём превращать
      // произвольную ссылку в источник SMS-трафика).
      deny(SHARE_LINK_ERROR_CODES.sessionInvalid, 'shareLink.noIdentityNeeded', HttpStatus.FORBIDDEN);
    }
    if (link.passwordHash) await this.verifyPassword(link, dto.password);

    const started = await this.verify.startGuest(dto.phone, ip ?? undefined);
    return {
      challengeId: started.challengeId,
      resendInSec: started.resendInSec,
      ttlSec: started.ttlSec,
      phoneMasked: started.phoneMasked,
    };
  }

  /** Шаг 2: открыть ссылку — засчитать открытие, записать визит, выдать пропуск и содержимое */
  async openSession(
    token: string,
    dto: { password?: string; verifyToken?: string; guestName?: string },
    info: GuestRequestInfo,
  ): Promise<ShareGuestSessionDto> {
    const link = await this.loadByToken(token);
    await this.assertUsable(link);

    // Пароль проверяется ДО клейма: неверная попытка не имеет права тратить открытие,
    // иначе ссылку с лимитом можно было бы «сжечь» чужому получателю чужими руками.
    if (link.passwordHash) await this.verifyPassword(link, dto.password);

    if (link.requireIdentity && (!dto.verifyToken || !dto.guestName)) {
      deny(
        SHARE_LINK_ERROR_CODES.identityRequired,
        'shareLink.identityRequired',
        HttpStatus.FORBIDDEN,
      );
    }

    // Содержимое резолвим ДО клейма: резолвер только читает, а открытие — расходуемый
    // ресурс. В обратном порядке объект, уехавший в корзину, сжигал бы открытие
    // НАВСЕГДА: гость видел «объект недоступен», владелец возвращал объект из корзины —
    // а ссылка уже «лимит исчерпан», хотя человеку так ничего и не показали.
    // Личность здесь ещё НЕ подтверждена (пропуск гасится в транзакции ниже) —
    // персональный срез вида доресолвится после клейма вторым заходом.
    const view = await this.resolveView(link);

    // Личность и клейм — ОДНОЙ транзакцией: пропуск verify одноразов, и если открытие
    // не состоялось (гонка за последний слот), он обязан остаться непотраченным —
    // человек попробует снова и не должен идти за новым SMS-кодом.
    const { open, guest } = await this.db.$transaction(async (tx) => {
      let g: ShareLinkGuest | null = null;
      if (link.requireIdentity) {
        const consumed = await this.verify.consume(tx, {
          verifyToken: dto.verifyToken as string,
          purpose: 'share_link_guest',
        });
        g = await tx.shareLinkGuest.upsert({
          where: {
            ownerType_ownerId_phone: {
              ownerType: link.ownerType,
              ownerId: link.ownerId,
              phone: consumed.phone,
            },
          },
          create: {
            ownerType: link.ownerType,
            ownerId: link.ownerId,
            phone: consumed.phone,
            name: dto.guestName as string,
          },
          // Последнее имя побеждает: человек мог опечататься в прошлый раз.
          update: { name: dto.guestName as string, lastVerifiedAt: new Date() },
        });
      }
      // Новый подтверждённый гость ЭТОЙ ссылки — факт журнала безопасности (кто из внешних
      // видел данные); повторные открытия — только журнал визитов ссылки
      const firstVisit = g ? (await tx.shareLinkVisit.count({ where: { linkId: link.id, guestId: g.id } })) === 0 : false;
      const claimed = await this.claimOpen(tx, link, info, g?.id ?? null);
      if (g && firstVisit) {
        await this.audit.record(tx, {
          key: 'sharing.link.guest_verified',
          actor: { kind: 'guest', id: g.id },
          subjectUserId: link.createdById,
          workspaceId: link.workspaceId,
          target: { type: link.refType, id: link.refId, label: link.refTitle },
          ref: { type: 'share_link', id: link.id },
          details: { resource: link.refType, guestId: g.id },
        });
      }
      return { open: claimed, guest: g };
    });

    // Гостевой факт — без личности (гость не принципал); контекст — организация-владелец ссылки
    await this.analytics.track(
      null,
      'share.link.opened',
      { refType: link.refType },
      { userId: null, workspaceId: link.ownerType === 'workspace' ? link.ownerId : null },
    );
    await this.notifyOwnerOfOpen(link, open, guest);
    const session = await this.tokens.issue(link.id, link.sessionEpoch, guest?.id ?? null);
    // Ссылка с личностью: вид перечитывается УЖЕ с гостем — потребитель кладёт в
    // него персональный срез (моя подпись/мой отказ). Второй заход резолвера на
    // одно открытие в час — приемлемая цена; ошибка не роняет уже засчитанное
    // открытие: остаётся анонимный вид.
    const personalView = guest
      ? await this.resolveView(link, { id: guest.id, name: guest.name, phone: guest.phone }).catch(() => view)
      : view;
    return {
      sessionToken: session.token,
      sessionExpiresAt: session.expiresAt.toISOString(),
      linkExpiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
      refType: link.refType,
      guest: guest ? { name: guest.name, phoneMasked: maskPhone(guest.phone) ?? '' } : null,
      view: personalView,
    };
  }

  /**
   * Проверка пропуска на КАЖДОМ последующем запросе — своём (`/view`) и чужом
   * (гостевые контроллеры потребителей). Строка ссылки перечитывается из БД, поэтому
   * отзыв действует немедленно: пропуск сам по себе не разрешает ничего.
   *
   * Возвращает и ЛИЧНОСТЬ гостя (если ссылка её требовала): потребителям — подписи,
   * оплате, опросам — не нужно ни своих таблиц гостей, ни разбора пропуска.
   *
   * maxOpens здесь намеренно НЕ проверяется: он ограничивает число ОТКРЫТИЙ, а не
   * длительность уже начатого просмотра — иначе человек, открывший последнюю копию,
   * терял бы страницу на первом же клике.
   */
  async authorizeGuest(sessionToken: string | undefined | null, expectedRefType?: string): Promise<GuestAccess> {
    const verdict = await this.tokens.verify(sessionToken);
    if (!verdict.ok || !verdict.payload) {
      deny(
        SHARE_LINK_ERROR_CODES.sessionInvalid,
        'shareLink.sessionExpired',
        HttpStatus.FORBIDDEN,
      );
    }
    const link = await this.db.shareLink.findUnique({ where: { id: verdict.payload.l } });
    if (!link) deny(SHARE_LINK_ERROR_CODES.notFound, 'shareLink.notFound', HttpStatus.NOT_FOUND);
    await this.assertLive(link);
    this.assertEpoch(link, verdict.payload);
    if (expectedRefType && link.refType !== expectedRefType) {
      deny(SHARE_LINK_ERROR_CODES.sessionInvalid, 'shareLink.sessionMismatchSection', HttpStatus.FORBIDDEN);
    }
    // Пропуск старше включения тумблера личности не бывает: включение бампает
    // sessionEpoch, поэтому «ссылка требует личность, а в пропуске её нет» —
    // это подделка, а не легальная старая сессия.
    if (link.requireIdentity && !verdict.payload.g) {
      deny(SHARE_LINK_ERROR_CODES.identityRequired, 'shareLink.identityRequired', HttpStatus.FORBIDDEN);
    }
    const guest = verdict.payload.g
      ? await this.db.shareLinkGuest.findUnique({ where: { id: verdict.payload.g } })
      : null;
    return { link, guest };
  }

  /**
   * Свежее содержимое по действующему пропуску — без счётчика. Этим живут обновление
   * страницы и добор протухших ссылок на файлы (они подписаны на ~10 минут).
   */
  /**
   * Вправе ли гость ДЕЙСТВОВАТЬ по этой ссылке прямо сейчас: пропуск настоящий и
   * выдан именно этой ссылке, ссылка жива и не отозвана, эпоха сессий не сдвинута,
   * личность на месте (если ссылка её требует).
   *
   * Отдельным методом, потому что проверку зовут ДВОЕ: само действие и шлюз повтора
   * движка идемпотентности. Повтор отдаёт сохранённый ответ, НЕ вызывая обработчик,
   * и без этой проверки отозванная ссылка ещё трое суток отвечала бы как живая.
   */
  async authorizeAction(
    token: string,
    sessionToken: string | undefined | null,
  ): Promise<{ link: ShareLink; guestId: string | null }> {
    const verdict = await this.tokens.verify(sessionToken);
    if (!verdict.ok || !verdict.payload) {
      deny(SHARE_LINK_ERROR_CODES.sessionInvalid, 'shareLink.sessionExpired', HttpStatus.FORBIDDEN);
    }
    const link = await this.loadByToken(token);
    if (verdict.payload.l !== link.id) {
      deny(SHARE_LINK_ERROR_CODES.sessionInvalid, 'shareLink.sessionMismatch', HttpStatus.FORBIDDEN);
    }
    await this.assertLive(link);
    this.assertEpoch(link, verdict.payload);
    if (link.requireIdentity && !verdict.payload.g) {
      deny(SHARE_LINK_ERROR_CODES.identityRequired, 'shareLink.identityRequired', HttpStatus.FORBIDDEN);
    }
    return { link, guestId: verdict.payload.g ?? null };
  }

  /**
   * Выполнить ДЕЙСТВИЕ потребителя от имени гостя.
   *
   * Движок здесь проходная: подтверждает живую ссылку и пропуск, достаёт личность
   * (если ссылка её требовала) и передаёт управление обработчику из реестра. Что
   * делает действие и кому оно позволено — знает только потребитель; движок про
   * подписи, оплаты и опросы не знает и знать не должен.
   */
  async runAction(
    token: string,
    key: string,
    sessionToken: string | undefined | null,
    body: unknown,
    info: GuestRequestInfo,
  ): Promise<unknown> {
    const { link, guestId } = await this.authorizeAction(token, sessionToken);

    const provider = this.registry.get(link.refType);
    const handler = provider?.actions?.[key];
    // Неизвестное действие — 404, а не 403: существование чужих возможностей
    // постороннему не подтверждаем (тот же приём, что у скоупа гостевых папок).
    if (!handler) deny(SHARE_LINK_ERROR_CODES.notFound, 'shareLink.actionUnavailable', HttpStatus.NOT_FOUND);

    const guest = guestId ? await this.db.shareLinkGuest.findUnique({ where: { id: guestId } }) : null;

    return handler({
      refType: link.refType,
      refId: link.refId,
      link: {
        id: link.id,
        allowDownload: link.allowDownload,
        settings: (link.settings as Record<string, unknown>) ?? {},
      },
      guest: guest ? { id: guest.id, name: guest.name, phone: guest.phone } : null,
      body,
      ip: info.ip ?? null,
      userAgent: info.userAgent ?? null,
    });
  }

  async refreshView(token: string, sessionToken: string | undefined | null): Promise<ShareGuestSessionDto> {
    const verdict = await this.tokens.verify(sessionToken);
    if (!verdict.ok || !verdict.payload) {
      deny(
        SHARE_LINK_ERROR_CODES.sessionInvalid,
        'shareLink.sessionExpired',
        HttpStatus.FORBIDDEN,
      );
    }
    const link = await this.loadByToken(token);
    // Пропуск, выданный на ссылку А, не должен работать по адресу ссылки Б.
    if (verdict.payload.l !== link.id) {
      deny(SHARE_LINK_ERROR_CODES.sessionInvalid, 'shareLink.sessionMismatch', HttpStatus.FORBIDDEN);
    }
    await this.assertLive(link);
    this.assertEpoch(link, verdict.payload);

    const guest = verdict.payload.g
      ? await this.db.shareLinkGuest.findUnique({ where: { id: verdict.payload.g } })
      : null;
    const view = await this.resolveView(
      link,
      guest ? { id: guest.id, name: guest.name, phone: guest.phone } : null,
    );
    return {
      // Пропуск не продлеваем: час — это час, иначе открытая вкладка жила бы вечно.
      sessionToken: sessionToken as string,
      sessionExpiresAt: new Date(verdict.payload.x).toISOString(),
      linkExpiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
      refType: link.refType,
      guest: guest ? { name: guest.name, phoneMasked: maskPhone(guest.phone) ?? '' } : null,
      view,
    };
  }

  /** Содержимое ссылки по резолверу потребителя; объект умер/в корзине → 410 */
  async resolveView(
    link: ShareLink,
    guest: { id: string; name: string; phone: string } | null = null,
  ): Promise<unknown> {
    const provider = this.registry.get(link.refType);
    if (!provider) deny(SHARE_LINK_ERROR_CODES.refGone, 'shareLink.contentUnavailable', HttpStatus.GONE);

    const view = await provider.resolveGuestView({
      linkId: link.id,
      refType: link.refType,
      refId: link.refId,
      allowDownload: link.allowDownload,
      settings: (link.settings as Record<string, unknown>) ?? {},
      guest,
    });
    if (view === null || view === undefined) {
      deny(SHARE_LINK_ERROR_CODES.refGone, 'shareLink.itemGone', HttpStatus.GONE);
    }
    return view;
  }

  // ============================================================
  // Внутреннее
  // ============================================================

  /**
   * Пароль ссылки: проверка и учёт неудач.
   *
   * Счётчик живёт на САМОЙ ссылке, а не в троттлере: тот считает по IP, а у
   * распределённого перебора адресов сколько угодно — и ссылка оставалась бы
   * подбираемой при любом IP-лимите. Модель попыток взята у core/verify (5), но
   * исчерпание даёт ВРЕМЕННУЮ блокировку, а не смерть ссылки: гасить её насмерть
   * значит дать любому, кто знает токен, отрезать от неё получателя.
   *
   * Блокировка проверяется ДО bcrypt: иначе заблокированная ссылка осталась бы
   * бесплатным насосом для пула потоков (хэш стоит сотни миллисекунд, потоков четыре).
   */
  private async verifyPassword(link: ShareLink, password: string | undefined): Promise<void> {
    if (!password) deny(SHARE_LINK_ERROR_CODES.passwordRequired, 'shareLink.passwordRequired', HttpStatus.FORBIDDEN);

    const lockedForMs = link.pwdLockedUntil ? link.pwdLockedUntil.getTime() - Date.now() : 0;
    if (lockedForMs > 0) {
      deny(
        SHARE_LINK_ERROR_CODES.passwordLocked,
        'shareLink.tooManyTries',
        HttpStatus.FORBIDDEN,
        { retryInSec: Math.ceil(lockedForMs / 1000) },
      );
    }

    if (await bcrypt.compare(password, link.passwordHash as string)) {
      // Верный пароль обнуляет счёт: пять попыток — это пять ПОДРЯД, а не пять за всю
      // жизнь ссылки. Иначе получатель, дважды промахнувшийся регистром за месяц,
      // однажды упёрся бы в стену на ровном месте.
      if (link.pwdFailedAttempts > 0 || link.pwdLockedUntil) {
        await this.db.shareLink.update({
          where: { id: link.id },
          data: { pwdFailedAttempts: 0, pwdLockedUntil: null },
        });
      }
      return;
    }

    // Инкремент атомарный, а не «прочитали и записали»: параллельный перебор — это ровно
    // тот случай, ради которого счётчик и заводится, и он бы его же и обошёл.
    const after = await this.db.shareLink.update({
      where: { id: link.id },
      data: { pwdFailedAttempts: { increment: 1 } },
      select: { pwdFailedAttempts: true },
    });
    const left = SHARE_LINK_LIMITS.passwordMaxAttempts - after.pwdFailedAttempts;
    if (left > 0) {
      deny(SHARE_LINK_ERROR_CODES.passwordWrong, 'shareLink.wrongPassword', HttpStatus.FORBIDDEN, {
        attemptsLeft: left,
      });
    }

    // Блок — один на залп: ставит его тот, кто застал счёт на пороге (переход по условию),
    // параллельные неудачи получают уже стоящий блок. Событие журнала и уведомление автору
    // ссылки («сменить пароль или закрыть ссылку») — в транзакции перехода.
    await this.db.$transaction(async (tx) => {
      const locked = await tx.shareLink.updateMany({
        where: { id: link.id, pwdFailedAttempts: { gte: SHARE_LINK_LIMITS.passwordMaxAttempts } },
        data: {
          pwdFailedAttempts: 0,
          pwdLockedUntil: new Date(Date.now() + SHARE_LINK_LIMITS.passwordLockMinutes * 60_000),
        },
      });
      if (!locked.count) return;
      await this.audit.record(tx, {
        key: 'sharing.link.password_locked',
        actor: { kind: 'anonymous' },
        outcome: 'denied',
        subjectUserId: link.createdById,
        workspaceId: link.workspaceId,
        target: { type: link.refType, id: link.refId, label: link.refTitle },
        ref: { type: 'share_link', id: link.id },
        details: { resource: link.refType, attempts: SHARE_LINK_LIMITS.passwordMaxAttempts, minutes: SHARE_LINK_LIMITS.passwordLockMinutes },
        notify: { params: { target: link.refTitle ?? '' } },
      });
    });
    deny(
      SHARE_LINK_ERROR_CODES.passwordLocked,
      'shareLink.tooManyTries',
      HttpStatus.FORBIDDEN,
      { retryInSec: SHARE_LINK_LIMITS.passwordLockMinutes * 60 },
    );
  }

  private async loadByToken(token: string): Promise<ShareLink> {
    const link = token ? await this.db.shareLink.findUnique({ where: { token } }) : null;
    // 404 именно «не найдена»: токен 192-битный, перебирать нечего, а честный ответ
    // экономит человеку время («ссылка битая», а не «что-то пошло не так»).
    if (!link) deny(SHARE_LINK_ERROR_CODES.notFound, 'shareLink.notFound', HttpStatus.NOT_FOUND);
    return link;
  }

  /** Ссылка жива и её ещё можно ОТКРЫТЬ (включая лимит открытий) */
  private async assertUsable(link: ShareLink): Promise<void> {
    await this.assertLive(link);
    if (link.maxOpens !== null && link.openCount >= link.maxOpens) {
      deny(SHARE_LINK_ERROR_CODES.exhausted, 'shareLink.exhausted', HttpStatus.GONE);
    }
  }

  /**
   * «Вашу ссылку открыли» — с суточным предохранителем.
   *
   * Тумблер по умолчанию ВКЛЮЧЁН: самый частый случай — «отправил документ человеку», и
   * там уведомление и есть смысл. Но ту же ссылку могут кинуть в общий чат или в пост, и
   * тогда без потолка лента уведомлений превратилась бы в счётчик посещений. Поэтому:
   * несколько уведомлений в сутки, дальше одно прощальное «дальше сегодня тихо», а
   * настоящий счёт человек смотрит в «Моих ссылках».
   *
   * День хранится прямо в строке и сбрасывается ПЕРВЫМ открытием следующих суток —
   * крон для этого не нужен. День считается в APP_TIMEZONE, а не в UTC: «сегодня» должно
   * совпадать с тем, что человек видит у себя, иначе тишина снималась бы среди ночи.
   *
   * Ошибка здесь не имеет права уронить уже состоявшееся открытие — гость свою страницу
   * получит в любом случае.
   */
  private async notifyOwnerOfOpen(
    link: ShareLink,
    open: { openNo: number; day: string },
    guest: ShareLinkGuest | null,
  ): Promise<void> {
    if (!link.notifyOnOpen) return;
    // Номер открытия за сутки посчитан АТОМАРНО в том же UPDATE, что и сам клейм.
    // Суточного предохранителя здесь больше нет: тип `share.link.opened` схлопывается
    // по ссылке («открыли ×12») и троттлится реестром движка — прощальное «дальше тихо»
    // не нужно, счётчик человек видит на самой строке.
    const { openNo, day } = open;
    try {
      // Куда вести владельца: потребитель знает карточку объекта (у подписи —
      // карточка заявки: «контрагент открыл договор» логично открывать на нём).
      // Ошибка/отсутствие резолвера → общий раздел «Ссылки наружу», как раньше.
      const described = await this.registry
        .get(link.refType)
        ?.describeRef?.(link.refId)
        .catch(() => null);
      await this.notifications.send(null, {
        type: 'share.link.opened',
        to: [{ userId: link.createdById }],
        payload: {
          // Название — из СНИМКА на строке: в момент раздачи объект назывался так, и
          // ходить за свежим именем к потребителю на каждое открытие незачем. Его
          // отсутствие заменяет слово продукта — КЛЮЧОМ, а не фразой.
          ...(link.refTitle ? { targetName: link.refTitle } : { targetNameKey: 'common.labels.item' }),
          labelSuffix: link.label ? ` («${link.label}»)` : '',
          // Кто открыл — когда ссылка требовала подтверждение номера. Пустая строка у
          // анонимных: шаблонизатор реестра условий не умеет.
          guestSuffix: guest ? ` — ${guest.name}` : '',
          shareLinkId: link.id,
        },
        ref: { type: 'share_link', id: link.id },
        reason: 'owner',
        actionUrl: described?.href ?? '/profile/links',
        // Ключ идемпотентности — АТОМАРНЫЙ номер открытия за сутки, а не `openCount + 1`
        // из прочитанной в начале запроса строки (у параллельных заходов она одна).
        idempotencyKey: `sl:${link.id}:${day}:${openNo}`,
      });
    } catch {
      // Уведомление — сигнал, а не обязательство: страница гостя важнее.
    }
  }

  /**
   * Пропуск выдан ДО смены адреса ссылки → он больше не действует.
   *
   * Пропуск подписан по linkId, а не по токену, поэтому сам по себе смену адреса он бы
   * пережил — и человек, у которого утёк старый адрес, спокойно продолжил бы смотреть
   * содержимое ещё час. Ровно от него адрес и меняют.
   */
  private assertEpoch(link: ShareLink, payload: { e?: number }): void {
    if ((payload.e ?? 0) !== link.sessionEpoch) {
      deny(
        SHARE_LINK_ERROR_CODES.sessionInvalid,
        'shareLink.addressChanged',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /**
   * Ссылка не отозвана, не истекла и её организация жива (проверяется на каждом запросе
   * гостя). Архив организации ГАСИТ её ссылки на время архива, ничего не отзывая: сервисы
   * выключенной организации закрыты и для своих, и гость не должен видеть больше них —
   * а возврат из архива возвращает ссылки как были. Удалённая насовсем — то же самое.
   */
  private async assertLive(link: ShareLink): Promise<void> {
    if (link.revokedAt) deny(SHARE_LINK_ERROR_CODES.revoked, 'shareLink.revoked', HttpStatus.GONE);
    if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
      deny(SHARE_LINK_ERROR_CODES.expired, 'shareLink.expired', HttpStatus.GONE);
    }
    const workspaceId = link.workspaceId ?? (link.ownerType === 'workspace' ? link.ownerId : null);
    if (workspaceId) {
      const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { isActive: true } });
      if (!ws?.isActive) deny(SHARE_LINK_ERROR_CODES.refGone, 'shareLink.contentUnavailable', HttpStatus.GONE);
    }
  }

  /**
   * Атомарный клейм открытия + строка журнала. Работает ВНУТРИ транзакции открытия
   * (вместе с гашением verify-пропуска и записью гостя): несостоявшийся клейм бросает
   * и откатывает всё — в том числе потраченный одноразовый пропуск, чтобы человек,
   * проигравший гонку за последний слот, не шёл за новым SMS-кодом.
   *
   * Условия повторены в самом UPDATE, потому что между проверкой и записью ссылку
   * могли отозвать или исчерпать: `open_count < max_opens` — сравнение колонки с
   * колонкой, которое Prisma в updateMany выразить не умеет, отсюда сырой SQL.
   * Время — только через utcTs (правило платформы: ни now(), ни голый параметр-Date).
   */
  private async claimOpen(
    tx: Prisma.TransactionClient,
    link: ShareLink,
    info: GuestRequestInfo,
    guestId: string | null,
  ): Promise<{ openNo: number; day: string }> {
    const now = new Date();
    // Дата — строкой с явным ::date: ни одна сторона сравнения не зависит от пояса
    // сессии Postgres, а «сегодня» считается в APP_TIMEZONE, чтобы тишина
    // предохранителя снималась утром у человека, а не среди ночи.
    const today = formatDayKey(now, { locale: SOURCE_LOCALE, timeZone: APP_TIMEZONE });

    // Счётчик уведомлений ведём ЗДЕСЬ же, а не отдельным «прочитали и записали»:
    // предохранитель существует ради вирусной ссылки, а её открывают параллельно —
    // и именно параллельные заходы читали бы одно и то же значение, не давая
    // счётчику дойти до потолка.
    const rows = await tx.$queryRaw<{ notify_count: number }[]>`
      UPDATE share_links
         SET open_count = open_count + 1,
             last_opened_at = ${utcTs(now)},
             updated_at = ${utcTs(now)},
             notify_day = ${today}::date,
             notify_count = CASE WHEN notify_day = ${today}::date THEN notify_count + 1 ELSE 1 END
       WHERE id = ${link.id}
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ${utcTs(now)})
         AND (max_opens IS NULL OR open_count < max_opens)
      RETURNING notify_count
    `;
    if (!rows.length) {
      // Проиграли гонку (последний слот забрал другой) либо ссылку отозвали
      // миллисекунду назад — перечитываем и отвечаем точной причиной. Read-committed
      // видит чужой коммит и внутри нашей транзакции.
      const fresh = await tx.shareLink.findUnique({ where: { id: link.id } });
      if (fresh) await this.assertUsable(fresh);
      deny(SHARE_LINK_ERROR_CODES.exhausted, 'shareLink.exhausted', HttpStatus.GONE);
    }
    await tx.shareLinkVisit.create({
      data: {
        linkId: link.id,
        openedAt: now,
        ip: info.ip ? info.ip.slice(0, 64) : null,
        userAgent: info.userAgent ? info.userAgent.slice(0, SHARE_LINK_LIMITS.visitUserAgentMaxLength) : null,
        guestId,
      },
    });
    return { openNo: Number(rows[0].notify_count), day: today };
  }
}
