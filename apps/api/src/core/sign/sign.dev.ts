import { Body, Controller, HttpCode, HttpStatus, Injectable, NotFoundException, OnModuleInit, Post } from '@nestjs/common';
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
  ) {}

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
    const bytes = Buffer.from(dto.body ?? `${title}\n\nСодержимое тестового документа.\n${randomUUID()}\n`, 'utf8');
    // Предмет — ОБЫЧНЫЙ файл (профиль `generic`), а не профиль доказательств:
    // подписывают всегда чужой живой документ, и `sign_subject` носит только
    // замороженная копия, которую движок делает сам. Разница не косметическая —
    // файлы доказательств удалить нельзя вовсе, и заглушка с таким профилем не
    // дала бы сьюту проверить главное свойство движка: заморозка переживает
    // удаление исходника.
    const stub = await withTempFile(`${title}.txt`, bytes, (filePath) =>
      this.files.ingestLocalFile({
        path: filePath,
        name: `${title}.txt`,
        mime: 'text/plain',
        profile: 'generic',
        ownerUserId: user.sub,
      }),
    );

    const request = await this.sign.createRequest(user.sub, {
      refType: 'sign_dev',
      refId: stub.id,
      level: dto.level,
      methods: dto.methods,
      signerUserIds: dto.signerUserIds?.length ? [user.sub, ...dto.signerUserIds] : undefined,
    });
    return { success: true, data: { request, stubFileId: stub.id } };
  }
}
