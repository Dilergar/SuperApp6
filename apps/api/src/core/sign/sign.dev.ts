import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Injectable, NotFoundException, OnModuleInit, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { signDevRequestSchema } from '@superapp/shared';
import { DatabaseService } from '../../shared/database/database.service';
import { withTempFile } from '../../shared/fs/temp-file.util';
import { FilesService } from '../files/files.service';
import { isDevEnv } from '../../shared/config/env.validation';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { SignRegistry, type SignRefProvider } from './sign.registry';
import { SignService } from './sign.service';
import { SignCron } from './sign.cron';
import { APPROVAL_DEV_REF_TYPE } from '../approvals/approvals.dev';

/** refType дев-полигона — настоящим потребителем никогда не станет */
export const SIGN_DEV_REF_TYPE = 'sign_dev';

/**
 * Дев-полигон движка подписи (прецеденты полигонов core/jobs и core/approvals):
 * чтобы движок проверялся сьютом ДО первого настоящего потребителя, а не «на
 * веру» внутри чужого кода.
 *
 * В production маршрутов просто НЕТ (модуль их не регистрирует), а не «есть, но
 * отвечают 403»: полигон умеет подписывать что угодно от чьего угодно имени.
 */
@Injectable()
export class SignDevProvider implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly registry: SignRegistry,
  ) {}

  onModuleInit(): void {
    if (!isDevEnv()) return;
    const provider: SignRefProvider = {
      resolveSubject: async (refId) => {
        const stub = await this.db.fileObject.findUnique({ where: { id: refId } });
        if (!stub) return null;
        return {
          fileId: stub.id,
          title: stub.name.replace(/\.[a-z0-9]+$/i, ''),
          icon: 'signature',
          workspaceId: null,
          ownerType: stub.ownerType as 'user' | 'workspace',
          ownerId: stub.ownerId,
        };
      },
      // Полигон: подписывать своё может тот, кто это своё загрузил.
      canRequestSign: async (userId, refId) => {
        const stub = await this.db.fileObject.findUnique({ where: { id: refId }, select: { uploaderId: true } });
        return stub?.uploaderId === userId;
      },
      canView: async (userId, refId) => {
        const stub = await this.db.fileObject.findUnique({ where: { id: refId }, select: { uploaderId: true } });
        return stub?.uploaderId === userId;
      },
      describeForVerify: async (refId: string) => {
        const stub = await this.db.fileObject.findUnique({ where: { id: refId }, select: { name: true } });
        return stub ? { title: stub.name, kindLabel: 'Тестовый документ', orgLabel: null } : null;
      },
    };
    this.registry.register(SIGN_DEV_REF_TYPE, provider);
    // Тот же резолвер под refType дев-полигона СОГЛАСОВАНИЙ: сьют проверяет связку
    // «шаг маршрута → подпись» до того, как появится первый настоящий потребитель,
    // и предметом там выступает тот же файл-заглушка (его id и есть refId заявки).
    this.registry.register(APPROVAL_DEV_REF_TYPE, provider);
  }
}

@ApiTags('Sign')
@Controller('sign/dev')
export class SignDevController {
  constructor(
    private readonly sign: SignService,
    private readonly files: FilesService,
    private readonly db: DatabaseService,
    private readonly cron: SignCron,
  ) {}

