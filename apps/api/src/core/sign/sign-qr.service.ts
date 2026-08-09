import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as QRCode from 'qrcode';
import { SIGN_ERROR_CODES, SIGN_LIMITS, type SignQrStartDto } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { SignQrBridgeService } from './drivers/sign-qr.driver';
import { SignService, type SignActor, type SignCtx } from './sign.service';

/**
 * Подписание через eGov Mobile: одноразовые публичные URL + QR.
 *
 * Паспорт сервиса Smart Bridge ТРЕБУЕТ ограничивать такие URL по времени и по
 * числу обращений. Время — `expiresAt`; число — жёсткая статус-машина
 * `issued → claimed → submitted`, где каждый переход делает status-guarded
 * `updateMany`: второе обращение по тому же токену не отбивается проверкой в
 * приложении (её всегда можно обогнать), а просто не меняет ни одной строки.
 *
 * Токены РАЗНЫЕ на «забрать данные» и «положить подпись»: у них разные адресаты
 * и разная цена утечки, и один общий токен означал бы, что подсмотревший QR
 * может и прочитать документ, и подсунуть свою подпись.
 */
@Injectable()
export class SignQrService {
  private readonly logger = new Logger(SignQrService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly sign: SignService,
    private readonly bridge: SignQrBridgeService,
  ) {}

  /** Начать подписание по QR: завести сессию и нарисовать код */
  async start(actor: SignActor, actId: string, ctx: SignCtx): Promise<SignQrStartDto> {
    const { act, request } = await this.sign.loadActForQr(actor, actId);
    if (!request.methods.includes('qr')) {
      throw new BadRequestException({
        message: 'Подписание через eGov Mobile недоступно для документа',
        details: { code: SIGN_ERROR_CODES.methodNotAllowed },
      });
    }

    // Прошлые сессии этого акта гасим: живой QR должен быть ровно один, иначе
    // человек, отсканировавший старый код с чужого экрана, подписал бы «то же
    // самое» вторым путём.
    await this.db.signQrSession.updateMany({
      where: { actId: act.id, status: { in: ['issued', 'claimed'] } },
      data: { status: 'expired' },
    });

    const dataToken = randomBytes(SIGN_LIMITS.checkTokenBytes).toString('base64url');
    const signToken = randomBytes(SIGN_LIMITS.checkTokenBytes).toString('base64url');
    const expiresAt = new Date(Date.now() + SIGN_LIMITS.qrSessionTtlSec * 1000);

    const apiBase = (process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/+$/, '');
    const dataUrl = `${apiBase}/api/v1/sign/qr/data/${dataToken}`;
    const signUrl = `${apiBase}/api/v1/sign/qr/submit/${signToken}`;

    const procedure = await this.bridge.createProcedure({
      dataUrl,
      signUrl,
      description: `Подписание документа «${request.refTitle}»`,
      expiresAt,
    });

    const session = await this.db.signQrSession.create({
      data: { actId: act.id, dataToken, signToken, expiresAt, procedureId: procedure.procedureId ?? null },
      select: { id: true },
    });
    await this.sign.logEvent(this.db, act.id, 'qr_issued', ctx, { sessionId: session.id, driver: this.bridge.driver.name });

    return {
      sessionId: session.id,
      // QR рисует СЕРВЕР: тащить генератор в браузерный бандл незачем, а SVG
      // не требует ни canvas, ни нативных зависимостей.
      qrDataUrl: await this.renderQr(procedure.deepLink),
      deepLink: procedure.deepLink,
      expiresAt: expiresAt.toISOString(),
      pollMs: SIGN_LIMITS.qrPollMs,
      mock: !this.bridge.live,
    };
  }

  private async renderQr(text: string): Promise<string> {
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  }

  /**
   * Приложение забирает данные на подпись. Переход `issued → claimed` —
   * ОДНОРАЗОВЫЙ: повтор по тому же токену уже ничего не отдаст.
   */
  async claimData(dataToken: string): Promise<{ name: string; mime: string; base64: string; description: string }> {
    const session = await this.db.signQrSession.findUnique({
      where: { dataToken },
      include: { act: { include: { request: true } } },
    });
    if (!session) throw new NotFoundException('Сессия подписания не найдена');
    if (session.expiresAt.getTime() <= Date.now()) {
      throw this.dead();
    }
    const claimed = await this.db.signQrSession.updateMany({
      where: { id: session.id, status: 'issued' },
      data: { status: 'claimed', claimedAt: new Date() },
    });
    if (claimed.count === 0) throw this.dead();

    const request = session.act.request;
    const bytes = await this.sign.subjectBytes(request.subjectFileId);
    const file = await this.db.fileObject.findUnique({
      where: { id: request.subjectFileId },
      select: { name: true, mime: true },
    });
    await this.sign.logEvent(this.db, session.actId, 'qr_claimed', {}, { sessionId: session.id });

    return {
      name: file?.name ?? 'document.pdf',
      mime: file?.mime ?? 'application/pdf',
      base64: bytes.toString('base64'),
      description: `Подписание документа «${request.refTitle}»`,
    };
  }

  /**
   * Приложение возвращает контейнер подписи. Проверяется он ТЕМ ЖЕ путём, что и
   * подпись из NCALayer: разница только в том, кто принёс контейнер.
   */
  async submit(signToken: string, cmsBase64: string, ctx: SignCtx): Promise<{ ok: true }> {
    const session = await this.db.signQrSession.findUnique({
      where: { signToken },
      include: { act: true },
    });
    if (!session) throw new NotFoundException('Сессия подписания не найдена');
    if (session.expiresAt.getTime() <= Date.now()) throw this.dead();

    const claimed = await this.db.signQrSession.updateMany({
      where: { id: session.id, status: { in: ['issued', 'claimed'] } },
      data: { status: 'submitted', submittedAt: new Date() },
    });
    if (claimed.count === 0) throw this.dead();

    // Актор восстанавливается ИЗ АКТА, а не из запроса: у телефона нет нашей
    // сессии, и единственное, что подтверждает личность, — одноразовый токен.
    const actor: SignActor = session.act.signerUserId
      ? { type: 'user', userId: session.act.signerUserId }
      : {
          type: 'guest',
          guestId: session.act.signerGuestId ?? '',
          name: session.act.signerName,
          phone: session.act.signerPhone ?? '',
        };

    await this.sign.submitCmsFromBridge(actor, session.actId, cmsBase64, ctx);
    return { ok: true };
  }

  private dead(): BadRequestException {
    return new BadRequestException({
      message: 'Сессия подписания истекла или уже использована',
      details: { code: SIGN_ERROR_CODES.qrSessionDead },
    });
  }

  /** Протухшие сессии — крон движка (гигиена, а не безопасность: срок уже проверен) */
  async expireStale(): Promise<number> {
    const res = await this.db.signQrSession.updateMany({
      where: { status: { in: ['issued', 'claimed'] }, expiresAt: { lt: new Date() } },
      data: { status: 'expired' },
    });
    return res.count;
  }
}
