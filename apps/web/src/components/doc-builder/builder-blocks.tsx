'use client';

// ============================================================
// Схема BlockNote для конструктора документов: печатные блоки + смарт-блоки
// (реквизиты, номер и дата, подпись, разрыв страницы) + inline-чип данных.
//
// Чип атомарен: сломать тег изнутри невозможно по построению — в этом главный
// выигрыш конструктора против «скопируй {Организация.БИН} в буфер».
// ============================================================

import { useTranslations } from 'next-intl';
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from '@blocknote/core';
import { DOC_CHIP_FORMATS } from '@superapp/shared';
import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react';

/** Инлайн-чип данных: рисуется матовой пилюлей, редактируется только целиком */
const ChipInline = createReactInlineContentSpec(
  {
    type: 'chip',
    propSchema: {
      path: { default: '' },
      format: { default: '' },
      label: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => {
      const tr = useTranslations('documents');
      const { path, format, label } = props.inlineContent.props;
      const text = label || path;
      return (
        <span
          className="db-chip"
          title={format ? tr('builder.chipFormatTitle', { path, format }) : path}
          data-path={path}
        >
          {text}
          {format ? <span className="db-chip-fmt">{formatShort(format, tr)}</span> : null}
        </span>
      );
    },
  },
);

/**
 * Короткий пример формата. Само имя формата — DSL бланка («дата:долгая»),
 * а пример к нему живёт в каталоге по ключу формата.
 */
function formatShort(format: string, tr: (key: string) => string): string {
  const known = DOC_CHIP_FORMATS.find((f) => f.value === format);
  return known ? tr(`builder.chipFormatExample.${known.key}`) : format;
}

/** Смарт-блок «Реквизиты организации» — каркас шапки-бланка (данные подставит рендер) */
const RequisitesBlock = createReactBlockSpec(
  {
    type: 'requisites',
    propSchema: { showLogo: { default: true } },
    content: 'none',
  },
  {
    render: (props) => {
      const tr = useTranslations('documents');
      return (
        <div className="db-requisites" contentEditable={false}>
          <div className="db-requisites-name">{tr('builder.block.requisites')}</div>
          <div className="db-requisites-line">{tr('builder.requisitesLine')}</div>
          <label className="db-block-opt">
            <input
              type="checkbox"
              checked={props.block.props.showLogo}
              onChange={(e) =>
                props.editor.updateBlock(props.block, { props: { showLogo: e.target.checked } })
              }
            />
            {tr('builder.withLogo')}
          </label>
        </div>
      );
    },
  },
);

/** Смарт-блок «Номер и дата»: номер присвоит нода «Регистрация» на маршруте */
const DocMetaBlock = createReactBlockSpec(
  {
    type: 'docMeta',
    propSchema: { align: { default: 'left', values: ['left', 'center', 'right'] as const } },
    content: 'none',
  },
  {
    render: (props) => {
      const tr = useTranslations('documents');
      return (
        <div
          className="db-docmeta"
          contentEditable={false}
          style={{ textAlign: props.block.props.align as 'left' | 'center' | 'right' }}
          title={tr('builder.docMetaHint')}
        >
          {tr('builder.docMetaSample')}
        </div>
      );
    },
  },
);

/** Смарт-блок «Подпись» — одна строка подписанта; настройки прямо на блоке */
const SignatureBlock = createReactBlockSpec(
  {
    type: 'signature',
    propSchema: {
      // Роль по умолчанию ставит редактор при вставке — слово живёт в каталоге
      role: { default: '' },
      nameSource: { default: 'director', values: ['subject', 'director', 'counterparty', 'custom', 'none'] as const },
      customName: { default: '' },
      stamp: { default: false },
    },
    content: 'none',
  },
  {
    render: (props) => {
      const tr = useTranslations('documents');
      const { role, nameSource, customName, stamp } = props.block.props;
      const set = (patch: Record<string, unknown>) =>
        props.editor.updateBlock(props.block, { props: patch });
      return (
        <div className="db-signature" contentEditable={false}>
          <input
            className="db-sig-role"
            value={role}
            aria-label={tr('builder.signatureRoleAria')}
            onChange={(e) => set({ role: e.target.value })}
          />
          <span className="db-sig-line" aria-hidden="true" />
          <span className="db-sig-name">
            <select
              value={nameSource}
              aria-label={tr('builder.signatureNameAria')}
              onChange={(e) => set({ nameSource: e.target.value })}
            >
              <option value="director">{tr('builder.nameSource.director')}</option>
              <option value="subject">{tr('builder.nameSource.subject')}</option>
              <option value="counterparty">{tr('builder.nameSource.counterparty')}</option>
              <option value="custom">{tr('builder.nameSource.custom')}</option>
              <option value="none">{tr('builder.nameSource.none')}</option>
            </select>
            {nameSource === 'custom' && (
              <input
                className="db-sig-custom"
                value={customName}
                placeholder={tr('builder.signaturePersonPlaceholder')}
                aria-label={tr('builder.signaturePersonAria')}
                onChange={(e) => set({ customName: e.target.value })}
              />
            )}
          </span>
          <label className="db-block-opt">
            <input type="checkbox" checked={stamp} onChange={(e) => set({ stamp: e.target.checked })} />
            {tr('builder.stampMark')}
          </label>
        </div>
      );
    },
  },
);

/** Разрыв страницы: в печати начнёт новую, в редакторе — видимая линия */
const PageBreakBlock = createReactBlockSpec(
  {
    type: 'pageBreak',
    propSchema: {},
    content: 'none',
  },
  {
    render: () => {
      const tr = useTranslations('documents');
      return (
        <div className="db-pagebreak" contentEditable={false}>
          <span>{tr('builder.pageBreakMark')}</span>
        </div>
      );
    },
  },
);

/**
 * Схема печатного документа: только то, что умеет печатный рендер. Чек-листы,
 * картинки, код-блоки и т.п. сюда не входят намеренно — в PDF им превратиться не
 * во что, а блок, который «есть в редакторе, но пропадает на печати», хуже отказа.
 */
export function createBuilderSchema() {
  return BlockNoteSchema.create({
    blockSpecs: {
      paragraph: defaultBlockSpecs.paragraph,
      heading: defaultBlockSpecs.heading,
      bulletListItem: defaultBlockSpecs.bulletListItem,
      numberedListItem: defaultBlockSpecs.numberedListItem,
      table: defaultBlockSpecs.table,
      // createReactBlockSpec с 0.5x возвращает ФАБРИКУ спеки — в схему идёт вызов
      requisites: RequisitesBlock(),
      docMeta: DocMetaBlock(),
      signature: SignatureBlock(),
      pageBreak: PageBreakBlock(),
    },
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      chip: ChipInline,
    },
  });
}

export type BuilderSchema = ReturnType<typeof createBuilderSchema>;
