// ============================================================
// Шаблоны документов (core/templates) — DTO реестра полей и компилятора.
// Веб-панель «Что подставить» (Этап 5) рисуется ровно по этим формам.
// ============================================================

/** Одно поле группы: `key` — то, что стоит в теге после точки ({Организация.БИН}) */
export interface TemplateFieldSpecDto {
  key: string;
  label: string;
  /** Пример значения — подсказка в панели («480910…», «ТОО „Ромашка"») */
  example?: string;
}

/** Группа полей реестра; `tagPrefix` — то, что стоит в теге до точки */
export interface TemplateFieldGroupDto {
  key: string;
  tagPrefix: string;
  label: string;
  fields: TemplateFieldSpecDto[];
}

/** Замечание компилятора шаблона (битые теги, неизвестные поля) */
export interface TemplateIssueDto {
  code:
    | 'unclosed_tag'
    | 'stray_close'
    | 'tag_broken_by_break'
    | 'empty_tag'
    | 'unknown_field'
    | 'unknown_formatter'
    | 'repeat_unclosed'
    | 'repeat_without_open'
    | 'repeat_cross_row'
    | 'repeat_outside_table'
    | 'repeat_nested'
    | 'bad_structure';
  message: string;
  /** Сырой тег, к которому относится замечание (если применимо) */
  tag?: string;
  /** Часть файла: document | header1 | footer2 … */
  part?: string;
}

/** Извлечённый тег — для панели и валидации */
export interface TemplateTagDto {
  kind: 'field' | 'repeat_open' | 'repeat_close';
  /** Путь поля («Организация.БИН») либо ключ коллекции у повторов */
  path: string;
  formatters: { key: string; arg?: string }[];
  raw: string;
  part: string;
}
