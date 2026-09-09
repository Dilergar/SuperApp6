'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { NOTE_HOTKEYS, NOTE_LIMITS, type NoteBoardDto, type NoteBoardItemDto, type NoteSpaceRef } from '@superapp/shared';
import { EmptyState, Icon, Spinner } from '@/components/ui';
import { apiErrorMessage } from '@/lib/api';
import { createNote, fetchNotesBoard, putBoardItem, updateNote, type NotesListFilter } from '@/lib/notes-api';
import { notesBoardKey, notesRootKey } from '@/lib/queries';
import { toastError } from '@/lib/toast';
import { NoteSticky } from './NoteSticky';
import { selectionFilter, type NotesSelection } from './NotesFolderTree';
import { noteTargetFromPath } from './note-target-from-path';

// ============================================================
// Доска заметок — ВИД на выбранный раздел: что выбрано слева (папка, все, тег,
// закреплённые, «поделились», корзина), то и разложено карточками. Личной остаётся
// раскладка: сдвинул/растянул/свернул карточку — положение запомнилось (PUT board/:id).
// Один компонент для страницы Заметок и для слоя `Alt+N` — доска везде одна.
// ============================================================

/** Высота стопки «новая заметка» (.notes-pack: 56px) + отступ до первой строки сетки */
const PACK_INSET = 56 + 12;
/** Высота свёрнутой в полоску карточки — для нижнего края холста */
const COLLAPSED_H = 40;

interface Props {
  scope: NoteSpaceRef;
  scopeKey: string;
  selection: NotesSelection;
  /** Поиск из шапки — доска показывает то же, что и дерево */
  q?: string;
  /** Куда уводит «Открыть целиком» (в слое — на страницу Заметок; на странице не нужно) */
  onOpenNote?: (noteId: string) => void;
  onTagClick?: (name: string) => void;
  /** Заметка, на которой нужно поставить фокус (выбор в дереве, создание) */
  focusNoteId?: string | null;
  /** Разовая команда «создать заметку» (Alt+Shift+N из слоя) */
  createNonce?: number;
  /** Счётчик «показать focusNoteId»: повторный клик по той же заметке тоже прокручивает */
  focusNonce?: number;
  /** Путь страницы: новая заметка на карточке сущности сразу привязывается к ней */
  pathname?: string;
  search?: string;
  className?: string;
}

