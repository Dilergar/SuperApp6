import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { type ShareLink } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  SHARE_LINK_ERROR_CODES,
  SHARE_LINK_LIMITS,
  type ShareGuestPeekDto,
  type ShareGuestSessionDto,
  type ShareLinkErrorCode,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { utcTs } from '../../shared/database/sql-time';
import { ShareLinksRegistry } from './share-links.registry';
import { ShareLinksTokenService } from './share-links-token.service';

/** Контекст запроса гостя — всё, что мы о нём знаем (и всё, что пишем в журнал) */
export interface GuestRequestInfo {
  ip?: string | null;
  userAgent?: string | null;
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
  ) {}

  /** Шаг 1: жива ли ссылка и нужен ли пароль */
  async peek(token: string): Promise<ShareGuestPeekDto> {
    const link = await this.loadByToken(token);
    this.assertUsable(link);
    return { state: link.passwordHash ? 'password_required' : 'ready' };
  }

  /** Шаг 2: открыть ссылку — засчитать открытие, записать визит, выдать пропуск и содержимое */
  async openSession(
    token: string,
    password: string | undefined,
    info: GuestRequestInfo,
  ): Promise<ShareGuestSessionDto> {
    const link = await this.loadByToken(token);
    this.assertUsable(link);

    // Пароль проверяется ДО клейма: неверная попытка не имеет права тратить открытие,
    // иначе ссылку с лимитом можно было бы «сжечь» чужому получателю чужими руками.
    if (link.passwordHash) await this.verifyPassword(link, password);

    // Содержимое резолвим ДО клейма: резолвер только читает, а открытие — расходуемый
    // ресурс. В обратном порядке объект, уехавший в корзину, сжигал бы открытие
    // НАВСЕГДА: гость видел «объект недоступен», владелец возвращал объект из корзины —
    // а ссылка уже «лимит исчерпан», хотя человеку так ничего и не показали.
    const view = await this.resolveView(link);

    await this.claimOpen(link, info);
    const session = this.tokens.issue(link.id);
    return {
      sessionToken: session.token,
      sessionExpiresAt: session.expiresAt.toISOString(),
      linkExpiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
      refType: link.refType,
      view,
    };
  }

  /**
   * Проверка пропуска на КАЖДОМ последующем запросе — своём (`/view`) и чужом
   * (гостевые контроллеры потребителей). Строка ссылки перечитывается из БД, поэтому
   * отзыв действует немедленно: пропуск сам по себе не разрешает ничего.
   *
   * maxOpens здесь намеренно НЕ проверяется: он ограничивает число ОТКРЫТИЙ, а не
   * длительность уже начатого просмотра — иначе человек, открывший последнюю копию,
   * терял бы страницу на первом же клике.
   */
  async authorizeGuest(sessionToken: string | undefined | null, expectedRefType?: string): Promise<ShareLink> {
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
    if (expectedRefType && link.refType !== expectedRefType) {
      deny(SHARE_LINK_ERROR_CODES.sessionInvalid, 'Сессия не подходит к этому разделу', HttpStatus.FORBIDDEN);
    }
    return link;
  }

  /**
   * Свежее содержимое по действующему пропуску — без счётчика. Этим живут обновление
   * страницы и добор протухших ссылок на файлы (они подписаны на ~10 минут).
   */
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

    const view = await this.resolveView(link);
    return {
      // Пропуск не продлеваем: час — это час, иначе открытая вкладка жила бы вечно.
      sessionToken: sessionToken as string,
      sessionExpiresAt: new Date(verdict.payload.x).toISOString(),
      linkExpiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
      refType: link.refType,
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

  /** Ссылка не отозвана и не истекла (проверяется на каждом запросе гостя) */
  private assertLive(link: ShareLink): void {
    if (link.revokedAt) deny(SHARE_LINK_ERROR_CODES.revoked, 'Ссылку отозвали', HttpStatus.GONE);
    if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
      deny(SHARE_LINK_ERROR_CODES.expired, 'Срок действия ссылки истёк', HttpStatus.GONE);
    }
  }

  /**
   * Атомарный клейм открытия + строка журнала одной транзакцией.
   *
   * Условия повторены в самом UPDATE, потому что между проверкой и записью ссылку
   * могли отозвать или исчерпать: `open_count < max_opens` — сравнение колонки с
   * колонкой, которое Prisma в updateMany выразить не умеет, отсюда сырой SQL.
   * Время — только через utcTs (правило платформы: ни now(), ни голый параметр-Date).
   */
  private async claimOpen(link: ShareLink, info: GuestRequestInfo): Promise<void> {
    const now = new Date();
    const claimed = await this.db.$transaction(async (tx) => {
      const affected = await tx.$executeRaw`
        UPDATE share_links
           SET open_count = open_count + 1,
               last_opened_at = ${utcTs(now)},
               updated_at = ${utcTs(now)}
         WHERE id = ${link.id}
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ${utcTs(now)})
           AND (max_opens IS NULL OR open_count < max_opens)
      `;
      if (affected === 0) return false;
      await tx.shareLinkVisit.create({
        data: {
          linkId: link.id,
          openedAt: now,
          ip: info.ip ? info.ip.slice(0, 64) : null,
          userAgent: info.userAgent ? info.userAgent.slice(0, SHARE_LINK_LIMITS.visitUserAgentMaxLength) : null,
        },
      });
      return true;
    });

    if (!claimed) {
      // Проиграли гонку (последний слот забрал другой) либо ссылку отозвали
      // миллисекунду назад — перечитываем и отвечаем точной причиной.
      const fresh = await this.db.shareLink.findUnique({ where: { id: link.id } });
      if (fresh) this.assertUsable(fresh);
      deny(SHARE_LINK_ERROR_CODES.exhausted, 'Лимит открытий ссылки исчерпан', HttpStatus.GONE);
    }
  }
}
