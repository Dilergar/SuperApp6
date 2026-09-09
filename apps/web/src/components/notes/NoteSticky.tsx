'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { NOTE_LIMITS, type NoteBoardItemDto, type NoteDetailDto, type NoteDoc, type NoteSpaceRef } from '@superapp/shared';
import { IconButton, Menu, useConfirm } from '@/components/ui';
import { uploadFile } from '@/lib/files-api';
import { NoteEditor, type NoteEditorHandle } from '@/components/note-editor/NoteEditor';
import { DictateButton } from '@/components/note-editor/DictateButton';
import { NoteColorMenu } from './NoteColorMenu';
import { NoteHistoryModal } from './NoteHistoryModal';
import { NoteRelatedPicker } from './NoteRelatedPicker';
import { NoteShareModal } from './NoteShareModal';
import { useNoteAutosave } from './useNoteAutosave';
import { apiErrorMessage } from '@/lib/api';
import { addNoteRelated, purgeNote, restoreNote, trashNote } from '@/lib/notes-api';
import { notesRootKey } from '@/lib/queries';
import { toastError } from '@/lib/toast';
import { useQueryClient } from '@tanstack/react-query';

// ============================================================
// Карточка заметки на доске: та же заметка в компактном редакторе. Двигается за шапку,
// тянется за угол, сворачивается в полоску (Apple Stickies), красится (Google Keep).
// Позиция и размер — проценты/пиксели и хранятся на человека (моя раскладка).
// Действия заметки (доступ, история, привязки, корзина) живут в меню карточки: отдельной
// панели редактора у страницы нет — доска и есть рабочее место.
// ============================================================

interface Props {
  item: NoteBoardItemDto;
  scope: NoteSpaceRef;
  boardRef: React.RefObject<HTMLDivElement | null>;
  tags?: string[];
  autoFocus?: boolean;
  /** Позиция сеткой в пикселях — для карточки, которую человек ещё не двигал */
  autoPos?: { left: number; top: number };
  /** Ширина доски: разложенная карточка не выезжает за правый край */
  boardWidth?: number;
  mobile?: boolean;
  /** Раздел «Корзина»: карточка только для чтения, из действий — восстановить/удалить */
  readOnly?: boolean;
  /** Обработчики получают noteId и у доски СТАБИЛЬНЫ — карточка мемоизирована (см. конец файла) */
  onMove: (noteId: string, x: number, y: number) => void;
  onResize: (noteId: string, w: number, h: number) => void;
  onFront: (noteId: string) => void;
  onCollapse: (noteId: string, collapsed: boolean) => void;
  onColor: (noteId: string, color: string | null) => void;
  onOpenNote?: (noteId: string) => void;
  onTagClick?: (name: string) => void;
}

/** Зона у края скроллера, где жест прокручивает доску, и шаг прокрутки за кадр */
const DRAG_EDGE = 48;
const DRAG_STEP = 14;

