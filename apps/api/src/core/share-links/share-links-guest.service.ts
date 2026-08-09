import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type ShareLink, type ShareLinkGuest } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  APP_TIMEZONE,
  SHARE_LINK_ERROR_CODES,
  SHARE_LINK_LIMITS,
  maskPhone,
  type ShareGuestIdentityStartDto,
  type ShareGuestPeekDto,
  type ShareGuestSessionDto,
  type ShareLinkErrorCode,
} from '@superapp/shared';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { DatabaseService } from '../../shared/database/database.service';
import { utcTs } from '../../shared/database/sql-time';
import { VerifyService } from '../verify/verify.service';
import { ShareLinksRegistry } from './share-links.registry';
import { ShareLinksTokenService } from './share-links-token.service';

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
function deny(
  code: ShareLinkErrorCode,
  message: string,
  status: HttpStatus,
  extra?: Record<string, unknown>,
): never {
  throw new HttpException({ message, details: { code, ...extra } }, status);
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
  ) {}

  /** Шаг 1: жива ли ссылка, нужен ли пароль и предстоит ли подтверждение номера */
  async peek(token: string): Promise<ShareGuestPeekDto> {
    const link = await this.loadByToken(token);
    this.assertUsable(link);
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
    this.assertUsable(link);
    if (!link.requireIdentity) {
      // Ссылка кода не просит — эта ручка для неё не существует (не даём превращать
      // произвольную ссылку в источник SMS-трафика).
      deny(SHARE_LINK_ERROR_CODES.sessionInvalid, 'Ссылка не требует подтверждения номера', HttpStatus.FORBIDDEN);
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
    this.assertUsable(link);

    // Пароль проверяется ДО клейма: неверная попытка не имеет права тратить открытие,
    // иначе ссылку с лимитом можно было бы «сжечь» чужому получателю чужими руками.
    if (link.passwordHash) await this.verifyPassword(link, dto.password);

    if (link.requireIdentity && (!dto.verifyToken || !dto.guestName)) {
      deny(
        SHARE_LINK_ERROR_CODES.identityRequired,
        'Ссылка требует подтверждение номера',
        HttpStatus.FORBIDDEN,
      );
    }

    // Содержимое резолвим ДО клейма: резолвер только читает, а открытие — расходуемый
    // ресурс. В обратном порядке объект, уехавший в корзину, сжигал бы открытие
    // НАВСЕГДА: гость видел «объект недоступен», владелец возвращал объект из корзины —
    // а ссылка уже «лимит исчерпан», хотя человеку так ничего и не показали.
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
      const claimed = await this.claimOpen(tx, link, info, g?.id ?? null);
      return { open: claimed, guest: g };
    });

    await this.notifyOwnerOfOpen(link, open, guest);
    const session = this.tokens.issue(link.id, link.sessionEpoch, guest?.id ?? null);
    return {
      sessionToken: session.token,
      sessionExpiresAt: session.expiresAt.toISOString(),
      linkExpiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
      refType: link.refType,
      guest: guest ? { name: guest.name, phoneMasked: maskPhone(guest.phone) } : null,
      view,
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
    const verdict = this.tokens.verify(sessionToken);
    if (!verdict.ok || !verdict.payload) {
      deny(
        SHARE_LINK_ERROR_CODES.sessionInvalid,
        'Сессия просмотра истекла — откройте ссылку заново',
        HttpStatus.FORBIDDEN,
      );
    }
    const link = await this.db.shareLink.findUnique({ where: { id: verdict.payload.l } });
    if (!link) deny(SHARE_LINK_ERROR_CODES.notFound, 'Ссылка не найдена', HttpStatus.NOT_FOUND);
    this.assertLive(link);
    this.assertEpoch(link, verdict.payload);
    if (expectedRefType && link.refType !== expectedRefType) {
      deny(SHARE_LINK_ERROR_CODES.sessionInvalid, 'Сессия не подходит к этому разделу', HttpStatus.FORBIDDEN);
    }
    // Пропуск старше включения тумблера личности не бывает: включение бампает
    // sessionEpoch, поэтому «ссылка требует личность, а в пропуске её нет» —
    // это подделка, а не легальная старая сессия.
    if (link.requireIdentity && !verdict.payload.g) {
      deny(SHARE_LINK_ERROR_CODES.identityRequired, 'Ссылка требует подтверждение номера', HttpStatus.FORBIDDEN);
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
    const verdict = this.tokens.verify(sessionToken);
    if (!verdict.ok || !verdict.payload) {
      deny(SHARE_LINK_ERROR_CODES.sessionInvalid, 'Сессия просмотра истекла — откройте ссылку заново', HttpStatus.FORBIDDEN);
    }
    const link = await this.loadByToken(token);
    if (verdict.payload.l !== link.id) {
      deny(SHARE_LINK_ERROR_CODES.sessionInvalid, 'Сессия не подходит к этой ссылке', HttpStatus.FORBIDDEN);
    }
    this.assertLive(link);
    this.assertEpoch(link, verdict.payload);
    if (link.requireIdentity && !verdict.payload.g) {
      deny(SHARE_LINK_ERROR_CODES.identityRequired, 'Ссылка требует подтверждение номера', HttpStatus.FORBIDDEN);
    }

    const provider = this.registry.get(link.refType);
    const handler = provider?.actions?.[key];
    // Неизвестное действие — 404, а не 403: существование чужих возможностей
    // постороннему не подтверждаем (тот же приём, что у скоупа гостевых папок).
    if (!handler) deny(SHARE_LINK_ERROR_CODES.notFound, 'Действие недоступно', HttpStatus.NOT_FOUND);

    const guest = verdict.payload.g
      ? await this.db.shareLinkGuest.findUnique({ where: { id: verdict.payload.g } })
      : null;

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
    const verdict = this.tokens.verify(sessionToken);
    if (!verdict.ok || !verdict.payload) {
      deny(
        SHARE_LINK_ERROR_CODES.sessionInvalid,
        'Сессия просмотра истекла — откройте ссылку заново',
        HttpStatus.FORBIDDEN,
      );
    }
    const link = await this.loadByToken(token);
    // Пропуск, выданный на ссылку А, не должен работать по адресу ссылки Б.
    if (verdict.payload.l !== link.id) {
      deny(SHARE_LINK_ERROR_CODES.sessionInvalid, 'Сессия не подходит к этой ссылке', HttpStatus.FORBIDDEN);
    }
    this.assertLive(link);
    this.assertEpoch(link, verdict.payload);

    const guest = verdict.payload.g
      ? await this.db.shareLinkGuest.findUnique({ where: { id: verdict.payload.g } })
      : null;
    const view = await this.resolveView(link);
    return {
      // Пропуск не продлеваем: час — это час, иначе открытая вкладка жила бы вечно.
      sessionToken: sessionToken as string,
      sessionExpiresAt: new Date(verdict.payload.x).toISOString(),
      linkExpiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
      refType: link.refType,
      guest: guest ? { name: guest.name, phoneMasked: maskPhone(guest.phone) } : null,
      view,
    };
  }

  /** Содержимое ссылки по резолверу потребителя; объект умер/в корзине → 410 */
  async resolveView(link: ShareLink): Promise<unknown> {
    const provider = this.registry.get(link.refType);
    if (!provider) deny(SHARE_LINK_ERROR_CODES.refGone, 'Содержимое недоступно', HttpStatus.GONE);

    const view = await provider.resolveGuestView({
      linkId: link.id,
      refType: link.refType,
      refId: link.refId,
      allowDownload: link.allowDownload,
      settings: (link.settings as Record<string, unknown>) ?? {},
    });
    if (view === null || view === undefined) {
      deny(SHARE_LINK_ERROR_CODES.refGone, 'Объект больше недоступен', HttpStatus.GONE);
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
    if (!password) deny(SHARE_LINK_ERROR_CODES.passwordRequired, 'Нужен пароль', HttpStatus.FORBIDDEN);

    const lockedForMs = link.pwdLockedUntil ? link.pwdLockedUntil.getTime() - Date.now() : 0;
    if (lockedForMs > 0) {
      deny(
        SHARE_LINK_ERROR_CODES.passwordLocked,
        'Слишком много неверных попыток — попробуйте позже',
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
      deny(SHARE_LINK_ERROR_CODES.passwordWrong, 'Неверный пароль', HttpStatus.FORBIDDEN, {
        attemptsLeft: left,
      });
    }

    await this.db.shareLink.update({
      where: { id: link.id },
      data: {
        pwdFailedAttempts: 0,
        pwdLockedUntil: new Date(Date.now() + SHARE_LINK_LIMITS.passwordLockMinutes * 60_000),
      },
    });
    deny(
      SHARE_LINK_ERROR_CODES.passwordLocked,
      'Слишком много неверных попыток — попробуйте позже',
      HttpStatus.FORBIDDEN,
      { retryInSec: SHARE_LINK_LIMITS.passwordLockMinutes * 60 },
    );
  }

  private async loadByToken(token: string): Promise<ShareLink> {
    const link = token ? await this.db.shareLink.findUnique({ where: { token } }) : null;
    // 404 именно «не найдена»: токен 192-битный, перебирать нечего, а честный ответ
    // экономит человеку время («ссылка битая», а не «что-то пошло не так»).
    if (!link) deny(SHARE_LINK_ERROR_CODES.notFound, 'Ссылка не найдена', HttpStatus.NOT_FOUND);
    return link;
  }

  /** Ссылка жива и её ещё можно ОТКРЫТЬ (включая лимит открытий) */
  private assertUsable(link: ShareLink): void {
    this.assertLive(link);
    if (link.maxOpens !== null && link.openCount >= link.maxOpens) {
      deny(SHARE_LINK_ERROR_CODES.exhausted, 'Лимит открытий ссылки исчерпан', HttpStatus.GONE);
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
    const cap = SHARE_LINK_LIMITS.notifyPerDay;
    const { openNo, day } = open;
    if (openNo > cap + 1) return; // потолок пройден, прощальное уже ушло — тишина
    try {
      await this.notifications.notify(
        link.createdById,
        openNo === cap + 1 ? 'share.link.opened.muted' : 'share.link.opened',
        {
          // Название — из СНИМКА на строке: в момент раздачи объект назывался так, и
          // ходить за свежим именем к потребителю на каждое открытие незачем.
          targetName: link.refTitle ?? 'объект',
          labelSuffix: link.label ? ` («${link.label}»)` : '',
          // Кто открыл — когда ссылка требовала подтверждение номера. Пустая строка у
          // анонимных: шаблонизатор реестра условий не умеет.
          guestSuffix: guest ? ` — ${guest.name}` : '',
          shareLinkId: link.id,
        },
        // Ключ дедупа — АТОМАРНЫЙ номер открытия за сутки, а не `openCount + 1` из
        // прочитанной в начале запроса строки: у параллельных заходов та строка одна и
        // та же, ключи совпадали, и уникальный индекс уведомлений схлопывал их все в
        // одно. То есть предохранитель работал, а сами уведомления пропадали.
        { actionUrl: '/profile/links', dedupKey: `sl:${link.id}:${day}:${openNo}` },
      );
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
        'Адрес ссылки изменился — откройте её заново по новому адресу',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** Ссылка не отозвана и не истекла (проверяется на каждом запросе гостя) */
  private assertLive(link: ShareLink): void {
    if (link.revokedAt) deny(SHARE_LINK_ERROR_CODES.revoked, 'Ссылку отозвали', HttpStatus.GONE);
    if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
      deny(SHARE_LINK_ERROR_CODES.expired, 'Срок действия ссылки истёк', HttpStatus.GONE);
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
    const today = now.toLocaleDateString('en-CA', { timeZone: APP_TIMEZONE });

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
      if (fresh) this.assertUsable(fresh);
      deny(SHARE_LINK_ERROR_CODES.exhausted, 'Лимит открытий ссылки исчерпан', HttpStatus.GONE);
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
