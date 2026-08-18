import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type SignAct as PrismaSignAct, type SignRequest as PrismaSignRequest } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import {
  SIGN_ACT_REF_TYPE,
  SIGN_CONSENT_VERSION,
  SIGN_ERROR_CODES,
  SIGN_FILE_PROFILES,
  SIGN_LEVEL_LABELS,
  SIGN_LIMITS,
  SIGN_METHODS,
  SIGN_METHOD_LEVEL,
  SIGN_REQUEST_REF_TYPE,
  buildSignPdConsentText,
  buildSignPepConsentText,
  maskIin,
  maskPhone,
  signCheckUrl,
  signLevelOfRequirement,
  type CreateSignRequestInput,
  approvalSignatureKindOf,
  type SignActDto,
  type SignActEventDto,
  type SignActStateDto,
  type SignActorLite,
  type SignCertificateDto,
  type SignCheckQuery,
  type SignCheckResultDto,
  type SignCheckSignatureDto,
  type SignDeclineInput,
  type SignFlowDto,
  type SignLevel,
  type SignMethod,
  type SignPepStartDto,
  type SignRequestDto,
  type SignStatusDto,
  type SignSubjectViewDto,
  type SignSummaryDto,
} from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { withTempFile } from '../../shared/fs/temp-file.util';
import { FilesService } from '../files/files.service';
import { JobsService } from '../jobs/jobs.service';
import { VerifyService } from '../verify/verify.service';
import { SignRegistry, type SignSubjectContext } from './sign.registry';
import { SignVerifierService } from './drivers/sign-verifier.driver';
import { SignQrBridgeService } from './drivers/sign-qr.driver';
import { SIGN_FINISHED_JOB, SIGN_REQUESTED_JOB, SIGN_STAMP_JOB } from './sign.jobs';
import { ApprovalsService } from '../approvals/approvals.service';

type Tx = Prisma.TransactionClient;

/** Кто подписывает: сотрудник платформы либо внешний гость по ссылке */
export type SignActor =
  | { type: 'user'; userId: string }
  | { type: 'guest'; guestId: string; name: string; phone: string };

/** Обстоятельства действия — уходят в append-only протокол */
export interface SignCtx {
  ip?: string | null;
  userAgent?: string | null;
}

/** Ошибка движка с машинным кодом в `details.code` */
function coded(message: string, code: string): BadRequestException {
  return new BadRequestException({ message, details: { code } });
}

/**
 * core/sign — 15-й платформенный движок: электронная подпись.
 *
 * Движок НЕ содержит маршрута: маршрут — это core/approvals (шаг `signature`) и
 * Процессы. Его дело — акт подписи, криптография и её проверка, ВЕЧНЫЕ
 * доказательства, экспорт и публичная проверка (ст. 61 Цифрового кодекса РК).
 *
 * Два несущих решения, из-за которых он выглядит именно так:
 *
 * 1) Движок САМ замораживает то, что подписывает. У документа PDF существует
 *    лишь ВАРИАНТОМ файла и умирает при первой правке исходника, поэтому
 *    подписант получает неизменяемую КОПИЮ, и над ней же считается CMS.
 *    «Что видел = что подписал» становится свойством конструкции, а не
 *    договорённостью с потребителем.
 *
 * 2) Доказательства ЗАМОРАЖИВАЮТСЯ, а не пересчитываются. Вердикт цепочки,
 *    статус OCSP и метка TSP пишутся полями акта в момент подписи: юридически
 *    значим статус сертификата ТОГДА (приказ № 1187), а через год сертификат
 *    истечёт и живая проверка не докажет ничего.
 */
@Injectable()
export class SignService {
  private readonly logger = new Logger(SignService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: SignRegistry,
    private readonly files: FilesService,
    private readonly verify: VerifyService,
    private readonly verifier: SignVerifierService,
    private readonly qrBridge: SignQrBridgeService,
    private readonly jobs: JobsService,
    private readonly approvals: ApprovalsService,
  ) {}

  // ============================================================
  // Режим движка
  // ============================================================

  status(): SignStatusDto {
    const methods = this.availableMethods();
    return {
      enabled: methods.length > 0,
      methods,
      verifierLive: this.verifier.live,
      qrLive: this.qrBridge.live,
      ecpAccepted: this.verifier.ecpAccepted,
    };
  }

  /**
   * Способы, которые вообще работают в этом окружении.
   *
   * ПЭП доступна всегда (движок подтверждений — часть платформы). ЭЦП исчезает
   * целиком, когда её нечем проверить: показать кнопку «Подписать ЭЦП», которая
   * гарантированно отвергнет подпись, — худший из возможных вариантов.
   */
  private availableMethods(): SignMethod[] {
    return SIGN_METHODS.filter((m) => (SIGN_METHOD_LEVEL[m] === 'ecp' ? this.verifier.ecpAccepted : true));
  }

  private methodsForLevel(level: SignLevel, requested?: SignMethod[]): SignMethod[] {
    const pool = this.availableMethods().filter((m) => {
      // ЭЦП закрывает и требование ПЭП: она строго сильнее (ст. 49 ЦК). Обратное
      // неверно — простой подписью кадровый приказ не подписать.
      if (level === 'ecp') return SIGN_METHOD_LEVEL[m] === 'ecp';
      return true;
    });
    if (!requested?.length) return pool;
    return pool.filter((m) => requested.includes(m));
  }

  // ============================================================
  // Создание заявки
  // ============================================================

  /**
   * Завести заявку на подпись. Зовёт ПОТРЕБИТЕЛЬ через сервис — HTTP-ручки нет
   * намеренно (тот же довод, что у core/approvals): право «отправить это на
   * подпись» знает только он, а публичный путь шёл бы мимо. Проверку права
   * делает `canRequestSign` резолвера — единственное место, через которое
   * проходит любое заведение заявки.
   */
  async createRequest(
    actorId: string,
    input: CreateSignRequestInput,
    /**
     * Право уже подтверждено ДРУГИМ путём — сейчас так приходит ровно один
     * вызывающий: подписание шага маршрута.
     *
     * `canRequestSign` отвечает на вопрос «вправе ли человек ОТПРАВИТЬ этот
     * объект на подпись», а не «вправе ли он ПОДПИСАТЬ». Для документа это
     * автор или управляющий — и рядовой сотрудник, которому маршрут поручил
     * подписать приказ, не прошёл бы эту проверку и не смог бы выполнить то,
     * что от него требуют. Полномочие подписанта даёт снимок адресатов шага,
     * который проверил движок решений.
     */
    opts: {
      authorizedBy?: 'approval_step';
      /**
       * Потребитель сам рассказывает людям об исходе (ЭДО шлёт свои «контрагент
       * подписал/отказал» с контекстом документа) — движковые sign.completed и
       * sign.declined для этой заявки подавляются. `sign.requested` внутренним
       * подписантам НЕ подавляется никогда.
       */
      suppressOutcomeNotify?: boolean;
      /**
       * ЖДЁМ ВНЕШНЕГО подписанта (внешний контур ЭДО): акт второй стороны
       * заводится СРАЗУ — на контактное лицо, без личности (`signerGuestId`
       * пришьёт первый заход гостя). Без него заявка закрывалась бы внутренними
       * подписями, не дождавшись контрагента: акт гостя ленив, и «не осталось
       * ждущих актов» наступало раньше, чем вторая сторона вообще открыла ссылку.
       */
      guestSigner?: { name: string; phone?: string | null };
    } = {},
  ): Promise<SignRequestDto> {
    const provider = this.registry.get(input.refType);
    if (!provider) throw new NotFoundException(`Тип «${input.refType}» не зарегистрирован в подписи`);
    if (!opts.authorizedBy && !(await provider.canRequestSign(actorId, input.refId))) {
      throw new ForbiddenException('Нельзя отправить этот объект на подпись');
    }

    const subject = await provider.resolveSubject(input.refId);
    if (!subject) throw coded('Нечего подписывать: документ не готов', SIGN_ERROR_CODES.subjectGone);

    const methods = this.methodsForLevel(input.level, input.methods);
    if (methods.length === 0) {
      throw coded(
        input.level === 'ecp'
          ? 'Подписание ЭЦП сейчас недоступно: не настроена проверка сертификатов'
          : 'Подписание сейчас недоступно',
        SIGN_ERROR_CODES.methodDisabled,
      );
    }

    const frozen = await this.freezeSubject(subject, actorId);
    const signerIds = [...new Set(input.signerUserIds?.length ? input.signerUserIds : [actorId])];

    const requestId = await this.db.$transaction(async (tx) => {
      const request = await tx.signRequest.create({
        data: {
          refType: input.refType,
          refId: input.refId,
          refTitle: subject.title.slice(0, 200),
          refIcon: subject.icon ?? null,
          workspaceId: subject.workspaceId,
          subjectFileId: frozen.fileId,
          subjectSha256: frozen.sha256,
          level: input.level,
          methods,
          approvalStepId: input.approvalStepId ?? null,
          suppressOutcomeNotify: opts.suppressOutcomeNotify ?? false,
          createdById: actorId,
          expiresAt: input.expiresAt ?? this.defaultExpiry(),
        },
        select: { id: true },
      });
      // Копия предмета живёт как ЧАСТЬ заявки: связь ставим сразу, чтобы у файла
      // с первой же секунды был дом (профиль доказательств реап не трогает,
      // но «файл без места» — плохое состояние само по себе).
      await this.files.linkSystemInTx(tx, {
        fileId: frozen.fileId,
        refType: SIGN_REQUEST_REF_TYPE,
        refId: request.id,
        role: 'subject',
        createdById: actorId,
      });
      for (const userId of signerIds) {
        await this.createActTx(tx, request.id, { type: 'user', userId }, input.level, frozen.sha256);
      }
      // Акт-ожидание ВТОРОЙ стороны: держит заявку открытой до подписи гостя
      if (opts.guestSigner) {
        await tx.signAct.create({
          data: {
            requestId: request.id,
            signerType: 'guest',
            signerUserId: null,
            signerGuestId: null, // личность пришьёт первый заход гостя
            signerName: opts.guestSigner.name,
            signerPhone: opts.guestSigner.phone ?? null,
            level: input.level,
            subjectSha256: frozen.sha256,
            checkToken: randomBytes(SIGN_LIMITS.checkTokenBytes).toString('base64url'),
          },
        });
      }
      // Позвать подписантов — работа ОБЯЗАТЕЛЬНАЯ, поэтому джоб ставим В ЭТОЙ ЖЕ
      // транзакции (transactional outbox): коммит = человека позовут, откат = звать
      // некого. Постановка после коммита теряла оповещение при любом сбое между
      // ними — молча, а узнать «документ ждёт моей подписи» больше неоткуда.
      await this.jobs.enqueue(tx, {
        type: SIGN_REQUESTED_JOB,
        payload: { requestId: request.id },
        uniqueKey: `signreq:${request.id}`,
      });
      return request.id;
    });

    return this.serializeRequest(requestId);
  }

