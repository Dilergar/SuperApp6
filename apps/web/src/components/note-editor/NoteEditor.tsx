'use client';

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, forwardRef } from 'react';
import { DOMParser as PMDOMParser, Slice, type Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { useTranslations } from 'next-intl';
import { canonicalNoteJson, markdownToNoteDoc, type NoteDoc, type NoteSpaceRef } from '@superapp/shared';
import { toastError } from '@/lib/toast';
import { noteEditorLabels, setNoteEditorLabels } from './labels';
import { basePlugins, cmd, insertTextAtCaret, replaceRangeWithNode, runSlashCommand, snapshot, type EditorSnapshot } from './plugins';
import { fromNoteDoc, noteSchema, toNoteDoc } from './schema';
import { buildNodeViews, NodeViewPortals, PortalRegistry } from './node-views';
import { detectSuggestion, type SuggestionMatch } from './suggestion';
import { SuggestionMenu, type SuggestionController, type SuggestionItem } from './SuggestionMenu';
import { EditorToolbar } from './EditorToolbar';
import './note-editor.css';

// ============================================================
// NoteEditor — собственный редактор заметок поверх ProseMirror-ядра.
//
// Контракт: `value` (NoteDoc) на входе, `onChange(doc)` на каждое изменение (родитель
// сам дебаунсит сохранение), внешняя смена `value` (409 → свежая версия) заменяет
// документ. Всё, что UI знает о состоянии текста, приходит снимком `snapshot()`.
//
// Ctrl+B и другие наши сочетания гасят всплытие: у каркаса приложения Ctrl+B сворачивает
// сайдбар, и без этого «жирный» дёргал бы навигацию.
// ============================================================

export interface NoteEditorHandle {
  focus(): void;
  insertText(text: string): void;
  view(): EditorView | null;
}

export interface NoteEditorProps {
  value: NoteDoc;
  onChange: (doc: NoteDoc) => void;
  /** Стикер: без фиксированной панели, компактные отступы */
  compact?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Пространство — источник кандидатов @ и [[ */
  scope: NoteSpaceRef;
  noteId?: string;
  /** Загрузка картинки (родитель знает профиль и организацию) → fileId */
  onUploadImage?: (file: File) => Promise<string>;
  /** Кандидаты `#` — теги пространства */
  tags?: string[];
  onWikilinkOpen?: (noteId: string) => void;
  onTagClick?: (name: string) => void;
  /** Дополнительные кнопки справа в панели (микрофон) */
  toolbarExtra?: React.ReactNode;
  className?: string;
}

const OUR_KEYS = new Set(['b', 'i', 'u', 'e', 'k', 'z', 'y']);

export const NoteEditor = forwardRef<NoteEditorHandle, NoteEditorProps>(function NoteEditor(
  { value, onChange, compact = false, readOnly = false, placeholder, autoFocus, scope, noteId, onUploadImage, tags, onWikilinkOpen, onTagClick, toolbarExtra, className },
  ref,
) {
  const t = useTranslations('notes');
  // Слова для схемы и плагинов кладём ДО построения EditorView: они читаются в
  // момент отрисовки узла, а хука каталога в тех модулях быть не может (см. labels.ts).
  setNoteEditorLabels({
    title: t('editor.titlePlaceholder'),
    blockedLink: t('editor.linkBlocked'),
    done: t('editor.done'),
    imageNoRights: t('editor.imageNoRights'),
    imageFailed: t('editor.imageFailed'),
  });
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const registry = useMemo(() => new PortalRegistry(), []);
  const [snap, setSnap] = useState<EditorSnapshot | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestionMatch | null>(null);
  const suggestionCtl = useRef<SuggestionController | null>(null);
  const lastEmitted = useRef<string>(canonicalNoteJson(value));
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const uploadRef = useRef(onUploadImage);
  uploadRef.current = onUploadImage;
  const optsRef = useRef({ readOnly, onWikilinkOpen, onTagClick });
  optsRef.current = { readOnly, onWikilinkOpen, onTagClick };

  // ---- монтирование EditorView (один раз на жизнь компонента)
  useLayoutEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const state = EditorState.create({
      doc: fromNoteDoc(value),
      plugins: basePlugins(placeholder ?? t('editor.placeholder')),
    });
    const view = new EditorView(mount, {
      state,
      editable: () => !optsRef.current.readOnly,
      nodeViews: buildNodeViews(registry, {
        readOnly: optsRef.current.readOnly,
        onWikilinkOpen: (id) => optsRef.current.onWikilinkOpen?.(id),
        onTagClick: (name) => optsRef.current.onTagClick?.(name),
      }),
      dispatchTransaction(tr: Transaction) {
        const next = view.state.apply(tr);
        view.updateState(next);
        setSnap(snapshot(next));
        setSuggestion(detectSuggestion(next));
        if (tr.docChanged) {
          const doc = toNoteDoc(next.doc);
          const json = canonicalNoteJson(doc);
          if (json !== lastEmitted.current) {
            lastEmitted.current = json;
            onChangeRef.current(doc);
          }
        }
      },
      handleKeyDown(v, event) {
        // Меню подсказок перехватывает стрелки/Enter/Esc/Tab
        if (suggestionCtl.current?.onKeyDown(event)) return true;
        // Наши сочетания не должны доходить до каркаса (Ctrl+B = сайдбар)
        if ((event.ctrlKey || event.metaKey) && OUR_KEYS.has(event.key.toLowerCase())) event.stopPropagation();
        return false;
      },
      handlePaste(v, event, slice) {
        return handlePaste(v, event, slice, uploadRef.current);
      },
      handleDrop(v, event) {
        return handleDropFiles(v, event as DragEvent, uploadRef.current);
      },
      handleDOMEvents: {
        keydown: (v, e) => {
          if ((e.ctrlKey || e.metaKey) && OUR_KEYS.has(e.key.toLowerCase())) e.stopPropagation();
          return false;
        },
      },
      attributes: { class: `ne-content${compact ? ' ne-content--compact' : ''}`, spellcheck: 'true' },
    });
    viewRef.current = view;
    setSnap(snapshot(state));
    if (autoFocus) requestAnimationFrame(() => view.focus());
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- внешняя смена документа (свежая версия после 409, чужая правка)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const incoming = canonicalNoteJson(value);
    if (incoming === lastEmitted.current) return;
    lastEmitted.current = incoming;
    const doc = fromNoteDoc(value);
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content).setMeta('addToHistory', false);
    view.updateState(view.state.apply(tr));
    setSnap(snapshot(view.state));
  }, [value]);

  useEffect(() => {
    viewRef.current?.setProps({ editable: () => !readOnly });
  }, [readOnly]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      insertText: (text: string) => {
        if (viewRef.current) insertTextAtCaret(viewRef.current, text);
      },
      view: () => viewRef.current,
    }),
    [],
  );

  // ---- выбор из меню подсказок
  const onPick = useCallback(
    (item: SuggestionItem, match: SuggestionMatch) => {
      const view = viewRef.current;
      if (!view) return;
      if (item.kind === 'mention') {
        replaceRangeWithNode(view, match.from, match.to, noteSchema.nodes.mention.create({ userId: item.id, name: item.title }));
      } else if (item.kind === 'wikilink') {
        replaceRangeWithNode(view, match.from, match.to, noteSchema.nodes.wikilink.create({ noteId: item.id, title: item.title }));
      } else if (item.kind === 'tag') {
        replaceRangeWithNode(view, match.from, match.to, noteSchema.nodes.tag.create({ name: item.id }));
      } else if (item.kind === 'slash' && item.command) {
        if (item.id === 'image') {
          view.dispatch(view.state.tr.delete(match.from, match.to));
          pickImage(view, uploadRef.current);
        } else runSlashCommand(view, match.from, match.to, item.command);
      }
      setSuggestion(null);
    },
    [],
  );

  const runCommand = useCallback((command: (state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView) => boolean) => {
    const view = viewRef.current;
    if (!view) return;
    command(view.state, view.dispatch, view);
    view.focus();
  }, []);

  const uploadFromToolbar = useCallback(() => {
    const view = viewRef.current;
    if (view) pickImage(view, uploadRef.current);
  }, []);

  return (
    <div className={`ne-root${compact ? ' ne-root--compact' : ''}${className ? ` ${className}` : ''}`}>
      {!readOnly && (
        <EditorToolbar snap={snap} compact={compact} onCommand={runCommand} onImage={uploadFromToolbar} canUpload={!!onUploadImage} extra={toolbarExtra} />
      )}
      <div ref={mountRef} className="ne-mount" />
      <NodeViewPortals registry={registry} />
      {suggestion && !readOnly && (
        <SuggestionMenu
          match={suggestion}
          view={viewRef.current}
          scope={scope}
          noteId={noteId}
          tags={tags ?? []}
          canUpload={!!onUploadImage}
          onPick={onPick}
          onClose={() => setSuggestion(null)}
          controllerRef={suggestionCtl}
        />
      )}
    </div>
  );
});

