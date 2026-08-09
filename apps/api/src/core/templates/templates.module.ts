import { Global, Module } from '@nestjs/common';
import { isDevEnv } from '../../shared/config/env.validation';
import { PdfRenderService } from './pdf-render.service';
import { TemplateFieldRegistry } from './template-field.registry';
import { TemplateRenderService } from './template-render.service';
import { TemplatesController } from './templates.controller';
import { TemplatesDevController } from './templates.dev';

/**
 * core/templates — заполнение шаблонов документов (тонкая подсистема Этапа 3
 * проекта «Документы», БЕЗ своих таблиц).
 *
 * Слои: синтаксис {Организация.БИН} + компилятор + форматтеры + реестр групп
 * полей — НАШИ; драйвер рендера — сменная деталь (v1 — собственный docx-драйвер,
 * см. docx-render.driver.ts). Шаблоны клиентов написаны на нашем синтаксисе,
 * смена драйвера их не трогает.
 *
 * @Global — потребители инжектят TemplateRenderService (заполнить шаблон) и
 * TemplateFieldRegistry (зарегистрировать свою группу полей в onModuleInit).
 * Движок фич не импортирует: направление знания — от потребителя к движку.
 */
@Global()
@Module({
  controllers: isDevEnv() ? [TemplatesController, TemplatesDevController] : [TemplatesController],
  providers: [TemplateFieldRegistry, TemplateRenderService, PdfRenderService],
  exports: [TemplateFieldRegistry, TemplateRenderService, PdfRenderService],
})
export class TemplatesModule {}