  private defaultExpiry(): Date {
    return new Date(Date.now() + SIGN_LIMITS.requestTtlHours * 3_600_000);
  }

  /**
   * Заявка под ШАГ МАРШРУТА — лениво и идемпотентно.
   *
   * Лениво, потому что заявка нужна только когда до шага реально дошли: заводить
   * её при создании маршрута значило бы замораживать документ, который до этого
   * шага ещё десять раз перепишут. Идемпотентно — партиальным уникумом в БД, а
   * не проверкой в коде: двое адресатов шага «нужен каждый», нажавших «Подписать»
   * одновременно, иначе получили бы ДВЕ заявки с разными заморозками, то есть
   * подписали бы формально разные документы.
   */
  async ensureForStep(actor: SignActor, stepId: string): Promise<SignFlowDto> {
    if (actor.type !== 'user') throw new ForbiddenException('Шаг маршрута подписывает сотрудник');
    // Адресность, активность шага и требование уровня решает движок решений —
    // второго толкования этих правил в движке подписи быть не должно.
    const step = await this.approvals.stepForSignature(actor.userId, stepId);
    const level = signLevelOfRequirement(step.requiredSignatureKind);

    const existing = await this.db.signRequest.findFirst({
      where: { approvalStepId: stepId, status: 'pending' },
      select: { id: true },
    });
    if (existing) {
      await this.ensureActFor(existing.id, actor, level);
      return this.getFlow(actor, existing.id);
    }

    try {
      const created = await this.createRequest(
        actor.userId,
        {
          refType: step.refType,
          refId: step.refId,
          level,
          approvalStepId: stepId,
          // На шаге «нужен каждый» акты заводим СРАЗУ ВСЕМ адресатам снимка, а не
          // одному открывшему. Иначе первый подписант закрывал заявку своей же
          // единственной подписью, а второй, придя позже, не находил живой заявки и
          // получал НОВУЮ — с новой заморозкой предмета: двое подписывали формально
          // разные документы, карточка показывала только последнюю заявку, и первая
          // подпись пропадала из блока «Подписи».
          signerUserIds: step.rule === 'all' ? step.awaitingUserIds : [actor.userId],
        },
        // Полномочие даёт СНИМОК АДРЕСАТОВ шага, который уже проверил движок
        // решений. Спрашивать сверху `canRequestSign` («вправе отправить на
        // подпись») здесь неверно: рядовой сотрудник, которому маршрут поручил
        // подписать приказ, не вправе этот приказ инициировать — и остался бы
        // без возможности выполнить порученное.
        { authorizedBy: 'approval_step' },
      );
      return this.getFlow(actor, created.id);
    } catch (err) {
      // Гонку выиграл сосед — работаем с его заявкой. Замороженную копию, которую
      // мы успели создать, реап не тронет (профиль доказательств), и это верно:
      // потерять байты подписи страшнее, чем оставить лишний файл.
      if ((err as Prisma.PrismaClientKnownRequestError)?.code === 'P2002') {
        const twin = await this.db.signRequest.findFirstOrThrow({
          where: { approvalStepId: stepId, status: 'pending' },
          select: { id: true },
        });
        await this.ensureActFor(twin.id, actor, level);
        return this.getFlow(actor, twin.id);
      }
      throw err;
    }
  }

  /**
   * Акт ВНЕШНЕГО подписанта — лениво, при первом его действии.
   *
   * Заранее завести нельзя: до открытия ссылки неизвестно, кто придёт, а акт без
   * имени подписанта ничего не доказывает. Повторный заход того же человека
   * новый акт не плодит — гасит партиальный уникум по (заявка, гость).
   */
  async ensureGuestAct(requestId: string, actor: SignActor): Promise<string> {
    // Метод существует ровно для ВНЕШНЕГО подписанта. Сотруднику здесь не место, и
    // дело не только в чистоте: фильтр по `signerGuestId` для него выродился бы в
    // `undefined`, Prisma убрала бы условие целиком — и «своим» актом оказался бы
    // первый попавшийся акт заявки, то есть ЧУЖОЙ.
    if (actor.type !== 'guest') {
      throw new ForbiddenException('Этот путь подписания — только для внешнего подписанта');
    }
    const request = await this.db.signRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Заявка на подпись не найдена');
    if (request.status !== 'pending') {
      throw coded('Подписание закрыто', SIGN_ERROR_CODES.requestClosed);
    }
    const existing = await this.db.signAct.findFirst({
      where: {
        requestId,
        signerGuestId: actor.guestId,
        status: { in: ['pending', 'signed'] },
      },
      select: { id: true },
    });
    if (existing) return existing.id;

    // Акт-ОЖИДАНИЕ (внешний контур): заведён при отправке на контактное лицо, без
    // личности. Первый пришедший гость «пришивает» себя к нему атомарно — гвард
    // `signerGuestId IS NULL` отдаёт акт ровно одному, проигравший идёт обычным
    // путём. Имя и номер перезаписываются подтверждёнными: подписант может
    // оказаться не тем контактом, которого ждали, и акт обязан говорить правду.
    const placeholder = await this.db.signAct.findFirst({
      where: { requestId, signerType: 'guest', signerGuestId: null, status: 'pending' },
      select: { id: true },
    });
    if (placeholder) {
      const claimed = await this.db.signAct.updateMany({
        where: { id: placeholder.id, signerGuestId: null, status: 'pending' },
        data: { signerGuestId: actor.guestId, signerName: actor.name, signerPhone: actor.phone },
      });
      if (claimed.count > 0) return placeholder.id;
    }

    const created = await this.db.$transaction((tx) =>
      this.createActTx(tx, requestId, actor, request.level as SignLevel, request.subjectSha256),
    );
    if (created) return created;
    // Гонку выиграл параллельный запрос того же гостя — берём его акт.
    const twin = await this.db.signAct.findFirstOrThrow({
      where: { requestId, signerGuestId: actor.guestId, status: { in: ['pending', 'signed'] } },
      select: { id: true },
    });
    return twin.id;
  }

