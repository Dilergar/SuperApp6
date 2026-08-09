// Единственная точка импорта библиотеки редактора: сменить редактор = поменять
// этот файл и builder-convert.ts, провод BuilderDoc не трогается.
// CSS пакетов импортирует BuilderEditor.tsx: side-effect-импорт стилей из чистого
// .ts-модуля Turbopack в сборку НЕ кладёт (проверено в браузере — стилей не было).

export { BlockNoteView } from '@blocknote/mantine';
export {
  BasicTextStyleButton,
  FormattingToolbar,
  FormattingToolbarController,
  SuggestionMenuController,
  TextAlignButton,
  useCreateBlockNote,
} from '@blocknote/react';
export type { DefaultReactSuggestionItem } from '@blocknote/react';
