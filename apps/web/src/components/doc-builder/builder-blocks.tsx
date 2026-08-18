'use client';

// ============================================================
// Схема BlockNote для конструктора документов: печатные блоки + смарт-блоки
// (реквизиты, номер и дата, подпись, разрыв страницы) + inline-чип данных.
//
// Чип атомарен: сломать тег изнутри невозможно по построению — в этом главный
// выигрыш конструктора против «скопируй {Организация.БИН} в буфер».
// ============================================================

import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from '@blocknote/core';
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
      const { path, format, label } = props.inlineContent.props;
      const text = label || path;
      return (
        <span className="db-chip" title={format ? `${path} · формат: ${format}` : path} data-path={path}>
          {text}
          {format ? <span className="db-chip-fmt">{formatShort(format)}</span> : null}
        </span>
      );
    },
  },
);

function formatShort(format: string): string {
  switch (format) {
    case 'дата':
      return '01.02.2026';
    case 'дата:долгая':
      return '1 февраля 2026 г.';
    case 'прописью':
      return 'прописью';
    case 'прописью:число':
      return 'прописью';
    case 'число':
      return '10 000';
    default:
      return format;
  }
}

/** Смарт-блок «Реквизиты организации» — каркас шапки-бланка (данные подставит рендер) */
const RequisitesBlock = createReactBlockSpec(
  {
    type: 'requisites',
    propSchema: { showLogo: { default: true } },
    content: 'none',
  },
  {
    render: (props) => (
      <div className="db-requisites" contentEditable={false}>
        <div className="db-requisites-name">Реквизиты организации</div>
        <div className="db-requisites-line">
          Юрнаименование · БИН · адрес — подставятся из «Анкеты компании»
        </div>
        <label className="db-block-opt">
          <input
            type="checkbox"
            checked={props.block.props.showLogo}
            onChange={(e) =>
              props.editor.updateBlock(props.block, { props: { showLogo: e.target.checked } })
            }
          />
          с логотипом
        </label>
      </div>
    ),
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
    render: (props) => (
      <div
        className="db-docmeta"
        contentEditable={false}
        style={{ textAlign: props.block.props.align as 'left' | 'center' | 'right' }}
        title="Номер присвоится при регистрации документа, дата — дата документа"
      >
        № _______ от «___» ____________
      </div>
    ),
  },
);

/** Смарт-блок «Подпись» — одна строка подписанта; настройки прямо на блоке */
const SignatureBlock = createReactBlockSpec(
  {
    type: 'signature',
    propSchema: {
      role: { default: 'Директор' },
      nameSource: { default: 'director', values: ['subject', 'director', 'counterparty', 'custom', 'none'] as const },
      customName: { default: '' },
      stamp: { default: false },
    },
    content: 'none',
  },
  {
    render: (props) => {
      const { role, nameSource, customName, stamp } = props.block.props;
      const set = (patch: Record<string, unknown>) =>
        props.editor.updateBlock(props.block, { props: patch });
      return (
        <div className="db-signature" contentEditable={false}>
          <input
            className="db-sig-role"
            value={role}
            aria-label="Кто подписывает (должность или роль)"
            onChange={(e) => set({ role: e.target.value })}
          />
          <span className="db-sig-line" aria-hidden="true" />
          <span className="db-sig-name">
            <select
              value={nameSource}
              aria-label="Чьё имя печатать у подписи"
              onChange={(e) => set({ nameSource: e.target.value })}
            >
              <option value="director">Директор (из реквизитов)</option>
              <option value="subject">Сотрудник — сторона документа</option>
              <option value="counterparty">Подписант контрагента</option>
              <option value="custom">Впишу сам</option>
              <option value="none">Без имени</option>
            </select>
            {nameSource === 'custom' && (
              <input
                className="db-sig-custom"
                value={customName}
                placeholder="Фамилия и имя"
                aria-label="Имя у подписи"
                onChange={(e) => set({ customName: e.target.value })}
              />
            )}
          </span>
          <label className="db-block-opt">
            <input type="checkbox" checked={stamp} onChange={(e) => set({ stamp: e.target.checked })} />
            М.П.
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
    render: () => (
      <div className="db-pagebreak" contentEditable={false}>
        <span>разрыв страницы</span>
      </div>
    ),
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
