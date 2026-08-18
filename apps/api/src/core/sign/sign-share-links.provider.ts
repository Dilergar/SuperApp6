import { BadRequestException, ForbiddenException, Injectable, OnModuleInit } from '@nestjs/common';
import {
  SIGN_ERROR_CODES,
  SIGN_REQUEST_REF_TYPE,
  WORKSPACE_ROLE_RANK,
  buildSignPdConsentText,
  buildSignPepConsentText,
  signCmsSchema,
  signDeclineSchema,
  signPepConfirmSchema,
  signPepStartSchema,
  signQrStartSchema,
  signRequestHref,
  SIGN_CONSENT_VERSION,
  type ShareSignGuestView,
  type SignActStatus,
  type SignLevel,
  type SignMethod,
  type SignRequestStatus,
  type WorkspaceRole,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { RolesService } from '../../core/roles/roles.service';
import { ShareLinksRegistry, type GuestActionContext } from '../share-links/share-links.registry';
import { SignService, type SignActor } from './sign.service';
import { SignQrService } from './sign-qr.service';

/** «Открыл документ» пишется в протокол не чаще раза в час: append-only лента — не счётчик кликов */
const VIEWED_THROTTLE_MS = 3600_000;

/**
 * ВНЕШНИЙ ПОДПИСАНТ: человек без аккаунта подписывает документ по ссылке.
 *
 * Ссылка на заявку подписи — это первый потребитель слота `actions` движка
 * гостевых ссылок: он ждал именно такого случая, а не «пустого контракта на
 * всякий случай».
 *
 * Личность обязательна и не обсуждается: подпись безымянного человека не
 * доказывает ничего, поэтому ссылка заводится только с включённым подтверждением
 * номера, а действия отказывают, если гость не назван. Второй SMS-код —
 * УЖЕ ПОД ДОКУМЕНТ (первый подтверждал номер при открытии ссылки): так
 * выполняется «после цифровой аутентификации» ст. 46 п. 4 ЦК РК.
 *
 * Лимит открытий у таких ссылок запрещён (`constraints.forbidMaxOpens`): он
 * запирал бы подписанта снаружи ровно тогда, когда он вернулся с ключом ЭЦП.
 */
@Injectable()
export class SignShareLinksProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly registry: ShareLinksRegistry,
    private readonly sign: SignService,
    private readonly qr: SignQrService,
    private readonly roles: RolesService,
  ) {}

  onModuleInit(): void {
    this.registry.register(SIGN_REQUEST_REF_TYPE, {
      constraints: {
        forbidMaxOpens: true,
        // Личность подписанта — не настройка на усмотрение отправителя: подпись
        // безымянного человека не доказывает ничего, а до этого флага ссылку можно
        // было выдать анонимной, и тогда документ читал любой, кому переслали адрес.
        requireIdentity: true,
      },

      /**
       * Раздавать документ на подпись наружу вправе тот, кто эту подпись собирает,
       * И управляющие его организации: отправитель мог уволиться, а отзыв ссылки
       * не должен остаться без хозяина (прецедент «Ссылок организации»).
       *
       * Два разных отказа (правило движка ссылок): коллега по команде ВИДИТ
       * заявку в списках — ему 403 с причиной; посторонний получает 404.
       */
      authorizeManage: async (userId, refId) => {
        const request = await this.db.signRequest.findUnique({ where: { id: refId } });
        if (!request) return null;
        if (request.createdById !== userId) {
          const role = request.workspaceId ? await this.roleIn(userId, request.workspaceId) : null;
          if (!role || role === 'contractor') return null; // посторонний: существование не подтверждаем
          if ((WORKSPACE_ROLE_RANK[role] ?? 0) < WORKSPACE_ROLE_RANK.manager) {
            throw new ForbiddenException(
              'Ссылкой на подписание управляет отправитель или Менеджер+',
            );
          }
        }
        return {
          ownerType: request.workspaceId ? 'workspace' : 'user',
          ownerId: request.workspaceId ?? request.createdById,
          workspaceId: request.workspaceId,
          title: request.refTitle,
          icon: 'signature',
        };
      },

      /** Что видит гость: замороженный документ, кого ждут и СВОЁ состояние */
      resolveGuestView: async (link) => {
        const request = await this.db.signRequest.findUnique({
          where: { id: link.refId },
          include: { acts: { orderBy: { createdAt: 'asc' } } },
        });
        if (!request) return null;
        // Заявка закрыта — показывать нечего, но и «ссылка сломалась» неверно:
        // движок ответит 410, и страница честно скажет «подписание завершено».
        if (request.status === 'cancelled') return null;

        const view = await this.sign.guestSubjectView(request.id).catch(() => null);
        if (!view) return null;
        // Название организации обязано попасть в ПОКАЗАННЫЙ текст: тот же текст
        // движок снимает в акт при подписании, и разойтись они не должны. С
        // `orgName: null` человеку показывали одно соглашение, а доказательством
        // становилось другое — расхождение ровно в том месте, которым ПЭП и
        // держится (ст. 47 ЦК: подпись равнозначна по СОГЛАШЕНИЮ СТОРОН).
        const orgName = await this.sign.orgNameOfRequest(request.id).catch(() => null);

        // ВЕРНУВШИЙСЯ подписант: его акт вместо «перейти к подписанию» + след
        // «открыл документ» в append-only протоколе (не чаще раза в час — лента
        // доказательств, а не счётчик кликов; счётчик открытий у самой ссылки).
        const mine = link.guest ? request.acts.filter((a) => a.signerGuestId === link.guest!.id) : [];
        const myActRow = mine.length ? mine[mine.length - 1] : null;
        if (myActRow && myActRow.status === 'pending') {
          const recent = await this.db.signActEvent.findFirst({
            where: { actId: myActRow.id, type: 'viewed', at: { gte: new Date(Date.now() - VIEWED_THROTTLE_MS) } },
            select: { id: true },
          });
          if (!recent) await this.sign.logEvent(this.db, myActRow.id, 'viewed', {}).catch(() => undefined);
        }

        const guestView: ShareSignGuestView = {
          kind: 'sign',
          requestId: request.id,
          title: request.refTitle,
          status: request.status as SignRequestStatus,
          level: request.level as SignLevel,
          methods: request.methods as SignMethod[],
          subject: view,
          // Кто уже подписал — именами, без телефонов и ИИН: гостю чужие
          // персональные данные не нужны, а страницу видит всякий с токеном.
          signed: request.acts
            .filter((a) => a.status === 'signed')
            .map((a) => ({ name: a.signerName, at: a.signedAt?.toISOString() ?? null })),
          consentText: buildSignPepConsentText({ docTitle: request.refTitle, orgName }),
          consentVersion: SIGN_CONSENT_VERSION,
          pdConsentText: buildSignPdConsentText({ orgName }),
          myAct: myActRow
            ? {
                status: myActRow.status as SignActStatus,
                signedAt: myActRow.signedAt?.toISOString() ?? null,
                declineReason: myActRow.declineReason,
              }
            : null,
          // Готовность — по живой ссылке, а не по колонке: прибранный уборкой файл
          // иначе обещал бы контрагенту кнопку, которая ничего не скачивает.
          stamped: { ready: (await this.sign.stampedView(request.stampedFileId)).ready },
        };
        return guestView;
      },

      describeRef: async (refId) => {
        const request = await this.db.signRequest.findUnique({
          where: { id: refId },
          select: { refTitle: true, workspaceId: true },
        });
        return request
          ? {
              title: request.refTitle,
              icon: 'signature',
              // «Ссылку открыли» ведёт на карточку заявки: владельцу важно, КТО
              // и НАД ЧЕМ, а не общий список ссылок.
              href: signRequestHref(refId, request.workspaceId),
            }
          : null;
      },

      actions: {
        /** ПЭП, шаг 1: соглашение сторон + согласие на обработку ПД → код на номер гостя */
        'sign.pep.start': async (ctx) => {
          const dto = signPepStartSchema.parse(ctx.body ?? {});
          const { actor, actId } = await this.guestAct(ctx);
          return this.sign.pepStart(actor, actId, dto, { ip: ctx.ip, userAgent: ctx.userAgent });
        },

        /** ПЭП, шаг 2: код → акт */
        'sign.pep.confirm': async (ctx) => {
          const dto = signPepConfirmSchema.parse(ctx.body ?? {});
          const { actor, actId } = await this.guestAct(ctx);
          return this.sign.pepConfirm(actor, actId, dto, { ip: ctx.ip, userAgent: ctx.userAgent });
        },

        /** ЭЦП через NCALayer: готовый контейнер из браузера гостя */
        'sign.cms': async (ctx) => {
          const dto = signCmsSchema.parse(ctx.body ?? {});
          const { actor, actId } = await this.guestAct(ctx);
          await this.requirePdConsent(dto.pdConsentAccepted, actor, actId, ctx);
          return this.sign.submitCms(actor, actId, dto.cms, 'ncalayer', {
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        },

        /** ЭЦП через eGov Mobile */
        'sign.qr.start': async (ctx) => {
          const dto = signQrStartSchema.parse(ctx.body ?? {});
          const { actor, actId } = await this.guestAct(ctx);
          // Согласие фиксируем ЗДЕСЬ: сам контейнер придёт позже и уже не от гостя,
          // а от моста eGov, где спросить его будет не у кого.
          await this.requirePdConsent(dto.pdConsentAccepted, actor, actId, ctx);
          return this.qr.start(actor, actId, { ip: ctx.ip, userAgent: ctx.userAgent });
        },

        /** Отказ — тоже акт, и причина обязательна */
        'sign.decline': async (ctx) => {
          const dto = signDeclineSchema.parse(ctx.body ?? {});
          const { actor, actId } = await this.guestAct(ctx);
          return this.sign.decline(actor, actId, dto, { ip: ctx.ip, userAgent: ctx.userAgent });
        },
      },
    });
  }

  /**
   * Акт внешнего подписанта — заводится ЛЕНИВО при первом действии.
   *
   * Заранее его создать нельзя: до открытия ссылки мы не знаем, КТО придёт, а
   * акт без имени подписанта — это запись, которая ничего не доказывает.
   * Повторный заход того же человека новый акт не плодит: гасит партиальный
   * уникум `(request_id, signer_guest_id)` среди живых.
   */
  /**
   * Согласие на обработку ПД у ВНЕШНЕГО подписанта обязательно на любом уровне
   * подписи, а не только у ПЭП: имя, номер и — при ЭЦП — ИИН гостя хранятся вечно.
   *
   * Экран его и спрашивал, но обработчики ЭЦП флаг молча выбрасывали: галочка была,
   * а доказательства получения согласия (ст. 8 ЗоПД требует именно его) не
   * возникало нигде. Теперь без согласия ЭЦП-путь не начинается, а сам факт уходит
   * записью в append-only протокол.
   */
  private async requirePdConsent(
    accepted: boolean | undefined,
    actor: SignActor,
    actId: string,
    ctx: GuestActionContext,
  ): Promise<void> {
    if (!accepted) {
      throw new BadRequestException({
        message: 'Нужно согласие на обработку персональных данных',
        details: { code: SIGN_ERROR_CODES.consentRequired },
      });
    }
    await this.sign.recordGuestPdConsent(actor, actId, { ip: ctx.ip, userAgent: ctx.userAgent });
  }

  /** Старшая роль человека в организации (лестница WORKSPACE_ROLE_RANK) */
  private async roleIn(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const roles = await this.roles.getRolesInContext(userId, 'workspace', workspaceId);
    if (roles.length === 0) return null;
    return roles
      .map((r) => r.role as WorkspaceRole)
      .sort((a, b) => (WORKSPACE_ROLE_RANK[b] ?? 0) - (WORKSPACE_ROLE_RANK[a] ?? 0))[0];
  }

  private async guestAct(ctx: GuestActionContext): Promise<{ actor: SignActor; actId: string }> {
    if (!ctx.guest) {
      // Ссылка без подтверждения номера подписывать не даёт вовсе: неизвестно
      // кем поставленная подпись хуже отсутствия подписи — она создаёт видимость.
      throw new BadRequestException({
        message: 'Для подписания нужно подтвердить номер телефона',
        details: { code: SIGN_ERROR_CODES.notSigner },
      });
    }
    const actor: SignActor = {
      type: 'guest',
      guestId: ctx.guest.id,
      name: ctx.guest.name,
      phone: ctx.guest.phone,
    };
    const actId = await this.sign.ensureGuestAct(ctx.refId, actor);
    return { actor, actId };
  }
}
