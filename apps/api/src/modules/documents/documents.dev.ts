import { BadRequestException, Body, Controller, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { DatabaseService } from '../../shared/database/database.service';
import { DocumentsService } from './documents.service';

/**
 * Дев-полигон сервиса «Документы» (ТОЛЬКО NODE_ENV=development/test — в production
 * маршрутов просто нет, прецеденты: полигоны core/jobs и core/approvals).
 *
 * Зачем: системные пути `systemRegister` / `systemFile` / `systemResolve` в проде
 * зовут НОДЫ маршрута. Проверять их «через нарисованный канвас» — значит проверять
 * заодно компилятор, движок токенов и согласования; когда такой тест падает, непонятно,
 * что именно сломалось. Полигон даёт прямой вызов ровно того метода, который зовёт нода.
 */
const resolveSchema = z.object({ outcome: z.enum(['approved', 'rejected', 'returned']) });

@ApiTags('documents')
@Controller('workspaces/:workspaceId/documents/dev')
export class DocumentsDevController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly db: DatabaseService,
  ) {}

  /**
   * [dev] Внутренние ссылки карточки — узлы Диска подшивки: сьют проверяет
   * подшивку ПРЯМЫМ чтением узла, а не только записью хроники.
   */
  @Post(':documentId/state')
  @ApiOperation({ summary: '[dev] Служебные поля карточки (узлы Диска подшивки)' })
  async state(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    await this.documents.get(user.sub, documentId); // право смотреть = право дёрнуть dev-путь
    const row = await this.db.orgDocument.findUniqueOrThrow({
      where: { id: documentId },
      select: { status: true, number: true, registryNodeId: true, personalNodeId: true },
    });
    return { success: true, data: row };
  }

  @Post(':documentId/register')
  @ApiOperation({ summary: '[dev] Присвоить номер — то же, что нода «Регистрация»' })
  async register(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    // Право смотреть документ = право дёрнуть его дев-путь: полигон не должен быть
    // дырой даже в разработке.
    await this.documents.get(user.sub, documentId);
    const number = await this.documents.systemRegister(documentId);
    return { success: true, data: { number } };
  }

  @Post(':documentId/file')
  @ApiOperation({ summary: '[dev] Подшить в дело — то же, что нода «Подшить в дело»' })
  async file(@CurrentUser() user: JwtPayload, @Param('documentId') documentId: string) {
    await this.documents.get(user.sub, documentId);
    await this.documents.systemMarkSigned(documentId);
    await this.documents.systemFile(documentId);
    return { success: true, data: { queued: true } };
  }

  @Post(':documentId/resolve')
  @ApiOperation({ summary: '[dev] Итог маршрута — то же, что хук возврата из согласований' })
  async resolve(
    @CurrentUser() user: JwtPayload,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ) {
    const dto = resolveSchema.parse(body);
    await this.documents.get(user.sub, documentId);
    await this.documents.systemResolve(documentId, dto.outcome);
    return { success: true, data: { outcome: dto.outcome } };
  }

  @Post(':documentId/generate-child')
  @ApiOperation({ summary: '[dev] Сформировать производный документ — нода «Сформировать документ»' })
  async generateChild(
    @CurrentUser() user: JwtPayload,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
  ) {
    const dto = z.object({ templateId: z.string().uuid(), title: z.string().max(200).optional() }).parse(body);
    await this.documents.get(user.sub, documentId);
    const id = await this.documents.systemGenerateChild(documentId, {
      templateId: dto.templateId,
      title: dto.title,
      actorId: user.sub,
    });
    if (!id) throw new BadRequestException('Производный документ не создан');
    return { success: true, data: { documentId: id } };
  }
}
