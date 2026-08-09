'use client';

// ============================================================
// Блочный конструктор документов (модель PandaDoc: лист как в Notion + готовые
// смарт-блоки + чипы данных). Один компонент на оба случая — шаблон и документ.
//
// Три равнозначных способа вставки: слэш-меню «/», клик по панели справа,
// перетаскивание с панели на лист (линию-цель рисует сам браузер, вставка — после
// блока, над которым отпустили). Чипы данных вставляются кликом по панели или
// набором «{» прямо в тексте.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { BuilderDoc, DocFormFieldDto, TemplateFieldGroupDto } from '@superapp/shared';
import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from '@blocknote/core';
import { ru } from '@blocknote/core/locales';
import {
  BasicTextStyleButton,
  BlockNoteView,
  FormattingToolbar,
  FormattingToolbarController,
  SuggestionMenuController,
  TextAlignButton,
  useCreateBlockNote,
  type DefaultReactSuggestionItem,
} from './blocknote-imports';
import { Button, Chip, Icon, Modal, Select, Tabs, Toggle } from '@/components/ui';
import { toastError } from '@/lib/toast';
import { createBuilderSchema } from './builder-blocks';
import { bnToBuilderDoc, builderDocToBn } from './builder-convert';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import './builder-editor.css';

const INSERT_FORMATS = [
  { value: '', label: 'Как есть' },
  { value: 'дата', label: 'Дата — 01.02.2026' },
  { value: 'дата:долгая', label: 'Дата — 1 февраля 2026 г.' },
  { value: 'прописью', label: 'Сумма прописью (тенге)' },
  { value: 'число', label: 'Число — 10 000' },
];

const SMART_BLOCKS: { type: string; label: string; hint: string; icon: ComponentProps<typeof Icon>['name'] }[] = [
  { type: 'requisites', label: 'Реквизиты организации', hint: 'Шапка-бланк: наименование, БИН, адрес', icon: 'workspace' },
  { type: 'docMeta', label: 'Номер и дата', hint: '«№ … от …» — номер присвоит регистрация', icon: 'docs' },
  { type: 'signature', label: 'Подпись', hint: 'Строка подписанта, можно несколько', icon: 'edit' },
  { type: 'table', label: 'Таблица', hint: 'Обычная таблица 3×3', icon: 'table' },
  { type: 'pageBreak', label: 'Разрыв страницы', hint: 'Дальше — с нового листа', icon: 'file' },
];

/**
 * Чипы одного поля формы: у периода дат их четыре — «с», «по», «дней» и целиком
 * строкой «с … по …» (значение разворачивает сервер, теги остаются плоскими).
 * Даты вставляются с форматом «дата» по умолчанию — если человек не выбрал свой.
 */
function chipDefsForField(f: DocFormFieldDto): { path: string; label: string; dateFmt: boolean }[] {
  if (f.kind === 'daterange') {
    return [
      { path: `Форма.${f.key} С`, label: `${f.label} · с`, dateFmt: true },
      { path: `Форма.${f.key} По`, label: `${f.label} · по`, dateFmt: true },
      { path: `Форма.${f.key} Дней`, label: `${f.label} · дней`, dateFmt: false },
      { path: `Форма.${f.key}`, label: `${f.label} · целиком`, dateFmt: false },
    ];
  }
  return [{ path: `Форма.${f.key}`, label: f.label, dateFmt: f.kind === 'date' }];
}

function smartBlockPayload(type: string): Record<string, unknown> {
  if (type === 'table') {
    return {
      type: 'table',
      content: {
        type: 'tableContent',
        rows: [{ cells: [[], [], []] }, { cells: [[], [], []] }, { cells: [[], [], []] }],
      },
    };
  }
  return { type };
}

