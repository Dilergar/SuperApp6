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
import { useLocale, useTranslations } from 'next-intl';
import {
  DOC_CHIP_FORMATS,
  DOC_CHIP_FORMAT_DATE,
  DOC_FORM_TAG_PREFIX,
  docRangeTagKeys,
  type BuilderDoc,
  type DocFormFieldDto,
  type TemplateFieldGroupDto,
} from '@superapp/shared';
import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from '@blocknote/core';
import { en, ru } from '@blocknote/core/locales';
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
import { setBuilderLabels } from './labels';
import { bnToBuilderDoc, builderDocToBn } from './builder-convert';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import './builder-editor.css';

/** Смарт-блоки панели: тип и значок — данные, подпись и подсказка — каталог */
const SMART_BLOCKS: { type: string; icon: ComponentProps<typeof Icon>['name'] }[] = [
  { type: 'requisites', icon: 'workspace' },
  { type: 'docMeta', icon: 'docs' },
  { type: 'signature', icon: 'edit' },
  { type: 'table', icon: 'table' },
  { type: 'pageBreak', icon: 'file' },
];

/**
 * Чипы одного поля формы: у периода дат их четыре — «с», «по», «дней» и целиком
 * строкой «с … по …» (значение разворачивает сервер, теги остаются плоскими).
 * Даты вставляются с форматом «дата» по умолчанию — если человек не выбрал свой.
 */
function chipDefsForField(
  f: DocFormFieldDto,
  tr: (key: string, values?: Record<string, string>) => string,
): { path: string; label: string; dateFmt: boolean }[] {
  const tag = (name: string) => `${DOC_FORM_TAG_PREFIX}.${name}`;
  if (f.kind === 'daterange') {
    const [self, from, to, days] = docRangeTagKeys(f.key);
    return [
      { path: tag(from), label: tr('builder.rangeChip.from', { label: f.label }), dateFmt: true },
      { path: tag(to), label: tr('builder.rangeChip.to', { label: f.label }), dateFmt: true },
      { path: tag(days), label: tr('builder.rangeChip.days', { label: f.label }), dateFmt: false },
      { path: tag(self), label: tr('builder.rangeChip.whole', { label: f.label }), dateFmt: false },
    ];
  }
  return [{ path: tag(f.key), label: f.label, dateFmt: f.kind === 'date' }];
}

