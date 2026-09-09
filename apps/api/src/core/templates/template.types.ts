import type { Locale } from '@superapp/i18n';
import type { TemplateIssueDto, TemplateTagDto } from '@superapp/shared';

/**
 * core/templates — типы драйвера рендера.
 *
 * Синтаксис шаблонов — НАШ (см. shared/constants/templates.ts), драйвер —
 * сменная деталь (приём core/docs: своя сборка редактора, core/files: драйверы
 * local|s3, core/voice: драйверы STT). Сегодня драйвер один — собственный
 * docx-рендерер; Excel встанет вторым файлом, когда дойдут счета; PDF драйвера
 * не имеет вовсе — заполненный .docx конвертирует существующий rendition-путь
 * core/docs (наша сборка Collabora).
 */

/** Значения подстановки: вложенный объект; коллекции повторов — массивы объектов */
export type TemplateValues = Record<string, unknown>;

/**
 * ЯЗЫК БЛАНКА и слова этого языка — то, чем говорит сам документ.
 *
 * Не язык зрителя и не язык запроса: приказ печатается на том языке, на
 * котором составлен, кто бы его ни открыл и из какого бы джоба он ни
 * пересобирался. Драйверы — чистые функции, каталога у них нет, поэтому
 * переводчик приезжает сюда параметром (`TemplateRenderService.printFor`).
 */
export interface TemplatePrint {
  language: Locale;
  /** Слово каталога в языке бланка. Ключ ПОЛНЫЙ: `templates.print.yes`. */
  t(key: string, values?: Record<string, string | number>): string;
}

export interface TemplateRenderOptions {
  /**
   * strict (дефолт): недостающее поле — ГРОМКИЙ отказ со списком (главный урок
   * проверки готовых библиотек: docxtemplater без nullGetter печатает слово
   * «undefined», easy-template-x молчит — для документа на печать это худший отказ).
   */
  strict?: boolean;
  /** Язык бланка и его слова — обязателен: молчаливого языка по умолчанию нет */
  print: TemplatePrint;
}

export interface TemplateRenderResult {
  bytes: Buffer;
  /** Сколько тегов подставлено (диагностика и verify) */
  replaced: number;
}

export interface TemplateExtractResult {
  tags: TemplateTagDto[];
  /** Структурные поломки самого файла/тегов — то, что видно без реестра полей */
  issues: TemplateIssueDto[];
}

/**
 * Битый шаблон: незакрытые теги, повтор вне строки таблицы, кривой ZIP…
 *
 * `message` здесь — для ЛОГА (машинные коды замечаний), а не для экрана: слова
 * замечанию подбирает `templateIssueText` там, где известен язык запроса.
 */
export class TemplateCompileError extends Error {
  constructor(public readonly issues: TemplateIssueDto[]) {
    super(
      `the template is not ready: ${issues
        .slice(0, 5)
        .map((i) => `${i.code}${i.tag ? ` ${i.tag}` : ''}`)
        .join('; ')}${issues.length > 5 ? '…' : ''}`,
    );
    this.name = 'TemplateCompileError';
  }
}

/** Данных не хватает: список путей — потребитель блокирует формирование и называет поля */
export class TemplateDataError extends Error {
  constructor(public readonly missing: string[]) {
    super(`missing data: ${missing.join(', ')}`);
    this.name = 'TemplateDataError';
  }
}

export interface TemplateRenderDriver {
  readonly format: 'docx';
  readonly mimes: readonly string[];
  /** Разобрать шаблон: все теги + структурные замечания (для компилятора и панели) */
  extractTags(template: Buffer): TemplateExtractResult;
  /** Заполнить шаблон значениями; кидает TemplateCompileError | TemplateDataError */
  render(template: Buffer, values: TemplateValues, opts: TemplateRenderOptions): TemplateRenderResult;
}
