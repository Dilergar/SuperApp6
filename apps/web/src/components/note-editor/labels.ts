'use client';

// ============================================================
// Слова для НЕ-React слоёв редактора заметок (схема ProseMirror, плагины, чистый
// DOM в node-view чекбокса).
//
// Схема и плагины — модули, а не компоненты: хука каталога в них нет и быть не
// может, а строка в них — это язык, зашитый навсегда. Поэтому слова кладёт сюда
// единственный React-владелец (`NoteEditor`) при рендере, а слои читают их в
// момент отрисовки узла. Реестр один на приложение: редактор в фокусе тоже один,
// а язык у всех открытых редакторов общий.
// ============================================================

export interface NoteEditorLabels {
  /** Плейсхолдер первой строки — она же название заметки */
  title: string;
  /** Подсказка на ссылке с недопустимым адресом */
  blockedLink: string;
  /** Подпись отмеченного чекбокса в списке задач */
  done: string;
  /** Картинку класть нельзя: нет прав на файлы */
  imageNoRights: string;
  /** Картинка не загрузилась */
  imageFailed: string;
}

export const noteEditorLabels: NoteEditorLabels = {
  title: '',
  blockedLink: '',
  done: '',
  imageNoRights: '',
  imageFailed: '',
};

export function setNoteEditorLabels(next: NoteEditorLabels): void {
  Object.assign(noteEditorLabels, next);
}