export interface BuilderEditorProps {
  /** Блоки на старте (снимок; дальше редактор живёт своим состоянием) */
  initial: BuilderDoc;
  /** Группы данных из реестра (Организация, Сотрудник, Документ) */
  fieldGroups: TemplateFieldGroupDto[];
  /** Поля формы подачи — чипы «Форма.…» (пусто у свободного документа) */
  formFields: DocFormFieldDto[];
  /** Автосохранение (дебаунс внутри). Ошибку показывает сам редактор */
  onSave: (doc: BuilderDoc) => Promise<void>;
  /** «Пример с данными»: настоящий PDF тем же рендером, что соберёт документ */
  onPreview: (doc: BuilderDoc) => Promise<Blob>;
  /** «+ Поле» из панели: у шаблона — поле формы подачи, у свободного документа — своё поле */
  onAddFormField?: (field: DocFormFieldDto) => Promise<void>;
  /** Подпись вкладки «Форма»: у шаблона её заполняет ПОДАЮЩИЙ, у документа — сам автор */
  formHint?: string;
  readOnly?: boolean;
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

export default function BuilderEditor({
  initial,
  fieldGroups,
  formFields,
  onSave,
  onPreview,
  onAddFormField,
  formHint,
  readOnly,
}: BuilderEditorProps) {
  const schema = useMemo(() => createBuilderSchema(), []);
  const editor = useCreateBlockNote({
    schema,
    dictionary: { ...ru, placeholders: { ...ru.placeholders, emptyDocument: 'Пишите текст, «/» — блоки, «{» — данные…' } },
    initialContent: builderDocToBn(initial) as never,
  });

  const [footer, setFooter] = useState<'none' | 'pageNumbers'>(initial.page?.footer ?? 'pageNumbers');
  const footerRef = useRef(footer);
  footerRef.current = footer;

  const [insertFormat, setInsertFormat] = useState('');
  const insertFormatRef = useRef(insertFormat);
  insertFormatRef.current = insertFormat;

  /** Вкладка панели: данные / поля формы / блоки — всё в один клик, без прокрутки */
  const [panelTab, setPanelTab] = useState<'data' | 'form' | 'blocks'>('data');

  // ---- автосохранение с дебаунсом ----
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentDoc = useCallback(
    (): BuilderDoc => bnToBuilderDoc(editor.document, { footer: footerRef.current }),
    [editor],
  );
  const docRef = useRef<() => BuilderDoc>(currentDoc);
  docRef.current = currentDoc;

  const flushSave = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    setSaveState('saving');
    try {
      await onSave(docRef.current());
      setSaveState('saved');
    } catch (e) {
      setSaveState('error');
      toastError('Не удалось сохранить бланк — изменения остались только на этой странице');
      throw e;
    }
  }, [onSave]);

  const scheduleSave = useCallback(() => {
    if (readOnly) return;
    setSaveState('dirty');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      flushSave().catch(() => undefined);
    }, 1200);
  }, [flushSave, readOnly]);

  useEffect(() => {
    return () => {
      // Уход со страницы с несохранённым — дожимаем сохранение вдогонку
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        onSave(docRef.current()).catch(() => undefined);
      }
    };
  }, [onSave]);

  // ---- вставки ----
  const insertChip = useCallback(
    (path: string, label: string, format?: string) => {
      editor.insertInlineContent([
        { type: 'chip', props: { path, label, format: format ?? insertFormatRef.current } },
        ' ',
      ] as never);
      editor.focus();
      scheduleSave();
    },
    [editor, scheduleSave],
  );

  const insertSmartBlock = useCallback(
    (type: string, afterBlockId?: string) => {
      const payload = smartBlockPayload(type);
      const target = afterBlockId ?? editor.getTextCursorPosition().block.id;
      editor.insertBlocks([payload] as never, target as never, 'after');
      editor.focus();
      scheduleSave();
    },
    [editor, scheduleSave],
  );

  // Перетаскивание секции с панели: вставка после блока, над которым отпустили
  const onCanvasDrop = useCallback(
    (e: React.DragEvent) => {
      const type = e.dataTransfer.getData('application/x-sa6-builder-block');
      if (!type) return;
      e.preventDefault();
      const hit = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-id]');
      const afterId = hit?.getAttribute('data-id') ?? editor.document[editor.document.length - 1]?.id;
      if (afterId) insertSmartBlock(type, afterId);
    },
    [editor, insertSmartBlock],
  );

  // ---- превью PDF ----
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const openPreview = useCallback(async () => {
    setPreviewBusy(true);
    try {
      // Превью показывает ровно то, что на холсте, — несохранённое включительно
      const blob = await onPreview(docRef.current());
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (e) {
      toastError(e instanceof Error && e.message ? e.message : 'Не удалось собрать превью');
    } finally {
      setPreviewBusy(false);
    }
  }, [onPreview]);
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  // ---- слэш-меню и «{»-меню ----
  const slashItems = useCallback(
    (query: string) => {
      const base: DefaultReactSuggestionItem[] = [
        // Заголовок группы и пункт не должны совпадать по названию: рендер меню
        // ключует строки названием, и «Текст»+«Текст» давал duplicate-key
        { title: 'Абзац', subtext: 'Обычный текст', group: 'Текст', onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'paragraph' } as never) },
        { title: 'Заголовок', subtext: 'Название документа', group: 'Текст', onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'heading', props: { level: 1 } } as never) },
        { title: 'Подзаголовок', subtext: 'Раздел документа', group: 'Текст', onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'heading', props: { level: 2 } } as never) },
        { title: 'Список', subtext: 'Маркированный', group: 'Текст', onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'bulletListItem' } as never) },
        { title: 'Нумерованный список', subtext: '1. 2. 3.', group: 'Текст', onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'numberedListItem' } as never) },
        ...SMART_BLOCKS.map((s) => ({
          title: s.label,
          subtext: s.hint,
          group: 'Блоки документа',
          onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, smartBlockPayload(s.type) as never),
        })),
      ];
      return filterSuggestionItems(base, query);
    },
    [editor],
  );

  const chipItems = useCallback(
    (query: string) => {
      const items: DefaultReactSuggestionItem[] = [];
      for (const group of fieldGroups) {
        for (const f of group.fields) {
          items.push({
            title: `${f.label}`,
            subtext: f.example ? `${group.label} · например: ${f.example}` : group.label,
            group: group.label,
            onItemClick: () => insertChip(`${group.tagPrefix}.${f.key}`, f.label),
          });
        }
      }
      for (const f of formFields) {
        for (const chip of chipDefsForField(f)) {
          items.push({
            title: chip.label,
            subtext: 'Из формы подачи',
            group: 'Форма подачи',
            onItemClick: () =>
              insertChip(chip.path, chip.label, chip.dateFmt ? insertFormatRef.current || 'дата' : undefined),
          });
        }
      }
      return filterSuggestionItems(items, query);
    },
    [fieldGroups, formFields, insertChip],
  );

  return (
    <div className="db-root">
      <div className="db-topbar">
        <Chip size="sm" tone={saveState === 'error' ? 'danger' : saveState === 'saved' ? 'success' : 'neutral'}>
          {saveState === 'saved' && 'Сохранено'}
          {saveState === 'dirty' && 'Изменения…'}
          {saveState === 'saving' && 'Сохраняю…'}
          {saveState === 'error' && 'Ошибка сохранения'}
        </Chip>
        <div className="db-topbar-spacer" />
        <Toggle label="Номера страниц" checked={footer === 'pageNumbers'} onChange={(v) => { setFooter(v ? 'pageNumbers' : 'none'); scheduleSave(); }} />
        <Button variant="matte" icon="eye" loading={previewBusy} onClick={() => { void openPreview(); }}>
          Пример с данными
        </Button>
      </div>

      <div className="db-layout">
        <div className="db-canvas" onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-sa6-builder-block')) e.preventDefault(); }} onDrop={onCanvasDrop}>
          <div className="db-page">
            <BlockNoteView
              editor={editor}
              editable={!readOnly}
              theme="light"
              formattingToolbar={false}
              slashMenu={false}
              onChange={scheduleSave}
            >
              <FormattingToolbarController
                formattingToolbar={() => (
                  <FormattingToolbar>
                    <BasicTextStyleButton basicTextStyle="bold" key="bold" />
                    <BasicTextStyleButton basicTextStyle="italic" key="italic" />
                    <BasicTextStyleButton basicTextStyle="underline" key="underline" />
                    <TextAlignButton textAlignment="left" key="left" />
                    <TextAlignButton textAlignment="center" key="center" />
                    <TextAlignButton textAlignment="right" key="right" />
                    <TextAlignButton textAlignment="justify" key="justify" />
                  </FormattingToolbar>
                )}
              />
              <SuggestionMenuController triggerCharacter="/" getItems={async (q) => slashItems(q)} />
              <SuggestionMenuController triggerCharacter="{" getItems={async (q) => chipItems(q)} />
            </BlockNoteView>
          </div>
        </div>

        {!readOnly && (
          /* Панель — ВКЛАДКАМИ, а не тремя секциями подряд: групп данных много
             (тридцать чипов), и «Форма подачи» с «Блоками» уезжали за нижнюю
             границу экрана — человек их просто не находил. */
          <aside className="db-panel">
            <Tabs
              items={[
                // Без иконок: панель узкая (300px), и с ними третья вкладка
                // обрезалась по краю — проверено в браузере
                { key: 'data', label: 'Данные' },
                { key: 'form', label: 'Форма', count: formFields.length },
                { key: 'blocks', label: 'Блоки' },
              ]}
              value={panelTab}
              onChange={(k) => setPanelTab(k)}
              aria-label="Что вставить в документ"
              className="db-panel-tabs"
            />

            {panelTab === 'data' && (
              <PanelSection hint="Клик — вставить в текст. Или наберите «{» прямо на листе.">
                <Select
                  label="Формат вставки"
                  value={insertFormat}
                  onChange={setInsertFormat}
                  options={INSERT_FORMATS}
                />
                {fieldGroups.map((group) => (
                  <div key={group.key} className="db-panel-group">
                    <div className="db-panel-group-title">{group.label}</div>
                    <div className="db-panel-chips">
                      {group.fields.map((f) => (
                        <Chip
                          key={f.key}
                          size="sm"
                          onClick={() => insertChip(`${group.tagPrefix}.${f.key}`, f.label)}
                          title={f.example ? `${f.label} — пример: ${f.example}` : f.label}
                        >
                          {f.label}
                        </Chip>
                      ))}
                    </div>
                  </div>
                ))}
              </PanelSection>
            )}

            {panelTab === 'form' && (
              <PanelSection hint={formHint ?? 'Это заполнит человек при подаче — и значение встанет в документ.'}>
                {formFields.length === 0 && !onAddFormField && (
                  <p className="db-panel-hint" style={{ margin: 0 }}>
                    Поля задаёт шаблон этого документа — открыть его может Менеджер+ в разделе
                    «Шаблоны». Значения полей заполняются на карточке документа.
                  </p>
                )}
                <div className="db-panel-chips">
                  {formFields.flatMap((f) =>
                    chipDefsForField(f).map((chip) => (
                      <Chip
                        key={chip.path}
                        size="sm"
                        tone="accent"
                        onClick={() =>
                          insertChip(chip.path, chip.label, chip.dateFmt ? insertFormatRef.current || 'дата' : undefined)
                        }
                      >
                        {chip.label}
                      </Chip>
                    )),
                  )}
                </div>
                {onAddFormField && (
                  <AddFormField
                    onAdd={async (f) => {
                      await onAddFormField(f);
                      // Сразу и чип в текст: у периода — первый («с»), с датным форматом
                      const chip = chipDefsForField(f)[0];
                      insertChip(chip.path, chip.label, chip.dateFmt ? insertFormatRef.current || 'дата' : undefined);
                    }}
                  />
                )}
              </PanelSection>
            )}

            {panelTab === 'blocks' && (
              <PanelSection hint="Клик — вставить после курсора. Или перетащите на лист.">
                <div className="db-panel-blocks">
                  {SMART_BLOCKS.map((s) => (
                    <button
                      key={s.type}
                      type="button"
                      className="db-panel-block"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/x-sa6-builder-block', s.type);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onClick={() => insertSmartBlock(s.type)}
                      title={s.hint}
                    >
                      <Icon name={s.icon} size={16} />
                      <span>
                        <span className="db-panel-block-label">{s.label}</span>
                        <span className="db-panel-block-hint">{s.hint}</span>
                      </span>
                      <Icon name="drag" size={14} className="db-panel-block-grip" />
                    </button>
                  ))}
                </div>
              </PanelSection>
            )}
          </aside>
        )}
      </div>

      <Modal open={previewUrl !== null} onClose={() => setPreviewUrl(null)} title="Пример с данными" size="lg">
        {previewUrl && (
          <iframe src={previewUrl} title="PDF-превью документа" className="db-preview-frame" />
        )}
      </Modal>
    </div>
  );
}

