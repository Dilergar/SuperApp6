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

export interface TemplateRenderOptions {
  /**
   * strict (дефолт): недостающее поле — ГРОМКИЙ отказ со списком (главный урок
   * проверки готовых библиотек: docxtemplater без nullGetter печатает слово
   * «undefined», easy-template-x молчит — для документа на печать это худший отказ).
   */
  strict?: boolean;
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

/** Битый шаблон: незакрытые теги, повтор вне строки таблицы, кривой ZIP… */
export class TemplateCompileError extends Error {
  constructor(public readonly issues: TemplateIssueDto[]) {
    super(
      `Шаблон не готов к заполнению: ${issues
        .slice(0, 5)
        .map((i) => i.message)
        .join('; ')}${issues.length > 5 ? '…' : ''}`,
    );
    this.name = 'TemplateCompileError';
  }
}

/** Данных не хватает: список путей — потребитель блокирует формирование и называет поля */
export class TemplateDataError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Не хватает данных для заполнения: ${missing.join(', ')}`);
    this.name = 'TemplateDataError';
  }
}

export interface TemplateRenderDriver {
  readonly format: 'docx';
  readonly mimes: readonly string[];
  /** Разобрать шаблон: все теги + структурные замечания (для компилятора и панели) */
  extractTags(template: Buffer): TemplateExtractResult;
  /** Заполнить шаблон значениями; кидает TemplateCompileError | TemplateDataError */
  render(template: Buffer, values: TemplateValues, opts?: TemplateRenderOptions): TemplateRenderResult;
}
