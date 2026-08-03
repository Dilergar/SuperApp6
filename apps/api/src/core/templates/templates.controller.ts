import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TemplateFieldRegistry } from './template-field.registry';

/**
 * Панель «Что подставить» конструктора шаблонов (Этап 5) рисуется по этому
 * списку; группы статичны на процесс (реестр наполняется на старте).
 */
@ApiTags('templates')
@Controller('templates')
export class TemplatesController {
  constructor(private readonly registry: TemplateFieldRegistry) {}

  @Get('field-groups')
  @ApiOperation({ summary: 'Группы полей шаблонов (реестр): «Организация», «Сотрудник», …' })
  fieldGroups() {
    return { success: true, data: { groups: this.registry.list() } };
  }
}