function PanelSection({ title, hint, children }: { title?: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="db-panel-section">
      {/* Заголовок необязателен: у вкладок панели его роль играет сама вкладка,
          и второй раз повторять слово «Данные» под кнопкой «Данные» — шум */}
      {title && <h3 className="db-panel-title">{title}</h3>}
      {hint && <p className="db-panel-hint">{hint}</p>}
      {children}
    </section>
  );
}

/** Мини-форма «+ Поле формы»: подпись → ключ-тег чистится сам */
function AddFormField({ onAdd }: { onAdd: (f: DocFormFieldDto) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<DocFormFieldDto['kind']>('text');
  const [busy, setBusy] = useState(false);
  const key = label.trim().replace(/[{}.<>|]/g, '').replace(/\s+/g, ' ').slice(0, 60);

  if (!open) {
    return (
      <Button variant="ghost" size="sm" icon="add" onClick={() => setOpen(true)}>
        Поле формы
      </Button>
    );
  }
  return (
    <div className="db-addfield">
      <input
        className="db-addfield-input"
        value={label}
        placeholder="Подпись поля, например «Дата начала»"
        aria-label="Подпись нового поля формы"
        onChange={(e) => setLabel(e.target.value)}
      />
      <select value={kind} aria-label="Тип поля" onChange={(e) => setKind(e.target.value as DocFormFieldDto['kind'])}>
        <option value="text">Текст</option>
        <option value="textarea">Длинный текст</option>
        <option value="date">Дата</option>
        <option value="daterange">Период дат (с … по …)</option>
        <option value="number">Число</option>
      </select>
      <Button
        size="sm"
        variant="matte"
        loading={busy}
        disabled={!key}
        onClick={async () => {
          setBusy(true);
          try {
            await onAdd({ key, label: label.trim(), kind, required: true });
            setLabel('');
            setOpen(false);
          } catch (e) {
            toastError(e instanceof Error ? e.message : 'Не удалось добавить поле');
          } finally {
            setBusy(false);
          }
        }}
      >
        Добавить
      </Button>
    </div>
  );
}