// ---------------------------------------------------------------- вставка / перетаскивание

const MD_HINT = /(^|\n)(#{1,3} |[-*+] |\d+\. |- \[[ x]\] |> |```)|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/|\[\[note:/;

function handlePaste(view: EditorView, event: ClipboardEvent, slice: Slice, upload?: (f: File) => Promise<string>): boolean {
  const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    void insertImages(view, files, upload);
    return true;
  }
  const text = event.clipboardData?.getData('text/plain') ?? '';
  const html = event.clipboardData?.getData('text/html') ?? '';
  // Текст с признаками Markdown (из ChatGPT/Obsidian/README) — парсим нашим диалектом
  if (text && !html && MD_HINT.test(text)) {
    const doc = fromNoteDoc(markdownToNoteDoc(text));
    view.dispatch(view.state.tr.replaceSelection(new Slice(doc.content, 0, 0)).scrollIntoView());
    return true;
  }
  return false;
}

function handleDropFiles(view: EditorView, event: DragEvent, upload?: (f: File) => Promise<string>): boolean {
  const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return false;
  const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (pos) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos.pos))));
  void insertImages(view, files, upload);
  return true;
}

async function insertImages(view: EditorView, files: File[], upload?: (f: File) => Promise<string>): Promise<void> {
  if (!upload) {
    toastError(noteEditorLabels.imageNoRights);
    return;
  }
  for (const file of files) {
    try {
      const fileId = await upload(file);
      cmd.insertImage(fileId, file.name.replace(/\.[a-z0-9]+$/i, '') || null)(view.state, view.dispatch, view);
    } catch (e) {
      toastError(e instanceof Error ? e.message : noteEditorLabels.imageFailed);
    }
  }
}

function pickImage(view: EditorView, upload?: (f: File) => Promise<string>): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = () => {
    const files = [...(input.files ?? [])];
    if (files.length) void insertImages(view, files, upload);
  };
  input.click();
}

export { PMDOMParser };
export type { PMNode };