function smartBlockPayload(type: string, signatureRole: string): Record<string, unknown> {
  // Роль подписанта по умолчанию ставится ПРИ ВСТАВКЕ: схема BlockNote — модульный
  // уровень, каталога у неё нет (тот же приём, что у слоёв «Заметок»).
  if (type === 'signature') return { type, props: { role: signatureRole } };
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
  const tr = useTranslations('documents');
  const tc = useTranslations('common');
  const locale = useLocale();
  // Словарь самого BlockNote (меню, подсказки перетаскивания) идёт на языке
  // зрителя; казахского у библиотеки нет — там работает общий фолбэк на язык
  // источника, тот же, что в каталоге.
  const dictionary = useMemo(() => {
    const base = locale === 'ru' ? ru : en;
    return { ...base, placeholders: { ...base.placeholders, emptyDocument: tr('builder.emptyDocument') } };
  }, [locale, tr]);
  // Слова для НЕ-React слоёв (схема блоков, разбор) — см. `labels.ts`
  setBuilderLabels({ signatureRole: tr('builder.signatureRoleDefault') });

  const schema = useMemo(() => createBuilderSchema(), []);
  const editor = useCreateBlockNote({
    schema,
    dictionary,
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
      toastError(tr('builder.saveFailed'));
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
      const payload = smartBlockPayload(type, tr('builder.signatureRoleDefault'));
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
      toastError(e instanceof Error && e.message ? e.message : tr('builder.previewFailed'));
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
        { title: tr('builder.slash.paragraph'), subtext: tr('builder.slash.paragraphHint'), group: tr('builder.slash.textGroup'), onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'paragraph' } as never) },
        { title: tr('builder.slash.heading'), subtext: tr('builder.slash.headingHint'), group: tr('builder.slash.textGroup'), onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'heading', props: { level: 1 } } as never) },
        { title: tr('builder.slash.subheading'), subtext: tr('builder.slash.subheadingHint'), group: tr('builder.slash.textGroup'), onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'heading', props: { level: 2 } } as never) },
        { title: tr('builder.slash.list'), subtext: tr('builder.slash.listHint'), group: tr('builder.slash.textGroup'), onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'bulletListItem' } as never) },
        { title: tr('builder.slash.numbered'), subtext: '1. 2. 3.', group: tr('builder.slash.textGroup'), onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'numberedListItem' } as never) },
        ...SMART_BLOCKS.map((s) => ({
          title: tr(`builder.block.${s.type}`),
          subtext: tr(`builder.blockHint.${s.type}`),
          group: tr('builder.slash.blocksGroup'),
          onItemClick: () =>
            insertOrUpdateBlockForSlashMenu(editor, smartBlockPayload(s.type, tr('builder.signatureRoleDefault')) as never),
        })),
      ];
      return filterSuggestionItems(base, query);
    },
    [editor, tr],
  );

  const chipItems = useCallback(
    (query: string) => {
      const items: DefaultReactSuggestionItem[] = [];
      for (const group of fieldGroups) {
        for (const f of group.fields) {
          items.push({
            title: `${f.label}`,
            subtext: f.example ? tr('builder.chipExample', { group: group.label, example: f.example }) : group.label,
            group: group.label,
            onItemClick: () => insertChip(`${group.tagPrefix}.${f.key}`, f.label),
          });
        }
      }
      for (const f of formFields) {
        for (const chip of chipDefsForField(f, tr)) {
          items.push({
            title: chip.label,
            subtext: tr('builder.fromForm'),
            group: tr('builder.formGroup'),
            onItemClick: () =>
              insertChip(chip.path, chip.label, chip.dateFmt ? insertFormatRef.current || DOC_CHIP_FORMAT_DATE : undefined),
          });
        }
      }
      return filterSuggestionItems(items, query);
    },
    [fieldGroups, formFields, insertChip, tr],
  );

  return (
    <div className="db-root">
      <div className="db-topbar">
        <Chip size="sm" tone={saveState === 'error' ? 'danger' : saveState === 'saved' ? 'success' : 'neutral'}>
          {saveState === 'saved' && tr('builder.saveState.saved')}
          {saveState === 'dirty' && tr('builder.saveState.dirty')}
          {saveState === 'saving' && tr('builder.saveState.saving')}
          {saveState === 'error' && tr('builder.saveState.error')}
        </Chip>
        <div className="db-topbar-spacer" />
        <Toggle label={tr('builder.pageNumbers')} checked={footer === 'pageNumbers'} onChange={(v) => { setFooter(v ? 'pageNumbers' : 'none'); scheduleSave(); }} />
        <Button variant="matte" icon="eye" loading={previewBusy} onClick={() => { void openPreview(); }}>
          {tr('builder.preview')}
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
                { key: 'data', label: tr('builder.tab.data') },
                { key: 'form', label: tr('builder.tab.form'), count: formFields.length },
                { key: 'blocks', label: tr('builder.tab.blocks') },
              ]}
              value={panelTab}
              onChange={(k) => setPanelTab(k)}
              aria-label={tr('builder.tabsAria')}
              className="db-panel-tabs"
            />

            {panelTab === 'data' && (
              <PanelSection hint={tr('builder.dataHint')}>
                <Select
                  label={tr('builder.insertFormat')}
                  value={insertFormat}
                  onChange={setInsertFormat}
                  options={DOC_CHIP_FORMATS.map((f) => ({ value: f.value, label: tr(`builder.chipFormat.${f.key}`) }))}
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
                          title={f.example ? tr('builder.fieldExample', { label: f.label, example: f.example }) : f.label}
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
              <PanelSection hint={formHint ?? tr('builder.formHint')}>
                {formFields.length === 0 && !onAddFormField && (
                  <p className="db-panel-hint" style={{ margin: 0 }}>
                    {tr('builder.fieldsFromTemplate')}
                  </p>
                )}
                <div className="db-panel-chips">
                  {formFields.flatMap((f) =>
                    chipDefsForField(f, tr).map((chip) => (
                      <Chip
                        key={chip.path}
                        size="sm"
                        tone="accent"
                        onClick={() =>
                          insertChip(
                            chip.path,
                            chip.label,
                            chip.dateFmt ? insertFormatRef.current || DOC_CHIP_FORMAT_DATE : undefined,
                          )
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
                      const chip = chipDefsForField(f, tr)[0];
                      insertChip(
                        chip.path,
                        chip.label,
                        chip.dateFmt ? insertFormatRef.current || DOC_CHIP_FORMAT_DATE : undefined,
                      );
                    }}
                  />
                )}
              </PanelSection>
            )}

            {panelTab === 'blocks' && (
              <PanelSection hint={tr('builder.blocksHint')}>
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
                      title={tr(`builder.blockHint.${s.type}`)}
                    >
                      <Icon name={s.icon} size={16} />
                      <span>
                        <span className="db-panel-block-label">{tr(`builder.block.${s.type}`)}</span>
                        <span className="db-panel-block-hint">{tr(`builder.blockHint.${s.type}`)}</span>
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

      <Modal open={previewUrl !== null} onClose={() => setPreviewUrl(null)} title={tr('builder.preview')} size="lg">
        {previewUrl && (
          <iframe src={previewUrl} title={tr('builder.previewFrame')} className="db-preview-frame" />
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
  const tr = useTranslations('documents');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<DocFormFieldDto['kind']>('text');
  const [busy, setBusy] = useState(false);
  const key = label.trim().replace(/[{}.<>|]/g, '').replace(/\s+/g, ' ').slice(0, 60);

  if (!open) {
    return (
      <Button variant="ghost" size="sm" icon="add" onClick={() => setOpen(true)}>
        {tr('builder.addField')}
      </Button>
    );
  }
  return (
    <div className="db-addfield">
      <input
        className="db-addfield-input"
        value={label}
        placeholder={tr('builder.addFieldPlaceholder')}
        aria-label={tr('builder.addFieldAria')}
        onChange={(e) => setLabel(e.target.value)}
      />
      <select
        value={kind}
        aria-label={tr('builder.fieldKindAria')}
        onChange={(e) => setKind(e.target.value as DocFormFieldDto['kind'])}
      >
        <option value="text">{tr('fieldKind.text')}</option>
        <option value="textarea">{tr('fieldKind.textarea')}</option>
        <option value="date">{tr('fieldKind.date')}</option>
        <option value="daterange">{tr('fieldKind.daterange')}</option>
        <option value="number">{tr('fieldKind.number')}</option>
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
            toastError(e instanceof Error ? e.message : tr('builder.addFieldFailed'));
          } finally {
            setBusy(false);
          }
        }}
      >
        {tc('actions.add')}
      </Button>
    </div>
  );
}
