import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { TemplateRenderService } from './template-render.service';
import { TemplateCompileError, TemplateDataError } from './template.types';

/**
 * Дев-полигон движка шаблонов (только NODE_ENV=development/test — модуль не
 * регистрирует контроллер в production, маршрутов просто нет; прецеденты —
 * полигоны core/jobs и core/approvals). Нужен, чтобы verify-templates.cjs
 * проверял драйвер ДО первого настоящего потребителя (сервис «Документы»,
 * Этап 4), а не «на веру» внутри чужого кода.
 */

const b64 = z.string().min(4).max(30_000_000);

const renderSchema = z.object({
  docxBase64: b64,
  values: z.record(z.unknown()).optional(),
  workspaceId: z.string().uuid().optional(),
  subjectUserId: z.string().uuid().optional(),
  strict: z.boolean().optional(),
});

const compileSchema = z.object({
  docxBase64: b64,
  extraPaths: z.array(z.string()).max(200).optional(),
});

const resolveSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  subjectUserId: z.string().uuid().optional(),
  /** Внешний контур: группа «Контрагент» из справочника */
  counterpartyId: z.string().uuid().optional(),
  counterpartyContactId: z.string().uuid().optional(),
});

@ApiTags('templates')
@Controller('templates/dev')
export class TemplatesDevController {
  constructor(private readonly render: TemplateRenderService) {}

  @Post('render')
  @ApiOperation({ summary: '[dev] Заполнить docx: base64 + значения (+ контекст реестра)' })
  async devRender(@Body() body: unknown) {
    const dto = renderSchema.parse(body);
    const template = Buffer.from(dto.docxBase64, 'base64');
    try {
      const result =
        dto.workspaceId || dto.subjectUserId
          ? await this.render.renderForContext(
              template,
              { workspaceId: dto.workspaceId, subjectUserId: dto.subjectUserId },
              (dto.values as Record<string, unknown>) ?? {},
              { strict: dto.strict },
            )
          : this.render.render(template, (dto.values as Record<string, unknown>) ?? {}, {
              strict: dto.strict,
            });
      return {
        success: true,
        data: { docxBase64: result.bytes.toString('base64'), replaced: result.replaced },
      };
    } catch (e) {
      if (e instanceof TemplateCompileError) {
        throw new BadRequestException({ message: e.message, details: { code: 'template_compile', issues: e.issues } });
      }
      if (e instanceof TemplateDataError) {
        throw new BadRequestException({ message: e.message, details: { code: 'template_data', missing: e.missing } });
      }
      throw e;
    }
  }

  @Post('compile')
  @ApiOperation({ summary: '[dev] Проверить шаблон: теги + замечания (структура и реестр)' })
  devCompile(@Body() body: unknown) {
    const dto = compileSchema.parse(body);
    const result = this.render.compile(Buffer.from(dto.docxBase64, 'base64'), {
      extraPaths: dto.extraPaths,
    });
    return { success: true, data: result };
  }

  @Post('resolve')
  @ApiOperation({ summary: '[dev] Значения групп реестра для контекста (организация/сотрудник)' })
  async devResolve(@Body() body: unknown) {
    const dto = resolveSchema.parse(body);
    const values = await this.render.resolveContextValues({
      workspaceId: dto.workspaceId,
      subjectUserId: dto.subjectUserId,
      counterpartyId: dto.counterpartyId,
      counterpartyContactId: dto.counterpartyContactId,
    });
    return { success: true, data: { values } };
  }
}