  /**
   * [dev] Состарить заявку и прогнать крон истечения — сьют проверяет хук
   * `onRequestExpired` (авто-возврат документа в черновик), не дожидаясь часа.
   */
  @Post('expire')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Истечь заявку на подпись сейчас' })
  async expire(@Body() body: unknown) {
    if (!isDevEnv()) throw new NotFoundException();
    const requestId = String((body as { requestId?: string })?.requestId ?? '');
    if (!requestId) throw new NotFoundException();
    await this.db.signRequest.updateMany({
      where: { id: requestId, status: 'pending' },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const closed = await this.cron.expireRequests();
    return { success: true, data: { closed } };
  }

  /**
   * Завести тестовый предмет и заявку на подпись за один заход. Возвращает
   * заявку целиком — verify-скрипту дальше нужен только id акта.
   */
  @Post('requests')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Тестовая заявка на подпись' })
  async createRequest(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    if (!isDevEnv()) throw new NotFoundException();
    const dto = signDevRequestSchema.parse(body);

    const title = dto.title ?? `Тестовый документ ${new Date().toISOString().slice(0, 19)}`;
    // `pdf` — сьют приносит ГОТОВЫЕ байты минимального PDF (ASCII): только с
    // PDF-предметом проверяется джоб штампа (не-PDF он честно пропускает).
    if (dto.pdf && !dto.body) throw new BadRequestException('pdf: передайте байты PDF в body');
    const ext = dto.pdf ? 'pdf' : 'txt';
    const mime = dto.pdf ? 'application/pdf' : 'text/plain';
    const bytes = Buffer.from(dto.body ?? `${title}\n\nСодержимое тестового документа.\n${randomUUID()}\n`, 'utf8');
    // Предмет — ОБЫЧНЫЙ файл (профиль `generic`), а не профиль доказательств:
    // подписывают всегда чужой живой документ, и `sign_subject` носит только
    // замороженная копия, которую движок делает сам. Разница не косметическая —
    // файлы доказательств удалить нельзя вовсе, и заглушка с таким профилем не
    // дала бы сьюту проверить главное свойство движка: заморозка переживает
    // удаление исходника.
    const stub = await withTempFile(`${title}.${ext}`, bytes, (filePath) =>
      this.files.ingestLocalFile({
        path: filePath,
        name: `${title}.${ext}`,
        mime,
        profile: 'generic',
        ownerUserId: user.sub,
      }),
    );

    const request = await this.sign.createRequest(
      user.sub,
      {
        refType: 'sign_dev',
        refId: stub.id,
        level: dto.level,
        methods: dto.methods,
        signerUserIds: dto.signerUserIds?.length ? [user.sub, ...dto.signerUserIds] : undefined,
      },
      { suppressOutcomeNotify: dto.suppressOutcomeNotify ?? false },
    );
    return { success: true, data: { request, stubFileId: stub.id } };
  }

  /** [dev] Отозвать заявку — сьют проверяет сервисный `cancelRequest` без потребителя */
  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Отозвать тестовую заявку' })
  async cancel(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    if (!isDevEnv()) throw new NotFoundException();
    const requestId = String((body as { requestId?: string })?.requestId ?? '');
    const request = await this.db.signRequest.findUnique({ where: { id: requestId }, select: { createdById: true } });
    // Полигон не дыра даже в dev: отзывать можно только своё.
    if (!request || request.createdById !== user.sub) throw new NotFoundException('Заявка не найдена');
    await this.sign.cancelRequest(user.sub, requestId);
    return { success: true, data: { cancelled: true } };
  }

  /**
   * [dev] Внутренности заявки для сьюта: статус, флаг подавления уведомлений и
   * отпечаток штампованной копии (наружу он больше нигде не отдаётся — публичная
   * проверка ПРИНИМАЕТ отпечаток, а не раздаёт его).
   */
  @Post('state')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Состояние тестовой заявки' })
  async state(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    if (!isDevEnv()) throw new NotFoundException();
    const requestId = String((body as { requestId?: string })?.requestId ?? '');
    const request = await this.db.signRequest.findUnique({
      where: { id: requestId },
      select: { createdById: true, status: true, suppressOutcomeNotify: true, stampedFileId: true, stampedSha256: true },
    });
    if (!request || request.createdById !== user.sub) throw new NotFoundException('Заявка не найдена');
    return {
      success: true,
      data: {
        status: request.status,
        suppressOutcomeNotify: request.suppressOutcomeNotify,
        stampedFileId: request.stampedFileId,
        stampedSha256: request.stampedSha256,
      },
    };
  }
}