export function NotesBoard({ scope, scopeKey, selection, q, onOpenNote, onTagClick, focusNoteId, createNonce, focusNonce, pathname, search, className }: Props) {
  const t = useTranslations('notes');
  const qc = useQueryClient();
  const boardRef = useRef<HTMLDivElement | null>(null);
  // Скроллер и ХОЛСТ — разные узлы: min-height сетки на скроллере отключал бы прокрутку
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [creating, setCreating] = useState(false);
  const [innerFocus, setInnerFocus] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const [boardWidth, setBoardWidth] = useState(0);

  // Ширина доски нужна для сетки «неразложенных» карточек — следим за ней
  useEffect(() => {
    const el = boardRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setBoardWidth(el.clientWidth));
    ro.observe(el);
    setBoardWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Поиск — по ВСЕМУ пространству, а не внутри раздела: строка над деревом папок ищет
  // как проводник Obsidian, и доска показывает найденное, откуда бы оно ни было
  const searching = !!q?.trim();
  const filter: NotesListFilter = useMemo(() => (searching ? { q: q!.trim() } : selectionFilter(selection)), [selection, q, searching]);
  const filterKey = JSON.stringify(filter);
  const boardKey = notesBoardKey(scopeKey, filterKey);
  const board = useQuery({ queryKey: boardKey, queryFn: () => fetchNotesBoard(scope, filter), staleTime: 10_000 });
  const items = board.data?.items ?? [];
  const readOnlySection = selection === 'trash' && !searching;
  // Пока идёт поиск, пустой лист не создаём: он не совпал бы с запросом и пропал бы с глаз
  const canCreate = !readOnlySection && !searching;

  /**
   * Карточки, которые человек НЕ раскладывал, ложатся сеткой по ширине доски: сервер
   * процентов не считает — он не знает ни ширины панели, ни размеров карточек, и его
   * «сетка» наезжала бы сама на себя.
   *
   * Место в сетке держит КАЖДАЯ карточка раздела, даже разложенная: иначе, стоило
   * человеку подвинуть одну, соседние съезжали бы на её слот, а холст (его высоту
   * задаёт та же сетка) сжимался бы — и разложенные карточки, живущие в процентах
   * холста, поехали бы следом.
   */
  const autoPos = useMemo(() => {
    const map = new Map<string, { left: number; top: number }>();
    const gap = 16;
    const width = boardWidth || 960;
    // Первая строка сетки — под стопкой «новая заметка» в левом верхнем углу (см. .notes-pack)
    const originTop = gap + (canCreate ? PACK_INSET : 0);
    let maxBottom = 0;
    items.forEach((item, index) => {
      const cellW = item.w + gap;
      const cols = Math.max(1, Math.floor((width - gap) / cellW));
      const col = index % cols;
      const row = Math.floor(index / cols);
      const top = originTop + row * (item.h + gap);
      if (!item.placed) map.set(item.noteId, { left: gap + col * cellW, top });
      maxBottom = Math.max(maxBottom, top + item.h + gap);
    });
    return { map, height: maxBottom };
  }, [items, boardWidth, canCreate]);

  // ---- раскладка: сначала локально, потом на сервер
  const patchItem = useCallback(
    (noteId: string, patch: Partial<NoteBoardItemDto>) => {
      qc.setQueryData<NoteBoardDto>(boardKey, (old) => (old ? { ...old, items: old.items.map((i) => (i.noteId === noteId ? { ...i, ...patch } : i)) } : old));
    },
    [qc, boardKey],
  );
  /**
   * Первое сохранение карточки из сетки обязано унести и ЕЁ МЕСТО: сервер, не получив
   * координат, кладёт строку в 10/10 — и карточка, у которой поменяли только размер
   * или свёрнутость, прыгала бы в угол поверх соседней.
   */
  // Свежие items/autoPos обработчики читают через ref: сами обработчики обязаны быть
  // СТАБИЛЬНЫМИ — карточка мемоизирована, и новая функция в пропсах перерисовала бы
  // все карточки (с редакторами) на каждый сдвиг одной из них.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const autoPosRef = useRef(autoPos);
  autoPosRef.current = autoPos;
  const withGridPos = useCallback((noteId: string, patch: Partial<NoteBoardItemDto>): Partial<NoteBoardItemDto> => {
    if (patch.x !== undefined && patch.y !== undefined) return patch;
    const item = itemsRef.current.find((i) => i.noteId === noteId);
    const grid = autoPosRef.current.map.get(noteId);
    if (!item || item.placed || !grid) return patch;
    return { ...patch, x: grid.left, y: grid.top };
  }, []);
  // Холст растёт за содержимым: сетка, нижний край разложенных карточек, запас снизу
  const canvasHeight = useMemo(() => {
    let bottom = autoPos.height;
    for (const i of items) if (i.placed) bottom = Math.max(bottom, i.y + (i.collapsed ? COLLAPSED_H : i.h) + 16);
    return bottom + 72;
  }, [items, autoPos]);
  const persist = useCallback(
    async (noteId: string, patch: Partial<NoteBoardItemDto>) => {
      const full = withGridPos(noteId, patch);
      patchItem(noteId, { ...full, placed: true });
      try {
        await putBoardItem(noteId, { x: full.x, y: full.y, w: full.w, h: full.h, z: full.z, collapsed: full.collapsed });
      } catch (e) {
        toastError(apiErrorMessage(e));
        void qc.invalidateQueries({ queryKey: boardKey });
      }
    },
    [withGridPos, patchItem, qc, boardKey],
  );
  // ---- обработчики карточек: стабильные, по noteId
  const handleMove = useCallback((noteId: string, x: number, y: number) => void persist(noteId, { x, y }), [persist]);
  const handleResize = useCallback((noteId: string, w: number, h: number) => void persist(noteId, { w, h }), [persist]);
  const handleCollapse = useCallback((noteId: string, collapsed: boolean) => void persist(noteId, { collapsed }), [persist]);
  const handleFront = useCallback(
    (noteId: string) => {
      const list = itemsRef.current;
      const item = list.find((i) => i.noteId === noteId);
      const maxZ = Math.max(0, ...list.map((i) => i.z));
      if (!item || item.z >= maxZ || list.length === 1) return;
      // Клик по карточке — ещё не «я её разложил»: пока человек не двигал её сам,
      // слой поднимаем только на экране, иначе чтение заметки замораживало бы сетку.
      if (!item.placed) {
        patchItem(noteId, { z: maxZ + 1 });
        return;
      }
      void persist(noteId, { z: maxZ + 1 });
    },
    [patchItem, persist],
  );
  const handleColor = useCallback(
    async (noteId: string, color: string | null) => {
      const item = itemsRef.current.find((i) => i.noteId === noteId);
      if (!item) return;
      patchItem(noteId, { note: { ...item.note, color } });
      try {
        const res = await updateNote(noteId, { baseVersion: item.note.version, color });
        patchItem(noteId, { note: { ...item.note, color, version: res.version } });
        void qc.invalidateQueries({ queryKey: notesRootKey, refetchType: 'inactive' });
      } catch (e) {
        toastError(apiErrorMessage(e));
        void qc.invalidateQueries({ queryKey: boardKey });
      }
    },
    [patchItem, qc, boardKey],
  );
  // Колбэки родителя приходят новыми функциями на каждый его рендер — карточкам отдаём
  // обёртки со стабильной личностью (наличие/отсутствие сохраняем: по нему рисуется кнопка)
  const onOpenNoteRef = useRef(onOpenNote);
  onOpenNoteRef.current = onOpenNote;
  const onTagClickRef = useRef(onTagClick);
  onTagClickRef.current = onTagClick;
  const openNote = useCallback((noteId: string) => onOpenNoteRef.current?.(noteId), []);
  const tagClick = useCallback((name: string) => onTagClickRef.current?.(name), []);

  const create = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const related = pathname ? noteTargetFromPath(pathname, search) : null;
      const note = await createNote({
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        folderId: filter.folderId === 'root' ? null : (filter.folderId ?? null),
        related: related && (scope.workspaceId || related.targetType === 'task') ? [related] : undefined,
      });
      setInnerFocus(note.id);
      await qc.invalidateQueries({ queryKey: notesRootKey });
    } catch (e) {
      toastError(apiErrorMessage(e));
    } finally {
      setCreating(false);
    }
  }, [creating, pathname, search, scope.workspaceId, filter.folderId, qc]);

  // Разовая команда «создать» из слоя (Alt+Shift+N)
  useEffect(() => {
    if (createNonce) void create();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createNonce]);

  // Новая или выбранная в дереве заметка — прокрутить к ней и дать фокус
  const focusId = innerFocus ?? focusNoteId ?? null;
  useEffect(() => {
    if (!focusId) return;
    // Отложенно (карточка получает место в сетке уже ПОСЛЕ первой раскладки — вызов
    // сразу уехал бы к позиции 0,0), но БЕЗ requestAnimationFrame и БЕЗ 'smooth':
    // и кадры, и плавная прокрутка живут покадрово, а непокрашенная страница
    // (свёрнутое окно, фоновая вкладка) кадров не выдаёт — прыжок не случился бы вовсе.
    const t = setTimeout(() => {
      const el = boardRef.current?.querySelector(`[data-note-id="${focusId}"]`);
      el?.scrollIntoView({ block: 'center', inline: 'center' });
    }, 0);
    return () => clearTimeout(t);
    // `boardWidth`, а не `autoPos`: объект сетки пересоздаётся на каждую правку раскладки,
    // и доска уезжала бы к выбранной заметке при любом сдвиге соседней карточки.
  }, [focusId, focusNonce, items.length, boardWidth]);

  return (
    <div ref={boardRef} className={`notes-board${className ? ` ${className}` : ''}`} >
      {board.isPending && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          <Spinner />
        </div>
      )}
      {!board.isPending && !items.length && (
        <div className="notes-board-hint">
          <EmptyState
            icon={searching ? 'search' : readOnlySection ? 'delete' : 'notes'}
            title={searching ? t('tree.nothingFound') : readOnlySection ? t('tree.trashEmpty') : t('board.emptyTitle')}
            description={
              searching
                ? t('board.searchHint')
                : readOnlySection
                  ? t('board.trashHint', { days: NOTE_LIMITS.trashRetentionDays })
                  : t('board.emptyHint')
            }
          />
        </div>
      )}
      <div className="notes-board-canvas" ref={canvasRef} style={{ minHeight: canvasHeight }}>
      {items.map((item) => (
        <NoteSticky
          key={item.noteId}
          item={item}
          scope={scope}
          boardRef={canvasRef}
          mobile={mobile}
          autoFocus={focusId === item.noteId}
          autoPos={autoPos.map.get(item.noteId)}
          boardWidth={boardWidth}
          readOnly={readOnlySection}
          onMove={handleMove}
          onResize={handleResize}
          onFront={handleFront}
          onCollapse={handleCollapse}
          onColor={handleColor}
          onOpenNote={onOpenNote ? openNote : undefined}
          onTagClick={onTagClick ? tagClick : undefined}
        />
      ))}
      </div>
      {/* Единственный вход «новая заметка» на доске — стопка чистых листов в левом верхнем углу */}
      {canCreate && (
        <button
          type="button"
          className="notes-pack"
          onClick={() => void create()}
          disabled={creating}
          aria-label={t('board.newNote', { keys: NOTE_HOTKEYS.newNote })}
          title={t('board.newNote', { keys: NOTE_HOTKEYS.newNote })}
        >
          <span className="notes-pack-sheet" aria-hidden />
          <span className="notes-pack-sheet" aria-hidden />
          <span className="notes-pack-sheet" aria-hidden />
          <span className="notes-pack-label" aria-hidden>
            <Icon name="add" size={22} />
          </span>
        </button>
      )}
    </div>
  );
}