function NoteStickyInner({ item, scope, boardRef, tags, autoFocus, autoPos, boardWidth, mobile, readOnly, onMove, onResize, onFront, onCollapse, onColor, onOpenNote, onTagClick }: Props) {
  const t = useTranslations('notes');
  const qc = useQueryClient();
  const [confirm, confirmUi] = useConfirm();
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [relatedOpen, setRelatedOpen] = useState(false);
  const editorRef = useRef<NoteEditorHandle | null>(null);
  const [doc, setDoc] = useState<NoteDoc>(item.note.content);
  const [pos, setPos] = useState({ x: item.x, y: item.y });
  const [size, setSize] = useState({ w: item.w, h: item.h });
  // «Разложена» локально — с момента отпускания, не дожидаясь ответа кэша доски:
  // иначе карточка из сетки после броска на кадр возвращалась бы в свой слот
  const [localPlaced, setLocalPlaced] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  // Transform перетаскивания снимаем ТОЛЬКО после того, как новые left/top уже в DOM
  // (layout-эффект идёт до отрисовки): снятие прямо в pointerup показывало бы карточку
  // на старом месте на кадр-другой — пока React не закоммитит новое состояние.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el && el.style.transform) el.style.transform = '';
  }, [pos, localPlaced]);
  // Версия, которую этот стикер уже показал: чужая правка приезжает с доской новой версией
  const seenVersion = useRef(item.note.version);
  const save = useNoteAutosave(item.noteId, item.note.version, {
    // Своя версия после сохранения — не «чужая правка»: доска перечитается с ней, и
    // документ не должен заменяться на серверный (он бы стёр набранное за это время).
    onSaved: (res) => {
      seenVersion.current = res.version;
    },
    onConflict: (fresh: NoteDetailDto) => setDoc(fresh.content),
  });

  useEffect(() => setPos({ x: item.x, y: item.y }), [item.x, item.y]);
  useEffect(() => setSize({ w: item.w, h: item.h }), [item.w, item.h]);
  useEffect(() => {
    if (item.note.version !== seenVersion.current) {
      seenVersion.current = item.note.version;
      setDoc(item.note.content);
    }
  }, [item.note.version, item.note.content]);

  const onDocChange = useCallback(
    (d: NoteDoc) => {
      setDoc(d);
      save.onDocChange(d);
    },
    [save],
  );

  // ---- перетаскивание за шапку.
  // Пока тянем — двигаем сам DOM-узел (transform) и НЕ трогаем состояние React: рендер
  // карточки тянет за собой редактор, и 60 рендеров в секунду давали рывки и «зависание»
  // на старте. Состояние и сервер получают только итог по pointerup. Координаты —
  // ПИКСЕЛИ холста: вниз холст растёт без предела (у края доска прокручивается сама),
  // вбок карточка держится в ширине доски.
  const onHeadPointerDown = (e: React.PointerEvent) => {
    if (mobile || (e.target as HTMLElement).closest('button')) return;
    onFront(item.noteId);
    const el = rootRef.current;
    const canvas = boardRef.current;
    if (!el || !canvas) return;
    const scroller = canvas.closest<HTMLElement>('.notes-board');
    const rect0 = el.getBoundingClientRect();
    const cr0 = canvas.getBoundingClientRect();
    // Тянем от ФАКТИЧЕСКОГО места (карточка из сетки лежит по своему слоту) и за то
    // место, за которое взяли: карточка едет за курсором, а не прыгает к нему
    const startX = rect0.left - cr0.left;
    const startY = rect0.top - cr0.top;
    const grabX = e.clientX - rect0.left;
    const grabY = e.clientY - rect0.top;
    let last = { x: e.clientX, y: e.clientY };
    let raf = 0;
    // Положение считаем от ТЕКУЩЕГО прямоугольника холста: во время жеста доска
    // прокручивается, и снимок с pointerdown врал бы
    const at = () => {
      const cr = canvas.getBoundingClientRect();
      return {
        x: clamp(last.x - cr.left - grabX, 0, Math.max(0, cr.width - rect0.width)),
        y: clamp(last.y - cr.top - grabY, 0, NOTE_LIMITS.boardMaxCoord),
      };
    };
    const paint = () => {
      const p = at();
      el.style.transform = `translate(${p.x - startX}px, ${p.y - startY}px)`;
    };
    // У края скроллера доска прокручивается сама, пока указатель там стоит, — без этого
    // ниже видимого края стояла бы «невидимая стена»
    const edgeScroll = () => {
      raf = 0;
      if (!scroller) return;
      const sr = scroller.getBoundingClientRect();
      const step = last.y > sr.bottom - DRAG_EDGE ? DRAG_STEP : last.y < sr.top + DRAG_EDGE ? -DRAG_STEP : 0;
      if (!step) return;
      scroller.scrollTop += step;
      paint();
      raf = requestAnimationFrame(edgeScroll);
    };
    el.classList.add('note-sticky--dragging');
    const move = (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      paint();
      if (!raf) raf = requestAnimationFrame(edgeScroll);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (raf) cancelAnimationFrame(raf);
      el.classList.remove('note-sticky--dragging');
      const raw = at();
      const p = { x: Math.round(raw.x), y: Math.round(raw.y) };
      // Клик без сдвига — не раскладка: карточка остаётся там, где была
      if (Math.abs(p.x - startX) < 1 && Math.abs(p.y - startY) < 1) {
        el.style.transform = '';
        return;
      }
      // transform остаётся до коммита новых координат — его снимет layout-эффект выше
      setPos(p);
      setLocalPlaced(true);
      onMove(item.noteId, p.x, p.y);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // ---- изменение размера за угол: тем же способом — DOM во время жеста, состояние по итогу
  const onResizePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onFront(item.noteId);
    const el = rootRef.current;
    if (!el) return;
    const start = { px: e.clientX, py: e.clientY, w: size.w, h: size.h };
    const at = (ev: PointerEvent) => ({
      w: clamp(Math.round(start.w + ev.clientX - start.px), NOTE_LIMITS.stickyMinW, NOTE_LIMITS.stickyMaxW),
      h: clamp(Math.round(start.h + ev.clientY - start.py), NOTE_LIMITS.stickyMinH, NOTE_LIMITS.stickyMaxH),
    });
    const move = (ev: PointerEvent) => {
      const s = at(ev);
      el.style.width = `${s.w}px`;
      el.style.height = `${s.h}px`;
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const s = at(ev);
      // Инлайн-размер оставляем: React запишет те же значения из состояния
      el.style.width = `${s.w}px`;
      el.style.height = `${s.h}px`;
      setSize(s);
      if (s.w !== start.w || s.h !== start.h) onResize(item.noteId, s.w, s.h);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const upload = useCallback(
    async (file: File) => {
      const dto = await uploadFile(file, 'note_image', scope.workspaceId ? { ownerWorkspaceId: scope.workspaceId } : {});
      return dto.id;
    },
    [scope.workspaceId],
  );

  const title = item.note.title || firstLine(doc) || t('untitled');
  const canEdit = item.note.access !== 'viewer' && !readOnly;
  const canManage = item.note.access === 'manager' || item.note.access === 'owner';
  const refetch = () => void qc.invalidateQueries({ queryKey: notesRootKey });
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      refetch();
    } catch (e) {
      toastError(apiErrorMessage(e));
    }
  };
  // Разложенная карточка лежит по своим пикселям холста (вбок — не дальше ширины доски:
  // раскладку могли делать на более широкой), ещё не тронутая — по слоту сетки
  const placement: React.CSSProperties =
    item.placed || localPlaced || !autoPos
      ? { left: boardWidth ? Math.max(0, Math.min(pos.x, boardWidth - size.w)) : pos.x, top: pos.y }
      : { left: autoPos.left, top: autoPos.top };
  const style: React.CSSProperties = {
    ...placement,
    width: size.w,
    height: item.collapsed ? undefined : size.h,
    zIndex: item.z,
    ...(item.note.color ? ({ ['--note-color' as string]: item.note.color } as React.CSSProperties) : {}),
  };

  return (
    <article
      ref={rootRef}
      className={`note-sticky${item.collapsed ? ' note-sticky--collapsed' : ''}${autoFocus ? ' note-sticky--chosen' : ''}`}
      style={style}
      data-note-id={item.noteId}
      onPointerDown={() => onFront(item.noteId)}
      aria-label={t('sticky.aria', { title })}
    >
      <header className="note-sticky-head" onPointerDown={onHeadPointerDown}>
        <span className="note-sticky-title" title={title}>{title}</span>
        {save.saving && <span className="note-sticky-saving" aria-label={t('sticky.saving')} />}
        {canEdit && <NoteColorMenu value={item.note.color} onChange={(c) => onColor(item.noteId, c)} size={24} />}
        <IconButton icon={item.collapsed ? 'arrowsOut' : 'minus'} label={t(item.collapsed ? 'sticky.expand' : 'sticky.collapse')} size={24} iconSize={14} onClick={() => onCollapse(item.noteId, !item.collapsed)} />
        {onOpenNote && <IconButton icon="external" label={t('sticky.openInNotes')} size={24} iconSize={14} onClick={() => onOpenNote(item.noteId)} />}
        {/* Действия заметки — здесь: отдельной панели редактора у страницы нет */}
        <Menu
          label={t('sticky.actions')}
          align="end"
          items={
            readOnly
              ? [
                  { key: 'restore', label: t('sticky.restore'), icon: 'restore', onClick: () => void run(() => restoreNote(item.noteId)) },
                  {
                    key: 'purge',
                    label: t('sticky.purge'),
                    icon: 'delete',
                    danger: true,
                    separatorBefore: true,
                    onClick: () =>
                      confirm(
                        { title: t('sticky.purgeConfirm.title'), message: t('sticky.purgeConfirm.message'), danger: true },
                        () => run(() => purgeNote(item.noteId)),
                      ),
                  },
                ]
              : [
                  { key: 'share', label: t('sticky.share'), icon: 'share', onClick: () => setShareOpen(true) },
                  { key: 'history', label: t('sticky.history'), icon: 'restore', onClick: () => setHistoryOpen(true) },
                  { key: 'related', label: t('sticky.related'), icon: 'link', onClick: () => setRelatedOpen(true), disabled: !canEdit },
                  ...(canManage
                    ? [
                        {
                          key: 'trash',
                          label: t('sticky.toTrash'),
                          icon: 'delete' as const,
                          danger: true,
                          separatorBefore: true,
                          onClick: () => void run(() => trashNote(item.noteId)),
                        },
                      ]
                    : []),
                ]
          }
          trigger={({ ref, onClick, ...aria }) => (
            <IconButton ref={ref} icon="more" label={t('sticky.actions')} size={24} iconSize={14} onClick={onClick} {...aria} />
          )}
        />
      </header>
      {!item.collapsed && (
        <>
          <div className="note-sticky-body">
            <NoteEditor
              ref={editorRef}
              value={doc}
              onChange={onDocChange}
              compact
              readOnly={!canEdit}
              placeholder={t('sticky.placeholder')}
              autoFocus={autoFocus}
              scope={scope}
              noteId={item.noteId}
              tags={tags}
              onUploadImage={canEdit ? upload : undefined}
              // Через слой: он знает пространство и уводит по адресу с организацией
              onWikilinkOpen={onOpenNote}
              onTagClick={onTagClick}
              toolbarExtra={canEdit ? <DictateButton compact onText={(t) => editorRef.current?.insertText(t)} /> : undefined}
            />
          </div>
          {!mobile && canEdit && <span className="note-sticky-resize" onPointerDown={onResizePointerDown} aria-hidden />}
        </>
      )}
      <NoteShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        scope={scope}
        target={{ kind: 'note', id: item.noteId, title }}
        canManage={canManage}
      />
      <NoteHistoryModal open={historyOpen} onClose={() => setHistoryOpen(false)} noteId={item.noteId} canEdit={canEdit} />
      <NoteRelatedPicker
        open={relatedOpen}
        onClose={() => setRelatedOpen(false)}
        scope={scope}
        onPick={(ref) => void run(() => addNoteRelated(item.noteId, ref))}
      />
      {confirmUi}
    </article>
  );
}

