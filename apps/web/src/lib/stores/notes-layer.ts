import { create } from 'zustand';

// ============================================================
// Слой стикеров Заметок — состояние ОДНО на вкладку (хоткей Alt+N, кнопка топбара,
// «Новая заметка» из карточки сущности). Контекст (личное / организация) слой берёт
// из адреса сам, здесь только «открыт ли» и разовые команды.
// ============================================================

interface NotesLayerState {
  open: boolean;
  /** Папка, чья доска показана (null — корень); запоминается на вкладку */
  folderId: string | null;
  /** Разовая команда «создать стикер» — слой её выполняет и сбрасывает */
  newNoteRequest: number;
  /** Разовая команда «положить эту заметку стикером» (из панели сущности) */
  pinRequest: { noteId: string; nonce: number } | null;
  toggle: () => void;
  openLayer: () => void;
  close: () => void;
  setFolder: (folderId: string | null) => void;
  requestNewNote: () => void;
  requestPin: (noteId: string) => void;
  consumeNewNote: () => void;
  consumePin: () => void;
}

export const useNotesLayer = create<NotesLayerState>((set) => ({
  open: false,
  folderId: null,
  newNoteRequest: 0,
  pinRequest: null,
  toggle: () => set((s) => ({ open: !s.open })),
  openLayer: () => set({ open: true }),
  close: () => set({ open: false }),
  setFolder: (folderId) => set({ folderId }),
  requestNewNote: () => set((s) => ({ open: true, newNoteRequest: s.newNoteRequest + 1 })),
  requestPin: (noteId) => set({ open: true, pinRequest: { noteId, nonce: Date.now() } }),
  consumeNewNote: () => set({ newNoteRequest: 0 }),
  consumePin: () => set({ pinRequest: null }),
}));
