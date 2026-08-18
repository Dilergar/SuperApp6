// ============================================================
// Блочный конструктор документов (сервис «Документы», B2B).
//
// СВОЙ формат, а не сырой JSON редактора: провод и БД не привязываются к
// библиотеке (драйверы у нас — сменная деталь: docx-драйвер, STT, хранилище).
// Веб-конвертер в формат редактора — тонкий и живёт на клиенте.
//
// Чип данных несёт `path` В ТОМ ЖЕ формате, что теги docx-шаблонов
// («Организация.БИН», «Сотрудник.ФИО», «Документ.Номер», «Форма.<ключ>») —
// реестр групп полей и форматтеры core/templates общие для обоих видов шаблонов.
// ============================================================

export const DOC_BUILDER_VERSION = 1;

/** Жирный/курсив/подчёркивание — весь набор печатных стилей текста */
export interface BuilderTextStyles {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface BuilderInlineText {
  type: 'text';
  text: string;
  styles?: BuilderTextStyles;
}

/** Атомарный чип данных: сломать тег изнутри невозможно по построению */
export interface BuilderInlineChip {
  type: 'chip';
  props: {
    /** «Группа.Поле»: Организация.БИН | Сотрудник.ФИО | Документ.Номер | Форма.<ключ> */
    path: string;
    /** Ключ форматтера core/templates: 'дата' | 'дата:долгая' | 'прописью' | 'число' … */
    format?: string;
    /** Человеческая подпись чипа (снимок на момент вставки — переживает переименование поля) */
    label?: string;
  };
}

export type BuilderInline = BuilderInlineText | BuilderInlineChip;

export type BuilderAlign = 'left' | 'center' | 'right' | 'justify';

export interface BuilderParagraphBlock {
  id: string;
  type: 'paragraph';
  props?: { align?: BuilderAlign };
  content: BuilderInline[];
}

export interface BuilderHeadingBlock {
  id: string;
  type: 'heading';
  props: { level: 1 | 2 | 3; align?: BuilderAlign };
  content: BuilderInline[];
}

export interface BuilderListItemBlock {
  id: string;
  type: 'bulletListItem' | 'numberedListItem';
  content: BuilderInline[];
  /** Вложенные пункты (до 3 уровней — лимит в Zod) */
  children?: BuilderListItemBlock[];
}

export interface BuilderTableBlock {
  id: string;
  type: 'table';
  props?: {
    /** Ширины колонок в долях (сумма нормируется рендером); пусто — поровну */
    columnWidths?: number[];
    /** Первая строка — шапка (жирная, повторяется на новой странице при печати) */
    headerRow?: boolean;
  };
  rows: { cells: BuilderInline[][] }[];
}

/** Смарт-блок «Реквизиты организации» — шапка-бланк из анкеты организации */
export interface BuilderRequisitesBlock {
  id: string;
  type: 'requisites';
  props?: { showLogo?: boolean };
}

/** Смарт-блок «Номер и дата»: «№ ЗАЯВ-2026-005 от 08.08.2026» (номер даёт регистрация) */
export interface BuilderDocMetaBlock {
  id: string;
  type: 'docMeta';
  props?: { align?: BuilderAlign };
}

/** Смарт-блок «Подпись» — одна строка подписанта; строк ставят сколько нужно */
export interface BuilderSignatureBlock {
  id: string;
  type: 'signature';
  props: {
    /** Подпись слева от черты: должность/роль («Директор», «Работник») */
    role: string;
    /** Чьё имя печатать: сторона | директор | подписант контрагента | свой текст */
    nameSource: 'subject' | 'director' | 'counterparty' | 'custom' | 'none';
    customName?: string;
    /** Место печати «М.П.» рядом с подписью */
    stamp?: boolean;
  };
}

export interface BuilderPageBreakBlock {
  id: string;
  type: 'pageBreak';
}

export type BuilderBlock =
  | BuilderParagraphBlock
  | BuilderHeadingBlock
  | BuilderListItemBlock
  | BuilderTableBlock
  | BuilderRequisitesBlock
  | BuilderDocMetaBlock
  | BuilderSignatureBlock
  | BuilderPageBreakBlock;

export interface BuilderDoc {
  version: typeof DOC_BUILDER_VERSION;
  page?: {
    /** Нижний колонтитул печати: номера страниц «стр. N из M» */
    footer?: 'none' | 'pageNumbers';
  };
  blocks: BuilderBlock[];
}

/** Вид шаблона: загруженный Word-бланк или собранный в блочном конструкторе */
export type DocTemplateKind = 'docx' | 'builder';

/** Пустой лист нового builder-шаблона (один абзац — редактору нужна точка входа) */
export function emptyBuilderDoc(): BuilderDoc {
  return {
    version: DOC_BUILDER_VERSION,
    page: { footer: 'pageNumbers' },
    blocks: [{ id: 'p1', type: 'paragraph', content: [] }],
  };
}