  /** Замороженный документ для гостевой страницы (доступ подтверждён ссылкой) */
  async guestSubjectView(requestId: string): Promise<SignSubjectViewDto> {
    const request = await this.db.signRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { subjectFileId: true, subjectSha256: true },
    });
    return this.subjectView(request);
  }

  /** Дописать акт подписанту, который пришёл к уже заведённой заявке (шаг «нужен каждый») */
  private async ensureActFor(requestId: string, actor: SignActor, level: SignLevel): Promise<void> {
    await this.db.$transaction(async (tx) => {
      // Статус перечитываем ВНУТРИ транзакции: пока мы сюда шли, заявку мог закрыть
      // последний подписант или отказ. Вписать в закрытую заявку ЖДУЩИЙ акт значит
      // оставить человека с подписью, которую уже некуда поставить, — и такой акт
      // навсегда занял бы партиальный уникум «одна живая подпись на подписанта».
      const fresh = await tx.signRequest.findUnique({
        where: { id: requestId },
        select: { status: true, subjectSha256: true },
      });
      if (!fresh || fresh.status !== 'pending') return null;
      return this.createActTx(tx, requestId, actor, level, fresh.subjectSha256);
    });
  }

  /**
   * Заморозить предмет: прочитать байты у потребителя и положить их ОТДЕЛЬНЫМ
   * неизменяемым файлом (профиль `sign_subject` — вне квоты и вне ретеншна).
   *
   * Без этого шага подпись стояла бы под живым файлом, который потребитель может
   * переписать, и доказать, ЧТО именно подписано, было бы нечем.
   */
  private async freezeSubject(
    subject: SignSubjectContext,
    actorId: string,
  ): Promise<{ fileId: string; sha256: string }> {
    const { result, mime, name } = await this.files.openRawStream(subject.fileId, subject.variant ?? null);
    const bytes = await streamToBuffer(result.stream);
    if (bytes.length === 0) throw coded('Документ пуст — подписывать нечего', SIGN_ERROR_CODES.subjectGone);

    const file = await withTempFile(name, bytes, (filePath) =>
      this.files.ingestLocalFile({
        path: filePath,
        name,
        mime,
        profile: SIGN_FILE_PROFILES.subject,
        ownerUserId: actorId,
        ownerType: subject.ownerType,
        ownerId: subject.ownerId,
      }),
    );
    return { fileId: file.id, sha256: file.sha256 ?? createHash('sha256').update(bytes).digest('hex') };
  }

  /** Завести акт подписанту. Повтор гасит партиальный уникум, а не проверка в коде. */
  private async createActTx(
    tx: Tx,
    requestId: string,
    actor: SignActor,
    level: SignLevel,
    subjectSha256: string,
  ): Promise<string | null> {
    const name =
      actor.type === 'user' ? await this.displayName(tx, actor.userId) : actor.name;
    try {
      const act = await tx.signAct.create({
        data: {
          requestId,
          signerType: actor.type,
          signerUserId: actor.type === 'user' ? actor.userId : null,
          signerGuestId: actor.type === 'guest' ? actor.guestId : null,
          signerName: name,
          signerPhone: actor.type === 'guest' ? actor.phone : null,
          level,
          subjectSha256,
          checkToken: randomBytes(SIGN_LIMITS.checkTokenBytes).toString('base64url'),
        },
        select: { id: true },
      });
      await tx.signActEvent.create({ data: { actId: act.id, type: 'created' } });
      return act.id;
    } catch (err) {
      // Живой акт этого подписанта уже есть — это норма (двойной клик, повторный
      // заход по ссылке), а не сбой.
      if ((err as Prisma.PrismaClientKnownRequestError)?.code === 'P2002') return null;
      throw err;
    }
  }

  private async displayName(tx: Tx | DatabaseService, userId: string): Promise<string> {
    const u = await tx.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, middleName: true },
    });
    if (!u) return 'Пользователь';
    return [u.lastName, u.firstName, u.middleName].filter(Boolean).join(' ') || 'Пользователь';
  }

  // ============================================================
  // Экран подписания
  // ============================================================

  async getFlow(actor: SignActor, requestId: string): Promise<SignFlowDto> {
    const request = await this.db.signRequest.findUnique({
      where: { id: requestId },
      include: { acts: { orderBy: { createdAt: 'asc' } } },
    });
    if (!request) throw new NotFoundException('Заявка на подпись не найдена');

    const myAct = request.acts.find((a) => this.isMine(a, actor)) ?? null;
    if (!myAct && !(await this.canViewRequest(actor, request))) {
      throw new NotFoundException('Заявка на подпись не найдена');
    }

    const subject = await this.subjectView(request);
    const canSign =
      !!myAct &&
      myAct.status === 'pending' &&
      request.status === 'pending' &&
      !this.isExpired(request.expiresAt);

    if (myAct && canSign) {
      await this.logEvent(this.db, myAct.id, 'viewed', {}).catch(() => undefined);
    }

    const orgName = request.workspaceId ? await this.orgName(request.workspaceId) : null;
    return {
      request: await this.serializeRequest(requestId, request.acts),
      subject,
      myAct: myAct ? this.serializeAct(myAct) : null,
      canSign,
      consentText: canSign ? buildSignPepConsentText({ docTitle: request.refTitle, orgName }) : null,
      consentVersion: canSign ? SIGN_CONSENT_VERSION : null,
      pdConsentText: canSign && actor.type === 'guest' ? buildSignPdConsentText({ orgName }) : null,
    };
  }

  private isMine(act: { signerUserId: string | null; signerGuestId: string | null }, actor: SignActor): boolean {
    return actor.type === 'user' ? act.signerUserId === actor.userId : act.signerGuestId === actor.guestId;
  }

  /**
   * Стоп-кран рекурсии «резолвер зовёт нас обратно». `canView` потребителя обычно
   * реализован его же карточкой (`documents.get`), а карточка спрашивает у нас блок
   * подписей (`summaryForRef`). Прямой путь разорван флагом `viewAuthorized`, но это
   * дисциплина ОДНОГО вызова: следующий потребитель без флага собрал бы кольцо
   * get → summaryForRef → canViewRequest → get заново — и оно ТИХОЕ (никакого stack
   * overflow: витки асинхронные, каждый ходит в БД, запрос висит до HTTP-таймаута,
   * молотя базу; ровно так это и жило у документов). Повторный вход с тем же
   * предметом внутри одной async-цепочки → громкая ошибка в лог и fail-closed false.
   */
  private readonly canViewGuard = new AsyncLocalStorage<Set<string>>();

  /** Право видеть заявку у не-подписанта решает потребитель (карточка документа) */
  private async canViewRequest(
    actor: SignActor,
    request: { refType: string; refId: string; createdById: string },
  ): Promise<boolean> {
    if (actor.type !== 'user') return false;
    if (request.createdById === actor.userId) return true;
    const provider = this.registry.get(request.refType);
    if (!provider?.canView) return false;
    const key = `${request.refType}:${request.refId}:${actor.userId}`;
    const seen = this.canViewGuard.getStore();
    if (seen?.has(key)) {
      this.logger.error(
        `canView('${request.refType}') замкнул кольцо на ${request.refId}: ` +
          `резолвер потребителя зовёт sign обратно — нужен viewAuthorized у summaryForRef`,
      );
      return false;
    }
    const next = new Set(seen);
    next.add(key);
    return this.canViewGuard.run(next, async () => (await provider.canView!(actor.userId, request.refId)) ?? false);
  }

  private isExpired(expiresAt: Date | null): boolean {
    return !!expiresAt && expiresAt.getTime() <= Date.now();
  }

  private async subjectView(request: {
    subjectFileId: string;
    subjectSha256: string;
  }): Promise<SignSubjectViewDto> {
    const file = await this.db.fileObject.findUnique({
      where: { id: request.subjectFileId },
      select: { name: true, mime: true, size: true },
    });
    if (!file) throw coded('Замороженная копия документа исчезла', SIGN_ERROR_CODES.subjectGone);
    // Системная ссылка: доступ мы уже проверили сами (акт мой либо потребитель
    // подтвердил право видеть) — контракт `buildSystemDownloadUrl`.
    const url = await this.files.buildSystemDownloadUrl(request.subjectFileId);
    return {
      fileId: request.subjectFileId,
      name: file.name,
      mime: file.mime,
      size: Number(file.size),
      sha256: request.subjectSha256,
      url: url.url,
      expiresAt: url.expiresAt,
    };
  }

  // ============================================================
  // ПЭП: соглашение сторон → код под документ → акт
  // ============================================================

  /**
   * Шаг 1. Соглашение принято (ст. 47 ЦК) → шлём код на подтверждённый номер.
   *
   * Пароль здесь НЕ спрашивается осознанно: вход в систему и есть «цифровая
   * аутентификация» ст. 46 п. 4, а код — второй фактор ПОД КОНКРЕТНЫЙ документ.
   * Соглашение снимается в акт ДО отправки: иначе доказательством было бы
   * «человек что-то нажал», а не текст, который он принял.
   */
  async pepStart(
    actor: SignActor,
    actId: string,
    dto: { consentAccepted: true; pdConsentAccepted?: boolean },
    ctx: SignCtx,
  ): Promise<SignPepStartDto> {
    const { act, request } = await this.loadOwnAct(actor, actId);
    this.assertMethodAllowed(request, 'pep_otp');

    const phone = await this.signerPhone(actor);
    const orgName = request.workspaceId ? await this.orgName(request.workspaceId) : null;
    const consentText = buildSignPepConsentText({ docTitle: request.refTitle, orgName });

    if (actor.type === 'guest' && !dto.pdConsentAccepted) {
      throw coded(
        'Нужно согласие на обработку персональных данных',
        SIGN_ERROR_CODES.consentRequired,
      );
    }

    // Соглашение фиксируем ДО SMS и отдельным событием протокола: ст. 8 ЗоПД
    // требует способа, ПОЗВОЛЯЮЩЕГО ПОДТВЕРДИТЬ получение согласия, — галочка на
    // экране сама по себе таким способом не является.
    //
    // Статус-гвард обязателен: между loadOwnAct и этой записью акт мог закрыться в
    // соседней вкладке, и без него мы бы правили ЗАКРЫТЫЙ акт (переписав снимок
    // соглашения под уже поставленной подписью) и потратили SMS впустую.
    const consentWritten = await this.db.$transaction(async (tx) => {
      const won = await tx.signAct.updateMany({
        where: { id: act.id, status: 'pending' },
        data: { consentText, consentVersion: SIGN_CONSENT_VERSION, method: 'pep_otp' },
      });
      if (won.count === 0) return false;
      await this.logEvent(tx, act.id, 'consent', ctx, {
        version: SIGN_CONSENT_VERSION,
        pdConsent: actor.type === 'guest' ? true : undefined,
        pdConsentText:
          actor.type === 'guest' ? buildSignPdConsentText({ orgName }).slice(0, 4000) : undefined,
      });
      return true;
    });
    if (!consentWritten) {
      throw coded('Ваша подпись уже закрыта', SIGN_ERROR_CODES.alreadySigned);
    }

    const started = await this.verify.startForSign(phone, actor.type === 'user' ? actor.userId : null, ctx.ip ?? undefined);
    // Цепочку запоминаем на акте — по ней pepConfirm убедится, что подтверждают код,
    // выданный ИМЕННО под эту подпись.
    await this.db.signAct.updateMany({
      where: { id: act.id, status: 'pending' },
      data: { verifyChallengeId: started.challengeId },
    });
    await this.logEvent(this.db, act.id, 'otp_sent', ctx, { challengeId: started.challengeId });

    return {
      challengeId: started.challengeId,
      resendInSec: started.resendInSec,
      ttlSec: started.ttlSec,
      phoneMasked: started.phoneMasked,
    };
  }

  /** Шаг 2. Код верен → гасим пропуск В ТОЙ ЖЕ транзакции, что закрывает акт. */
  async pepConfirm(
    actor: SignActor,
    actId: string,
    dto: { challengeId: string; code: string },
    ctx: SignCtx,
  ): Promise<SignActStateDto> {
    const { act, request } = await this.loadOwnAct(actor, actId);
    this.assertMethodAllowed(request, 'pep_otp');
    if (!act.consentText) {
      throw coded('Сначала примите соглашение о подписании', SIGN_ERROR_CODES.consentRequired);
    }
    // Код обязан быть из цепочки, заведённой ПОД ЭТУ подпись: ПЭП равнозначна
    // собственноручной именно как «код под конкретный документ» (ст. 46 п. 4 ЦК).
    // Без этой сверки challengeId приходил от клиента и никак не соотносился с актом
    // — подтвердить одну подпись кодом, полученным под другой документ, ничего не
    // стоило, и доказать «под чем именно» был код, стало бы нечем.
    if (!act.verifyChallengeId || act.verifyChallengeId !== dto.challengeId) {
      throw coded(
        'Этот код выдан под другое подписание — запросите код заново',
        SIGN_ERROR_CODES.otpMismatch,
      );
    }

    const phone = await this.signerPhone(actor);
    const { verifyToken } = await this.verify.check(dto.challengeId, dto.code, ctx.ip ?? undefined);
    await this.logEvent(this.db, act.id, 'otp_verified', ctx).catch(() => undefined);

    return this.finalizeSigned(act.id, {
      method: 'pep_otp',
      level: 'pep',
      signedAt: new Date(),
      ctx,
      // Пропуск гасится ВНУТРИ транзакции подписи: откат = код не потрачен, и
      // человек не идёт за новым из-за нашей ошибки.
      inTx: async (tx) => {
        await this.verify.consume(tx, {
          verifyToken,
          purpose: 'sign_pep',
          expectedPhone: phone,
          expectedUserId: actor.type === 'user' ? actor.userId : undefined,
        });
      },
    });
  }

  /**
   * Согласие ВНЕШНЕГО подписанта на обработку персональных данных (ст. 8 ЗоПД).
   *
   * Нужно на любом уровне подписи, а не только у ПЭП: имя, номер и — при ЭЦП — ИИН
   * гостя мы сохраняем навсегда в любом случае. Закон требует способа, ПОЗВОЛЯЮЩЕГО
   * ПОДТВЕРДИТЬ получение согласия, поэтому оно уходит записью в append-only
   * протокол вместе со своим текстом, а не остаётся галочкой на экране.
   *
   * Соглашение сторон (`consentText` акта) здесь НЕ пишем: оно относится к ПЭП
   * (ст. 47 ЦК), а квалифицированная подпись самодостаточна и соглашения не требует.
   */
  async recordGuestPdConsent(actor: SignActor, actId: string, ctx: SignCtx): Promise<void> {
    const { request } = await this.loadOwnAct(actor, actId);
    const orgName = request.workspaceId ? await this.orgName(request.workspaceId) : null;
    await this.logEvent(this.db, actId, 'consent', ctx, {
      version: SIGN_CONSENT_VERSION,
      pdConsent: true,
      pdConsentText: buildSignPdConsentText({ orgName }).slice(0, 4000),
    });
  }

  /** Название организации заявки — гостевой странице, чтобы показанный текст совпал с сохранённым */
  async orgNameOfRequest(requestId: string): Promise<string | null> {
    const request = await this.db.signRequest.findUnique({
      where: { id: requestId },
      select: { workspaceId: true },
    });
    return request?.workspaceId ? this.orgName(request.workspaceId) : null;
  }

  private async signerPhone(actor: SignActor): Promise<string> {
    if (actor.type === 'guest') return actor.phone;
    const user = await this.db.user.findUnique({ where: { id: actor.userId }, select: { phone: true } });
    if (!user) throw new NotFoundException('Пользователь не найден');
    return user.phone;
  }

  // ============================================================
  // ЭЦП: готовый контейнер CMS (NCALayer или мост eGov Mobile)
  // ============================================================

  /**
   * Принять контейнер подписи. Один путь и для NCALayer, и для QR: разница
   * только в том, КТО его принёс, а проверяется он одинаково.
   *
   * Порядок шагов несущий: сначала полная проверка контейнера (математика,
   * цепочка, OCSP, соответствие ИМЕННО замороженным байтам), потом сверка
   * личности, и только потом — запись акта. Ни одна ветка не закрывает акт
   * «условно»: не проверили — не подписано.
   */
  async submitCms(
    actor: SignActor,
    actId: string,
    cmsBase64: string,
    method: 'ncalayer' | 'qr',
    ctx: SignCtx,
    consent?: { text: string; version: string },
  ): Promise<SignActStateDto> {
    const { act, request } = await this.loadOwnAct(actor, actId);
    this.assertMethodAllowed(request, method);

    if (!this.verifier.ecpAccepted) {
      // Fail-closed строже, чем у SMS: непроверенная подпись — это не «чуть
      // хуже», это выдача за ЭЦП того, чем она не является.
      throw new ServiceUnavailableException({
        message: 'Проверка ЭЦП недоступна — подпись принять нельзя',
        details: { code: SIGN_ERROR_CODES.verifierUnavailable },
      });
    }

    const cms = Buffer.from(cmsBase64, 'base64');
    if (cms.length === 0 || cms.length > SIGN_LIMITS.maxCmsBytes) {
      throw coded('Контейнер подписи повреждён или слишком велик', SIGN_ERROR_CODES.cmsInvalid);
    }
    await this.logEvent(this.db, act.id, 'cms_received', ctx, { bytes: cms.length, method });

    // Проверяем подпись против ЗАМОРОЖЕННЫХ байтов, а не против живого файла.
    const data = await this.readSubjectBytes(request.subjectFileId);
    const verdict = await this.verifier.verifyDetached(cms, data);
    await this.logEvent(this.db, act.id, 'chain_checked', ctx, {
      valid: verdict.valid,
      chainValid: verdict.chainValid,
      ocsp: verdict.ocsp?.status ?? null,
      driver: this.verifier.driver.name,
    });

    if (!verdict.valid) {
      await this.failAttempt(act.id, SIGN_ERROR_CODES.cmsInvalid, verdict.reason ?? 'подпись недействительна', ctx);
      throw coded(verdict.reason ?? 'Подпись недействительна', SIGN_ERROR_CODES.cmsInvalid);
    }
    if (!verdict.chainValid || verdict.ocsp?.status === 'revoked') {
      const reason = !verdict.chainValid
        ? 'сертификат не проходит проверку до корня НУЦ'
        : 'сертификат отозван';
      await this.failAttempt(act.id, SIGN_ERROR_CODES.chainInvalid, reason, ctx);
      throw coded(`Подпись не принята: ${reason}`, SIGN_ERROR_CODES.chainInvalid);
    }
    // ОТСУТСТВИЕ вердикта OCSP — это не «сертификат в порядке», а «мы не проверили».
    // Приказ № 1187 требует статуса НА МОМЕНТ ПОДПИСАНИЯ, и молча заморозить в акте
    // пустой статус значит навсегда потерять именно то доказательство, ради которого
    // вердикты и замораживаются: через год ответчик об этом сертификате не скажет
    // ничего. Отказ временный — человек повторяет попытку, когда ответчик ответит.
    if (verdict.ocsp?.status !== 'good') {
      const reason = verdict.ocsp
        ? `ответчик OCSP вернул статус «${verdict.ocsp.status}»`
        : 'ответчик OCSP не дал вердикта';
      await this.failAttempt(act.id, SIGN_ERROR_CODES.ocspUnavailable, reason, ctx);
      throw coded(
        'Не удалось подтвердить, что сертификат не отозван. Повторите попытку позже',
        SIGN_ERROR_CODES.ocspUnavailable,
      );
    }

    await this.assertIdentityMatches(actor, verdict.cert.iin, act.id, ctx);
    // ВНЕШНИЙ подписант: сертификат сверяется с предметом у потребителя (карточка
    // контрагента) — договор должен подписать тот, с кем его заключают.
    if (actor.type === 'guest') {
      const guestCheck = await this.registry
        .get(request.refType)
        ?.checkGuestCert?.(request.refId, { iin: verdict.cert.iin, bin: verdict.cert.bin });
      if (guestCheck && !guestCheck.ok) {
        const reason = guestCheck.reason ?? 'сертификат не совпадает с данными контрагента';
        await this.failAttempt(act.id, SIGN_ERROR_CODES.counterpartyMismatch, reason, ctx);
        throw coded(`Подпись не принята: ${reason}`, SIGN_ERROR_CODES.counterpartyMismatch);
      }
    }

    // Контейнер и квитанции пишем ДО финализации: строка акта ссылается на файл,
    // а не наоборот, и «подписано, но доказательства нет» невозможно.
    const cmsFile = await this.storeEvidence(request, actor, `signature-${act.id.slice(0, 8)}.cms`, cms, 'application/pkcs7-signature');
    const ocspFile = verdict.ocsp?.raw
      ? await this.storeEvidence(request, actor, `ocsp-${act.id.slice(0, 8)}.der`, verdict.ocsp.raw, 'application/ocsp-response')
      : null;
    const tspFile = verdict.tsp?.raw
      ? await this.storeEvidence(request, actor, `tsp-${act.id.slice(0, 8)}.der`, verdict.tsp.raw, 'application/timestamp-reply')
      : null;

    return this.finalizeSigned(act.id, {
      method,
      level: 'ecp',
      // Юридическое время подписи — метка доверенного времени, а не наши часы.
      signedAt: verdict.tsp?.at ?? new Date(),
      ctx,
      consent,
      cert: {
        subjectCn: verdict.cert.subjectCn,
        iin: verdict.cert.iin,
        bin: verdict.cert.bin,
        serial: verdict.cert.serial,
        issuerCn: verdict.cert.issuerCn,
        notBefore: verdict.cert.notBefore,
        notAfter: verdict.cert.notAfter,
        chainValid: verdict.chainValid,
        ocspStatus: verdict.ocsp?.status ?? null,
        ocspAt: verdict.ocsp?.at ?? null,
        tspAt: verdict.tsp?.at ?? null,
        tspSerial: verdict.tsp?.serial ?? null,
      },
      files: {
        cmsFileId: cmsFile.id,
        cmsSha256: createHash('sha256').update(cms).digest('hex'),
        ocspFileId: ocspFile?.id ?? null,
        tspFileId: tspFile?.id ?? null,
      },
    });
  }

  /**
   * Сверка личности: подписал ли человек СВОИМ ключом.
   *
   * Заполнен `users.iin` → расхождение ОТКАЗ (ловит «подписал ключом жены»).
   * Не заполнен → фактический ИИН из сертификата пишется в акт и виден в
   * протоколе: врать он не может, а обязать всех заранее вписать ИИН значило бы
   * не пустить подписывать вообще никого.
   */
  private async assertIdentityMatches(
    actor: SignActor,
    certIin: string | null,
    actId: string,
    ctx: SignCtx,
  ): Promise<void> {
    if (actor.type !== 'user' || !certIin) return;
    const user = await this.db.user.findUnique({ where: { id: actor.userId }, select: { iin: true } });
    const declared = user?.iin?.trim();
    if (!declared || declared === certIin) return;

    await this.failAttempt(
      actId,
      SIGN_ERROR_CODES.iinMismatch,
      `ИИН сертификата (${maskIin(certIin)}) не совпадает с ИИН аккаунта`,
      ctx,
    );
    throw coded(
      'Ключ ЭЦП принадлежит другому человеку: ИИН сертификата не совпадает с ИИН вашего аккаунта',
      SIGN_ERROR_CODES.iinMismatch,
    );
  }

  private async readSubjectBytes(fileId: string): Promise<Buffer> {
    const { result } = await this.files.openRawStream(fileId, null);
    return streamToBuffer(result.stream);
  }

  /** Положить доказательство файлом (профиль вне квоты и вне ретеншна) */
  private async storeEvidence(
    request: { workspaceId: string | null; createdById: string },
    actor: SignActor,
    name: string,
    bytes: Buffer,
    mime: string,
  ): Promise<{ id: string }> {
    if (bytes.length > SIGN_LIMITS.maxReceiptBytes && !name.endsWith('.cms')) {
      throw coded('Квитанция слишком велика', SIGN_ERROR_CODES.cmsInvalid);
    }
    const ownerUserId = actor.type === 'user' ? actor.userId : request.createdById;
    return withTempFile(name, bytes, (filePath) =>
      this.files.ingestLocalFile({
        path: filePath,
        name,
        mime,
        profile: SIGN_FILE_PROFILES.cms,
        ownerUserId,
        ownerType: request.workspaceId ? 'workspace' : 'user',
        ownerId: request.workspaceId ?? ownerUserId,
      }),
    );
  }

  // ============================================================
  // Отзыв заявки потребителем
  // ============================================================

  /**
   * ОТОЗВАТЬ живую заявку — сервисный вход (право дозирует ВЫЗЫВАЮЩИЙ: у ЭДО это
   * «автор или Менеджер+ отзывает отправку контрагенту»). Ждущие акты гасятся тем
   * же статусом, что при истечении срока; уже поставленные подписи остаются
   * доказательствами навсегда — отзыв закрывает СБОР, а не отменяет подписанное.
   */
  async cancelRequest(actorId: string, requestId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      // Порядок замков тот же, что у подписи, отказа и крона: сначала акты, потом
      // заявка — иначе встречная финализация даёт взаимоблокировку.
      await tx.signAct.updateMany({
        where: { requestId, status: 'pending' },
        data: { status: 'expired' },
      });
      const won = await tx.signRequest.updateMany({
        where: { id: requestId, status: 'pending' },
        data: { status: 'cancelled', completedAt: new Date() },
      });
      if (won.count === 0) {
        // Гонка с подписью/отказом/кроном: заявка уже закрыта — отзыв опоздал.
        throw coded('Заявка уже закрыта', SIGN_ERROR_CODES.requestClosed);
      }
      const acts = await tx.signAct.findMany({ where: { requestId }, select: { id: true } });
      for (const act of acts) {
        await this.logEvent(tx, act.id, 'cancelled', {}, { by: actorId }).catch(() => undefined);
      }
    });
  }

  // ============================================================
  // Отказ подписанта — тоже акт
  // ============================================================

  async decline(actor: SignActor, actId: string, dto: SignDeclineInput, ctx: SignCtx): Promise<SignActStateDto> {
    const { act } = await this.loadOwnAct(actor, actId);
    const reason = dto.reason.trim();
    if (!reason) throw coded('Укажите причину отказа', SIGN_ERROR_CODES.reasonRequired);

    await this.db.$transaction(async (tx) => {
      const won = await tx.signAct.updateMany({
        where: { id: act.id, status: 'pending' },
        data: { status: 'declined', declineReason: reason, ip: ctx.ip ?? null, userAgent: this.ua(ctx) },
      });
      if (won.count === 0) throw coded('Акт уже закрыт', SIGN_ERROR_CODES.alreadySigned);
      await this.logEvent(tx, act.id, 'declined', ctx, { reason });
      // Отказ ОДНОГО подписанта закрывает всю заявку: собирать остальные подписи
      // под документом, который уже отвергли, бессмысленно (та же логика, что у
      // отказа в согласовании).
      await tx.signRequest.updateMany({
        where: { id: act.requestId, status: 'pending' },
        data: { status: 'declined', completedAt: new Date() },
      });
      // Ждущие акты остальных гасим вместе с заявкой — ровно как это делает крон по
      // истечении срока. Иначе у них навсегда остаётся статус «ждёт подписи» под
      // документом, который уже отклонён: выхода из этого состояния нет, а живой акт
      // держит партиальный уникум и мешает завести новую подпись, когда документ
      // вернут доработанным.
      await tx.signAct.updateMany({
        where: { requestId: act.requestId, status: 'pending' },
        data: { status: 'expired' },
      });
      await this.declineStepIfNeeded(tx, act.requestId, act.id, dto.outcome ?? 'rejected', reason);
      await this.enqueueFinished(tx, act.id, 'declined', dto.outcome ?? 'rejected', reason);
    });

    return this.actState(act.id);
  }

  // ============================================================
  // Финализация: акт закрывается подписью
  // ============================================================

  private async finalizeSigned(
    actId: string,
    payload: {
      method: SignMethod;
      level: SignLevel;
      signedAt: Date;
      ctx: SignCtx;
      consent?: { text: string; version: string };
      /** Снимок сертификата в «сыром» виде (Date, а не строки): он едет в БД, не на провод */
      cert?: {
        subjectCn: string | null;
        iin: string | null;
        bin: string | null;
        serial: string | null;
        issuerCn: string | null;
        notBefore: Date | null;
        notAfter: Date | null;
        chainValid: boolean;
        ocspStatus: string | null;
        ocspAt: Date | null;
        tspAt: Date | null;
        tspSerial: string | null;
      };
      files?: { cmsFileId: string; cmsSha256: string; ocspFileId: string | null; tspFileId: string | null };
      /** Дополнительная работа В ТОЙ ЖЕ транзакции (гашение OTP-пропуска) */
      inTx?: (tx: Tx) => Promise<void>;
    },
  ): Promise<SignActStateDto> {
    await this.db.$transaction(async (tx) => {
      // Статус-гвард — единственная защита от двойного клика и гонки двух вкладок:
      // проверка в приложении её принципиально не закрывает.
      const won = await tx.signAct.updateMany({
        where: { id: actId, status: 'pending' },
        data: {
          status: 'signed',
          method: payload.method,
          level: payload.level,
          signedAt: payload.signedAt,
          ip: payload.ctx.ip ?? null,
          userAgent: this.ua(payload.ctx),
          // След неудачной попытки (выбрали не тот сертификат) — состояние ПОПЫТКИ,
          // а не акта: у подписанного акта он читался бы как «подпись принята с
          // ошибкой личности». Сама попытка остаётся в append-only протоколе.
          failureCode: null,
          ...(payload.consent
            ? { consentText: payload.consent.text, consentVersion: payload.consent.version }
            : {}),
          ...(payload.cert
            ? {
                certSubjectCn: payload.cert.subjectCn,
                certSubjectIin: payload.cert.iin,
                certSubjectBin: payload.cert.bin,
                certSerial: payload.cert.serial,
                certIssuerCn: payload.cert.issuerCn,
                certNotBefore: payload.cert.notBefore,
                certNotAfter: payload.cert.notAfter,
                chainValid: payload.cert.chainValid,
                ocspStatus: payload.cert.ocspStatus,
                ocspAt: payload.cert.ocspAt,
                tspAt: payload.cert.tspAt,
                tspSerial: payload.cert.tspSerial,
              }
            : {}),
          ...(payload.files
            ? {
                cmsFileId: payload.files.cmsFileId,
                cmsSha256: payload.files.cmsSha256,
                ocspFileId: payload.files.ocspFileId,
                tspFileId: payload.files.tspFileId,
              }
            : {}),
        },
      });
      if (won.count === 0) throw coded('Документ уже подписан', SIGN_ERROR_CODES.alreadySigned);

      if (payload.inTx) await payload.inTx(tx);
      await this.logEvent(tx, actId, 'signed', payload.ctx, { method: payload.method, level: payload.level });

      const act = await tx.signAct.findUniqueOrThrow({ where: { id: actId }, select: { requestId: true } });
      // Замок на строке заявки СЕРИАЛИЗУЕТ подсчёт (тот же приём, что у правила
      // «нужен каждый» в core/approvals). Без него двое последних подписантов,
      // нажавших в одну секунду, каждый насчитывают по одному оставшемуся ждущему
      // акту (READ COMMITTED не видит чужую незакоммиченную запись) — и заявка
      // навсегда остаётся «pending» при всех поставленных подписях, а самолечения
      // у движка нет.
      await tx.$queryRaw`SELECT id FROM sign_requests WHERE id = ${act.requestId} FOR UPDATE`;
      // Заявка закрывается, когда не осталось ни одного ждущего акта.
      const stillPending = await tx.signAct.count({ where: { requestId: act.requestId, status: 'pending' } });
      if (stillPending === 0) {
        await tx.signRequest.updateMany({
          where: { id: act.requestId, status: 'pending' },
          data: { status: 'completed', completedAt: new Date() },
        });
        // ШТАМПОВАННАЯ копия — джобом В ТОЙ ЖЕ транзакции (outbox): PDF с полосами
        // и «Листом подписей» собирается тяжёлым pdf-lib в своей очереди; обработчик
        // идемпотентен по stampedFileId и сам пропускает не-PDF предметы.
        await this.jobs.enqueue(tx, {
          type: SIGN_STAMP_JOB,
          payload: { requestId: act.requestId },
          uniqueKey: `signstamp:${act.requestId}`,
        });
      }
      // Шаг маршрута закрывается ЗДЕСЬ ЖЕ. Решение о том, закрылся ли шаг целиком
      // («нужен каждый»), принимает движок решений по своим правилам — мы лишь
      // сообщаем ему одно подтверждённое решение одного человека.
      await this.finishStepIfNeeded(tx, act.requestId, actId, payload.level);
      await this.enqueueFinished(tx, actId, 'signed', null, null);
    });

    return this.actState(actId);
  }

  /**
   * Закрыть шаг маршрута подписью — В ТОЙ ЖЕ транзакции, что закрыла акт: окна
   * «подписано, но шаг висит» не существует.
   *
   * Направление знания остаётся «sign → approvals»: движок решений о подписи
   * знает ровно одно поле `requiredSignatureKind`, а закрывающий вход
   * `decideAttested` наружу не выставлен и зовётся только отсюда.
   */
  private async finishStepIfNeeded(tx: Tx, requestId: string, actId: string, level: SignLevel): Promise<void> {
    const step = await this.stepOf(tx, requestId, actId);
    if (!step) return;
    await this.approvals.decideAttested(tx, step.stepId, step.signerUserId, {
      decision: 'approved',
      signatureKind: approvalSignatureKindOf(level),
      subjectSha256: step.subjectSha256,
      signActId: actId,
    });
  }

  /** Отказ подписанта тоже двигает маршрут — тем же закрывающим входом */
  private async declineStepIfNeeded(
    tx: Tx,
    requestId: string,
    actId: string,
    outcome: 'rejected' | 'returned',
    reason: string,
  ): Promise<void> {
    const step = await this.stepOf(tx, requestId, actId);
    if (!step) return;
    await this.approvals.decideAttested(tx, step.stepId, step.signerUserId, {
      decision: outcome,
      signatureKind: approvalSignatureKindOf(step.level),
      subjectSha256: step.subjectSha256,
      signActId: actId,
      comment: reason,
    });
  }

  /** Шаг маршрута под этим актом — или null, если заявка живёт сама по себе */
  private async stepOf(
    tx: Tx,
    requestId: string,
    actId: string,
  ): Promise<{ stepId: string; signerUserId: string; subjectSha256: string; level: SignLevel } | null> {
    const request = await tx.signRequest.findUnique({
      where: { id: requestId },
      select: { approvalStepId: true },
    });
    if (!request?.approvalStepId) return null;
    const act = await tx.signAct.findUniqueOrThrow({
      where: { id: actId },
      select: { signerUserId: true, subjectSha256: true, level: true },
    });
    // Гость шаг маршрута не закрывает: адресность шага — это люди платформы.
    if (!act.signerUserId) return null;
    return {
      stepId: request.approvalStepId,
      signerUserId: act.signerUserId,
      subjectSha256: act.subjectSha256,
      level: act.level as SignLevel,
    };
  }

  /**
   * Записать НЕПРИНЯТУЮ попытку подписи. След в append-only протоколе обязателен:
   * «пробовал подписать чужим ключом» — это ровно то, что важно потом восстановить.
   *
   * Акт при этом ОСТАЁТСЯ ждущим. Хоронить его нельзя: за отказом стоит чаще
   * всего выбранный не тот сертификат в NCALayer, и одна такая опечатка навсегда
   * лишала бы человека возможности подписать документ.
   */
  private async failAttempt(actId: string, code: string, reason: string, ctx: SignCtx): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.signAct.updateMany({
        where: { id: actId, status: 'pending' },
        data: { failureCode: code },
      });
      await this.logEvent(tx, actId, 'failed', ctx, { code, reason });
    });
  }

  /**
   * Побудка потребителя и уведомления — джобом В ТОЙ ЖЕ транзакции
   * (transactional outbox): коммит = хук гарантированно сработает, откат = его
   * не было. Звать потребителя прямо отсюда нельзя — это чужие замки внутри
   * нашей транзакции.
   */
  private async enqueueFinished(
    tx: Tx,
    actId: string,
    outcome: 'signed' | 'declined',
    approvalOutcome: 'rejected' | 'returned' | null,
    reason: string | null,
  ): Promise<void> {
    await this.jobs.enqueue(tx, {
      type: SIGN_FINISHED_JOB,
      payload: { actId, outcome, approvalOutcome, reason },
      uniqueKey: `signfin:${actId}`,
    });
  }

  // ============================================================
  // Чтение
  // ============================================================

  async actState(actId: string): Promise<SignActStateDto> {
    const act = await this.db.signAct.findUnique({
      where: { id: actId },
      include: { request: { select: { status: true } } },
    });
    if (!act) throw new NotFoundException('Акт подписи не найден');
    return {
      actId: act.id,
      status: act.status as SignActStateDto['status'],
      requestStatus: act.request.status as SignActStateDto['requestStatus'],
      signedAt: act.signedAt?.toISOString() ?? null,
      declineReason: act.declineReason,
      errorCode: act.failureCode,
    };
  }

  /** Акт зрителя — с проверкой, что акт его (поллинг статуса не должен светить чужое) */
  async myActState(actor: SignActor, actId: string): Promise<SignActStateDto> {
    await this.loadOwnAct(actor, actId, { allowClosed: true });
    return this.actState(actId);
  }

  private async loadOwnAct(
    actor: SignActor,
    actId: string,
    opts: { allowClosed?: boolean } = {},
  ): Promise<{ act: SignActRow; request: SignRequestRow }> {
    const act = await this.findAct(actId);
    if (!act) throw new NotFoundException('Акт подписи не найден');
    if (!this.isMine(act, actor)) {
      throw new ForbiddenException({
        message: 'Это не ваша подпись',
        details: { code: SIGN_ERROR_CODES.notSigner },
      });
    }
    if (!opts.allowClosed) {
      // Состояние СВОЕГО акта проверяем ПЕРВЫМ: человеку, который уже подписал,
      // «подписание закрыто» ничего не объясняет — он хочет знать, что подпись
      // его уже стоит (а закрылась заявка как раз из-за неё).
      if (act.status === 'expired') {
        // Отдельная ветка: «срок вышел» и «вы уже подписали» — разные новости, и
        // человеку важно понимать, идти ли ему за новой заявкой.
        throw coded('Срок подписания истёк', SIGN_ERROR_CODES.requestClosed);
      }
      if (act.status !== 'pending') {
        throw coded(
          act.status === 'signed' ? 'Вы уже подписали этот документ' : 'Ваша подпись уже закрыта',
          SIGN_ERROR_CODES.alreadySigned,
        );
      }
      if (act.request.status !== 'pending') {
        throw coded('Подписание закрыто', SIGN_ERROR_CODES.requestClosed);
      }
      if (this.isExpired(act.request.expiresAt)) {
        throw coded('Срок подписания истёк', SIGN_ERROR_CODES.requestClosed);
      }
    }
    return { act, request: act.request };
  }

  private findAct(actId: string) {
    return this.db.signAct.findUnique({ where: { id: actId }, include: { request: true } });
  }

  private assertMethodAllowed(request: { methods: string[] }, method: SignMethod): void {
    if (!request.methods.includes(method)) {
      throw coded('Этот способ подписания недоступен для документа', SIGN_ERROR_CODES.methodNotAllowed);
    }
    if (!this.availableMethods().includes(method)) {
      throw coded('Этот способ подписания сейчас выключен', SIGN_ERROR_CODES.methodDisabled);
    }
  }

  async serializeRequest(requestId: string, preloaded?: SignActRow[]): Promise<SignRequestDto> {
    const request = await this.db.signRequest.findUnique({
      where: { id: requestId },
      include: { acts: { orderBy: { createdAt: 'asc' } } },
    });
    if (!request) throw new NotFoundException('Заявка на подпись не найдена');
    const acts = preloaded ?? request.acts;
    const actorIds = [
      ...new Set([request.createdById, ...acts.map((a) => a.signerUserId).filter((v): v is string => !!v)]),
    ];
    return {
      id: request.id,
      refType: request.refType,
      refId: request.refId,
      refTitle: request.refTitle,
      refIcon: request.refIcon,
      workspaceId: request.workspaceId,
      level: request.level as SignLevel,
      methods: request.methods as SignMethod[],
      status: request.status as SignRequestDto['status'],
      subjectFileId: request.subjectFileId,
      subjectSha256: request.subjectSha256,
      approvalStepId: request.approvalStepId,
      createdById: request.createdById,
      createdAt: request.createdAt.toISOString(),
      expiresAt: request.expiresAt?.toISOString() ?? null,
      completedAt: request.completedAt?.toISOString() ?? null,
      acts: acts.map((a) => this.serializeAct(a)),
      actors: await this.actorsOf(actorIds),
    };
  }

  serializeAct(act: SignActRow): SignActDto {
    const hasCert = !!act.certSerial || !!act.certSubjectCn || act.chainValid !== null;
    return {
      id: act.id,
      requestId: act.requestId,
      signerType: act.signerType as SignActDto['signerType'],
      signerUserId: act.signerUserId,
      signerGuestId: act.signerGuestId,
      signerName: act.signerName,
      signerPhoneMasked: act.signerPhone ? maskPhone(act.signerPhone) : null,
      method: (act.method as SignMethod | null) ?? null,
      level: act.level as SignLevel,
      status: act.status as SignActDto['status'],
      subjectSha256: act.subjectSha256,
      certificate: hasCert
        ? {
            subjectCn: act.certSubjectCn,
            // ИИН МАСКИРОВАН И ЗДЕСЬ. Этот DTO уходит не только подписанту: блок
            // «Подписи» на карточке документа видит каждый, кому виден сам документ
            // (у вида с видимостью «команда» — вся организация). Полный ИИН там не
            // нужен никому, а маскировать его только на публичной странице значило
            // бы закрыть парадную дверь и оставить открытой служебную.
            iin: maskIin(act.certSubjectIin),
            bin: act.certSubjectBin,
            serial: act.certSerial,
            issuerCn: act.certIssuerCn,
            notBefore: act.certNotBefore?.toISOString() ?? null,
            notAfter: act.certNotAfter?.toISOString() ?? null,
            chainValid: act.chainValid ?? false,
            ocspStatus: (act.ocspStatus as SignCertificateDto['ocspStatus']) ?? null,
            ocspAt: act.ocspAt?.toISOString() ?? null,
            tspAt: act.tspAt?.toISOString() ?? null,
            tspSerial: act.tspSerial,
          }
        : null,
      consentText: act.consentText,
      consentVersion: act.consentVersion,
      signedAt: act.signedAt?.toISOString() ?? null,
      declineReason: act.declineReason,
      createdAt: act.createdAt.toISOString(),
      checkUrl:
        act.status === 'signed'
          ? signCheckUrl(process.env.WEB_URL || 'http://localhost:3000', act.id, act.checkToken)
          : null,
    };
  }

  /**
   * Блок «Подписи» на карточке потребителя.
   *
   * `opts.viewAuthorized` — потребитель УЖЕ проверил право зрителя на предмет
   * (карточка документа зовёт после своего canView). Обязателен для таких
   * вызовов не ради экономии: без него движок переспрашивает право у резолвера
   * `canView`, а тот у документов реализован как `documents.get(...)` — и зритель
   * team-вида, не участвующий в заявке, замыкал кольцо `documents.get →
   * summaryForRef → canViewRequest → documents.get`: запрос крутил БД вечно и
   * умирал только по HTTP-таймауту клиента.
   */
  async summaryForRef(
    userId: string,
    refType: string,
    refId: string,
    opts: { viewAuthorized?: boolean } = {},
  ): Promise<SignSummaryDto | null> {
    const request = await this.db.signRequest.findFirst({
      where: { refType, refId },
      orderBy: { createdAt: 'desc' },
      include: { acts: { orderBy: { createdAt: 'asc' } } },
    });
    if (!request) return null;

    const mine = request.acts.find((a) => a.signerUserId === userId && a.status === 'pending');
    if (!mine && !opts.viewAuthorized && !(await this.canViewRequest({ type: 'user', userId }, request))) {
      return null;
    }

    const actorIds = [
      ...new Set([request.createdById, ...request.acts.map((a) => a.signerUserId).filter((v): v is string => !!v)]),
    ];
    return {
      requestId: request.id,
      level: request.level as SignLevel,
      status: request.status as SignSummaryDto['status'],
      subjectSha256: request.subjectSha256,
      createdAt: request.createdAt.toISOString(),
      completedAt: request.completedAt?.toISOString() ?? null,
      acts: request.acts.map((a) => this.serializeAct(a)),
      actors: await this.actorsOf(actorIds),
      myActId: mine?.id ?? null,
      canExport: request.acts.some((a) => a.status === 'signed'),
      // Штампованная копия: право видеть = право видеть блок (проверено выше),
      // ссылка системная — тот же контракт, что у subjectView.
      //
      // `ready` считаем по ССЫЛКЕ, а не по наличию колонки: файл мог не пережить
      // уборку, и тогда «готово» без адреса — обещание кнопки, которая не работает.
      stamped: await this.stampedView(request.stampedFileId),
    };
  }

  /**
   * Срез штампованной копии для карточек. `ready` — это «ссылка есть и по ней
   * что-то отдадут», а не «в колонке лежит идентификатор»: между ними помещается
   * прибранный уборкой файл, и разница видна пользователю кнопкой, которая молча
   * ничего не скачивает. Пересборку в этом случае сделает джоб `sign.stamp`.
   */
  async stampedView(stampedFileId: string | null): Promise<{ ready: boolean; url: string | null }> {
    if (!stampedFileId) return { ready: false, url: null };
    const url = (await this.files.buildSystemDownloadUrl(stampedFileId).catch(() => null))?.url ?? null;
    return { ready: !!url, url };
  }

  // ============================================================
  // Публичная проверка (ст. 61 ЦК)
  // ============================================================

  /**
   * Открытый сервис проверки подписи. Файл при этом НЕ покидает браузер: sha256
   * считает Web Crypto, на сервер приходит только отпечаток. Байты документа мы
   * проверяющему не отдаём — их приносит он сам.
   *
   * ВЕРДИКТ открыт всем, у кого есть файл (этого и требует ст. 61 ЦК). А сырые
   * контейнеры CMS и квитанции — только пришедшему по ССЫЛКЕ ПРОВЕРКИ: внутри
   * контейнера лежит сертификат с полным ИИН, и раздавать его всякому, кому
   * переслали документ, значит раздавать персональные данные сверх того, что нужно
   * для проверки.
   */
  async check(query: SignCheckQuery): Promise<SignCheckResultDto> {
    const empty: SignCheckResultDto = { found: false, subject: null, signatures: [], downloads: [] };

    let request: (SignRequestRow & { acts: SignActRow[] }) | null = null;
    let matchedBy: SignCheckResultDto['matchedBy'] = 'subject';
    const viaToken = !!(query.actId && query.k);
    if (query.actId && query.k) {
      const act = await this.db.signAct.findUnique({
        where: { id: query.actId },
        include: { request: { include: { acts: { orderBy: { createdAt: 'asc' } } } } },
      });
      // Токен сверяем по постоянному времени? Нет: это 192-битный неугадываемый
      // идентификатор, а не пароль, — тайминг тут ничего не даёт.
      if (!act || act.checkToken !== query.k) return empty;
      request = act.request;
    } else if (query.sha256) {
      const sha = query.sha256.toLowerCase();
      const siblings = await this.db.signRequest.findMany({
        where: { subjectSha256: sha },
        orderBy: { createdAt: 'desc' },
        include: { acts: { orderBy: { createdAt: 'asc' } } },
        take: SIGN_LIMITS.pageSize,
      });
      // Под ОДНИМ отпечатком может стоять несколько заявок: документ вернули на
      // доработку и прислали снова, или подписывали разными раундами. Байты у них
      // те же, значит и подписи относятся к одному файлу — показать только
      // последнюю заявку значило бы объявить остальные подписи несуществующими у
      // человека, который держит этот файл в руках.
      if (siblings.length > 0) {
        request = {
          ...siblings[0],
          acts: siblings
            .flatMap((r) => r.acts)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
        };
      } else {
        // Проверяющий держит в руках ШТАМПОВАННУЮ копию: у неё свой отпечаток,
        // отличный от подписанного оригинала, — и без этой ветки самый частый
        // файл в обороте («Скачать со штампами») отвечал бы «подписи не найдены».
        const stamped = await this.db.signRequest.findFirst({
          where: { stampedSha256: sha },
          orderBy: { createdAt: 'desc' },
          include: { acts: { orderBy: { createdAt: 'asc' } } },
        });
        if (stamped) {
          request = stamped;
          matchedBy = 'stamped_copy';
        }
      }
    }
    if (!request) return empty;

    const signed = request.acts.filter((a) => a.status === 'signed');
    if (signed.length === 0) return empty;

    const described = await this.registry
      .get(request.refType)
      ?.describeForVerify?.(request.refId)
      .catch(() => null);

    const signatures: SignCheckSignatureDto[] = signed.map((a) => ({
      actId: a.id,
      signerName: a.signerName,
      // ИИН МАСКИРОВАН: страницу открывает всякий, кто получил файл.
      iinMasked: maskIin(a.certSubjectIin),
      orgName: a.certSubjectBin ? (a.certSubjectCn ?? null) : null,
      method: (a.method as SignMethod | null) ?? null,
      level: a.level as SignLevel,
      signedAt: a.signedAt?.toISOString() ?? null,
      issuerCn: a.certIssuerCn,
      certSerial: a.certSerial,
      certNotAfter: a.certNotAfter?.toISOString() ?? null,
      chainValid: a.chainValid,
      ocspStatus: (a.ocspStatus as SignCheckSignatureDto['ocspStatus']) ?? null,
      ocspAt: a.ocspAt?.toISOString() ?? null,
    }));

    const downloads: SignCheckResultDto['downloads'] = [];
    // СЫРЫЕ контейнеры отдаём только тому, кто пришёл по ссылке проверки (QR на
    // протоколе, манифест экспортного пакета), а не по одному отпечатку файла.
    //
    // Внутри CMS лежит сертификат, а в нём — ПОЛНЫЙ ИИН подписанта: так устроен
    // X.509, и убрать его оттуда нельзя, не сломав независимую проверку. Значит
    // управлять надо не содержимым контейнера, а тем, КОМУ мы его вручаем.
    // Отпечаток есть у всякого, кому переслали сам файл; ссылка проверки — у того,
    // кто получил протокол или пакет, то есть у стороны документа. Вердикт (кто
    // подписал, чем, когда, цела ли цепочка) по-прежнему открыт всем — ст. 61 ЦК
    // требует именно его, а не раздачи персональных данных.
    if (viaToken) {
      for (const a of signed) {
        if (a.cmsFileId) {
          downloads.push({
            kind: 'cms',
            label: `Контейнер подписи — ${a.signerName}`,
            url: (await this.files.buildSystemDownloadUrl(a.cmsFileId).catch(() => null))?.url ?? '',
          });
        }
        if (a.ocspFileId) {
          downloads.push({
            kind: 'ocsp',
            label: `Квитанция OCSP — ${a.signerName}`,
            url: (await this.files.buildSystemDownloadUrl(a.ocspFileId).catch(() => null))?.url ?? '',
          });
        }
        if (a.tspFileId) {
          downloads.push({
            kind: 'tsp',
            label: `Метка времени — ${a.signerName}`,
            url: (await this.files.buildSystemDownloadUrl(a.tspFileId).catch(() => null))?.url ?? '',
          });
        }
      }
    }

    return {
      found: true,
      matchedBy,
      subject: {
        title: described?.title ?? request.refTitle,
        kindLabel: described?.kindLabel ?? null,
        orgLabel: described?.orgLabel ?? null,
        sha256: request.subjectSha256,
      },
      signatures,
      downloads: downloads.filter((d) => d.url),
    };
  }

  // ============================================================
  // Протокол событий
  // ============================================================

  async events(actor: SignActor, actId: string): Promise<SignActEventDto[]> {
    const act = await this.findAct(actId);
    if (!act) throw new NotFoundException('Акт подписи не найден');
    const allowed =
      this.isMine(act, actor) || (await this.canViewRequest(actor, act.request));
    if (!allowed) throw new NotFoundException('Акт подписи не найден');
    const rows = await this.db.signActEvent.findMany({
      where: { actId },
      orderBy: { id: 'asc' },
      take: SIGN_LIMITS.eventsPageSize,
    });
    return rows.map(
      (e): SignActEventDto => ({
        // BigInt в БД — на проводе ВСЕГДА строка (правило платформы)
        id: e.id.toString(),
        type: e.type as SignActEventDto['type'],
        at: e.at.toISOString(),
        ip: e.ip,
        userAgent: e.userAgent,
        data: (e.data as Record<string, unknown> | null) ?? null,
      }),
    );
  }

  /** Запись в append-only протокол. Никогда не UPDATE — только INSERT. */
  async logEvent(
    tx: Tx | DatabaseService,
    actId: string,
    type: string,
    ctx: SignCtx,
    data?: Record<string, unknown>,
  ): Promise<void> {
    await tx.signActEvent.create({
      data: {
        actId,
        type,
        ip: ctx.ip ?? null,
        userAgent: this.ua(ctx),
        data: (data as Prisma.InputJsonValue) ?? undefined,
      },
    });
  }

  private ua(ctx: SignCtx): string | null {
    return ctx.userAgent ? ctx.userAgent.slice(0, 256) : null;
  }

  // ============================================================
  // Оповещения
  // ============================================================

  private async orgName(workspaceId: string): Promise<string | null> {
    const ws = await this.db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
    return ws?.name ?? null;
  }

  private async actorsOf(ids: string[]): Promise<Record<string, SignActorLite>> {
    if (ids.length === 0) return {};
    const users = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, avatar: true },
    });
    return Object.fromEntries(users.map((u) => [u.id, u as SignActorLite]));
  }

  /** Подпись уровня для уведомлений и протокола */
  levelLabel(level: SignLevel): string {
    return SIGN_LEVEL_LABELS[level].full;
  }

  // ============================================================
  // Служебное для смежных сервисов движка
  // ============================================================

  /** QR-сервису нужен акт с заявкой — читать таблицы движка снаружи нельзя */
  async loadActForQr(actor: SignActor, actId: string) {
    return this.loadOwnAct(actor, actId);
  }

  /** Тот же вход, что у NCALayer, но контейнер принёс мост eGov Mobile */
  submitCmsFromBridge(actor: SignActor, actId: string, cmsBase64: string, ctx: SignCtx) {
    return this.submitCms(actor, actId, cmsBase64, 'qr', ctx);
  }

  subjectBytes(fileId: string): Promise<Buffer> {
    return this.readSubjectBytes(fileId);
  }

  /** Акт по id вместе с заявкой — для джоба и протокола */
  actWithRequest(actId: string) {
    return this.findAct(actId);
  }
}

type SignRequestRow = PrismaSignRequest;
type SignActRow = PrismaSignAct;