/**
 * Карточка перерисовывается ТОЛЬКО по своим данным. Обработчики у доски стабильны
 * (иначе сдвиг одной карточки перерисовывал бы все двадцать редакторов), а место в сетке
 * сравниваем по значению — объект `autoPos` доска пересобирает на любую правку соседа.
 */
export const NoteSticky = memo(NoteStickyInner, (a, b) => {
  if ((a.autoPos?.left ?? -1) !== (b.autoPos?.left ?? -1) || (a.autoPos?.top ?? -1) !== (b.autoPos?.top ?? -1)) return false;
  const { autoPos: _a, ...ra } = a;
  const { autoPos: _b, ...rb } = b;
  void _a;
  void _b;
  const pa = ra as Record<string, unknown>;
  const pb = rb as Record<string, unknown>;
  for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) if (!Object.is(pa[k], pb[k])) return false;
  return true;
});

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function firstLine(doc: NoteDoc): string {
  for (const b of doc.content) {
    if ((b.type === 'paragraph' || b.type === 'heading') && b.content) {
      const t = b.content.map((n) => (n.type === 'text' ? n.text : n.type === 'mention' ? n.attrs.name : n.type === 'wikilink' ? n.attrs.title : n.type === 'tag' ? `#${n.attrs.name}` : '')).join('').trim();
      if (t) return t.slice(0, 60);
    }
  }
  return '';
}
