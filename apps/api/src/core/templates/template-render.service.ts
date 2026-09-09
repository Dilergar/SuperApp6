import { Injectable } from '@nestjs/common';
import { buffer as streamToBuffer } from 'node:stream/consumers';
import type { Locale } from '@superapp/i18n';
import type { TemplateIssueDto, TemplateTagDto } from '@superapp/shared';
import { I18nService } from '../../shared/i18n/i18n.service';
import { FilesService } from '../files/files.service';
import { docxRenderDriver } from './docx-render.driver';
import { checkTagsAgainstRegistry } from './template-compiler';
import { templateIssueText } from './template-issue.text';
import { TemplateFieldRegistry, type TemplateFieldContext } from './template-field.registry';
import type {
  TemplatePrint,
  TemplateRenderOptions,
  TemplateRenderResult,
  TemplateValues,
} from './template.types';

/**
 * core/templates — заполнение шаблонов документов. Тонкая подсистема БЕЗ своих
 * таблиц: синтаксис + компилятор + форматтеры наши, драйвер рендера — сменная
 * деталь (v1 — собственный docx; Excel встанет вторым драйвером при счетах;
 * PDF — существующая конвертация core/docs, драйвера не имеет).
 */
@Injectable()
export class TemplateRenderService {
  constructor(
    private readonly registry: TemplateFieldRegistry,
    private readonly files: FilesService,
    private readonly i18n: I18nService,
  ) {}

  /**
   * Слова ЯЗЫКА БЛАНКА для драйверов. Драйверы — чистые функции без каталога,
   * поэтому переводчик приезжает к ним параметром; язык берётся у самого
   * документа (`OrgDocument.language`), а не у зрителя и не у запроса.
   */
  printFor(language: Locale): TemplatePrint {
    return {
      language,
      t: (key, values) => this.i18n.translateFor(language, key, values),
    };
  }

  /** Замечание СЛОВАМИ в языке запроса — одна точка выхода на весь движок. */
  issueText(issue: TemplateIssueDto): string {
    return templateIssueText(this.i18n, issue);
  }

  /** Те же замечания, но с готовой фразой в `message` — для витрин и отказов. */
  withText(issues: TemplateIssueDto[]): TemplateIssueDto[] {
    return issues.map((i) => ({ ...i, message: this.issueText(i) }));
  }

  /**
   * Проверить шаблон: структура + сверка тегов с реестром. НЕ бросает —
   * отдаёт полный список замечаний (автор чинит всё за один заход).
   */
  compile(template: Buffer, opts?: { extraPaths?: string[] }): {
    tags: TemplateTagDto[];
    issues: TemplateIssueDto[];
  } {
    const extract = docxRenderDriver.extractTags(template);
    const { tags, issues } = checkTagsAgainstRegistry(extract, this.registry, opts?.extraPaths ?? []);
    return { tags, issues: this.withText(issues) };
  }

  /** Заполнить шаблон готовыми значениями; кидает TemplateCompileError | TemplateDataError */
  render(template: Buffer, values: TemplateValues, opts: TemplateRenderOptions): TemplateRenderResult {
    return docxRenderDriver.render(template, values, opts);
  }

  /** Значения групп реестра для контекста (организация, сотрудник, …) */
  resolveContextValues(ctx: TemplateFieldContext): Promise<Record<string, unknown>> {
    return this.registry.resolveValues(ctx);
  }

  /**
   * Заполнить шаблон в контексте: значения потребителя (поля формы, «Документ.…»)
   * плюс значения групп реестра ПОВЕРХ них.
   *
   * Порядок именно такой, потому что extraValues у единственного потребителя — это
   * данные, которые ввёл ЧЕЛОВЕК. Пока они ложились верхним слоем, поле формы с
   * ключом «Организация» подменяло реквизиты целиком, и подставной БИН попадал в
   * официальный документ. Группа, которая ничего не вернула (её resolve отдал null),
   * значения потребителя не затирает — на этом держится группа «Документ», которую
   * заполняет сам сервис.
   */
  async renderForContext(
    template: Buffer,
    ctx: TemplateFieldContext,
    extraValues: TemplateValues | undefined,
    opts: TemplateRenderOptions,
  ): Promise<TemplateRenderResult> {
    const values = { ...(extraValues ?? {}), ...(await this.registry.resolveValues(ctx)) };
    return this.render(template, values, opts);
  }

  /**
   * То же по файлу движка файлов. Контракт `system*`: ПРАВА ПРОВЕРИЛ ВЫЗЫВАЮЩИЙ
   * (Этап 4 — сервис «Документы» проверяет право формировать по шаблону);
   * заражённый/неготовый файл движок файлов не отдаст сам.
   */
  async systemRenderFileForContext(
    fileId: string,
    ctx: TemplateFieldContext,
    extraValues: TemplateValues | undefined,
    opts: TemplateRenderOptions,
  ): Promise<TemplateRenderResult> {
    const { result } = await this.files.openRawStream(fileId, null);
    const bytes = await streamToBuffer(result.stream);
    return this.renderForContext(bytes, ctx, extraValues, opts);
  }
}
