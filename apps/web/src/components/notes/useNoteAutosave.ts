'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NOTE_ERROR_CODES, type NoteDetailDto, type NoteDoc, type NoteSaveResultDto, type UpdateNoteInput } from '@superapp/shared';
import { apiErrorDetails } from '@/lib/api';
import { fetchNote, updateNote } from '@/lib/notes-api';
import { noteDetailKey, notesRootKey } from '@/lib/queries';

import { toastApiError } from '@/lib/api-errors';
// ============================================================
// Автосохранение заметки: debounce 800 мс + flush на размонтировании, ОДНА очередь на
// заметку с версией (оптимистическая блокировка). 409 → подтягиваем свежую версию и
// отдаём её редактору (тост «показана свежая версия»); локальные несохранённые
// правки при этом теряются осознанно — сервер не затирает чужой текст молча.
// ============================================================

export interface NoteAutosave {
  /** Редактор изменил документ */
  onDocChange(doc: NoteDoc): void;
  /** Немедленная правка метаданных (заголовок, цвет, закрепление, папка) */
  patch(input: Omit<UpdateNoteInput, 'baseVersion'>): Promise<NoteSaveResultDto | null>;
  /** Сохранить всё накопленное сейчас */
  flush(): Promise<void>;
  saving: boolean;
  dirty: boolean;
  /** Подсказка «упомянутые без доступа» из последнего ответа */
  mentionsWithoutAccess: NoteSaveResultDto['mentionsWithoutAccess'];
}

const DEBOUNCE_MS = 800;

export function useNoteAutosave(
  noteId: string | null,
  initialVersion: number,
  opts: { onSaved?: (res: NoteSaveResultDto) => void; onConflict?: (fresh: NoteDetailDto) => void } = {},
): NoteAutosave {
  const qc = useQueryClient();
  const versionRef = useRef(initialVersion);
  const pendingDoc = useRef<NoteDoc | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [mentions, setMentions] = useState<NoteSaveResultDto['mentionsWithoutAccess']>([]);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    versionRef.current = initialVersion;
  }, [initialVersion, noteId]);

  const send = useCallback(
    async (input: Omit<UpdateNoteInput, 'baseVersion'>): Promise<NoteSaveResultDto | null> => {
      if (!noteId) return null;
      // Ждём предыдущее сохранение: версия обязана идти по цепочке
      if (inflight.current) await inflight.current.catch(() => undefined);
      setSaving(true);
      let result: NoteSaveResultDto | null = null;
      const run = (async () => {
        try {
          const res = await updateNote(noteId, { ...input, baseVersion: versionRef.current });
          versionRef.current = res.version;
          result = res;
          // Пустой список при mentionsChecked=false — «не проверяли», а не «все видят»
          if (res.mentionsChecked) setMentions(res.mentionsWithoutAccess);
          optsRef.current.onSaved?.(res);
          // Список/карточка/доска читают заголовок и сниппет — инвалидируем корень
          void qc.invalidateQueries({ queryKey: notesRootKey });
        } catch (e) {
          if (apiErrorDetails(e)?.code === NOTE_ERROR_CODES.versionConflict) {
            toastApiError(e);
            pendingDoc.current = null;
            try {
              const fresh = await fetchNote(noteId);
              versionRef.current = fresh.version;
              qc.setQueryData(noteDetailKey(noteId), fresh);
              optsRef.current.onConflict?.(fresh);
            } catch {
              /* карточка сама перечитает */
            }
          } else {
            toastApiError(e);
          }
        } finally {
          setSaving(false);
        }
      })();
      inflight.current = run;
      await run;
      inflight.current = null;
      return result;
    },
    [noteId, qc],
  );

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const doc = pendingDoc.current;
    if (!doc) return;
    pendingDoc.current = null;
    setDirty(false);
    await send({ content: doc });
  }, [send]);

  const onDocChange = useCallback(
    (doc: NoteDoc) => {
      pendingDoc.current = doc;
      setDirty(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [flush],
  );

  const patch = useCallback(
    async (input: Omit<UpdateNoteInput, 'baseVersion'>) => {
      // Текст, если накопился, уезжает тем же запросом — одной версией
      const doc = pendingDoc.current;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pendingDoc.current = null;
      setDirty(false);
      return send(doc ? { ...input, content: doc } : input);
    },
    [send],
  );

  // flush при размонтировании — правки последних секунд не теряются
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(
    () => () => {
      if (pendingDoc.current) void flushRef.current();
    },
    [noteId],
  );

  return { onDocChange, patch, flush, saving, dirty, mentionsWithoutAccess: mentions };
}
