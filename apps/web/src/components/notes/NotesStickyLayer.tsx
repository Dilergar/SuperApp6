'use client';

import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useAuthStore } from '@/lib/stores/auth';
import { useNotesLayer } from '@/lib/stores/notes-layer';
import { LazyNamespace } from '@/i18n/LazyNamespace';
import { isNotesLayerAllowed } from './note-target-from-path';

// Внутренность — лениво: редактор (ProseMirror) не нужен ни одной странице до первого Alt+N.
const Inner = dynamic(() => import('./NotesStickyLayerInner').then((m) => m.NotesStickyLayerInner), { ssr: false });

/**
 * Слой стикеров Заметок (монтируется в Providers — на любой странице, как CallsWatcher).
 * Горячие клавиши — ФИЗИЧЕСКИЕ коды (не зависят от раскладки): Alt+N — показать/скрыть
 * доску, Alt+Shift+N — новый стикер. Уважает `e.defaultPrevented` и не работает на
 * гостевых/auth-страницах.
 */
export function NotesStickyLayer() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const pathname = usePathname();
  const open = useNotesLayer((s) => s.open);
  const toggle = useNotesLayer((s) => s.toggle);
  const requestNewNote = useNotesLayer((s) => s.requestNewNote);
  const close = useNotesLayer((s) => s.close);
  const allowed = isAuthenticated && isNotesLayerAllowed(pathname);

  useEffect(() => {
    if (!allowed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey) return;
      // Физический код (раскладка не важна) ИЛИ символ: у синтетических событий и части
      // клавиатур `code` пуст, у русской раскладки `key` — кириллица (ловушка календаря).
      if (e.code !== 'KeyN' && e.key.toLowerCase() !== 'n') return;
      e.preventDefault();
      if (e.shiftKey) requestNewNote();
      else toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [allowed, toggle, requestNewNote]);

  // Смена адреса на гостевой/auth — слой закрывается сам
  useEffect(() => {
    if (!allowed && open) close();
  }, [allowed, open, close]);

  if (!allowed || !open) return null;
  // Словарь Заметок приезжает вместе с самим слоем — отдельным чанком по первому Alt+N.
  return (
    <LazyNamespace ns="notes">
      <Inner />
    </LazyNamespace>
  );
}
