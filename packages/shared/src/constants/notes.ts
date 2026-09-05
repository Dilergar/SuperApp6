// ============================================================
// Заметки — константы (обе стороны провода)
//
// Заметка живёт в ПРОСТРАНСТВЕ (личном или организации), лежит в папке (дерево) и
// хранит свой документ в собственном JSON-формате (`NoteDoc`, см. ../notes/note-doc).
// Markdown и чистый текст — производные проекции, которые сервер считает сам.
// ============================================================

/** refType заметки — он же тип ресурса в core/access, files, chatter, rich-cards */
export const NOTE_REF_TYPE = 'note';
/** refType папки заметок — тип ресурса в core/access (гранты наследуются вглубь) */
export const NOTE_FOLDER_REF_TYPE = 'note_folder';

/** Роли на заметке/папке — ровно отношения типов в core/access. Лестница: manager ⇒ editor ⇒ viewer */
export const NOTE_ROLES = ['viewer', 'editor', 'manager'] as const;
export const NOTE_ROLE_RANK: Record<(typeof NOTE_ROLES)[number], number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
};

/** Кому можно выдать доступ (тот же словарь принципалов, что у Диска) */
export const NOTE_PRINCIPAL_TYPES = ['user', 'circle', 'workspace', 'department', 'position', 'branch'] as const;

/**
 * Цвета заметок/стикеров — ЦВЕТ-ДАННЫЕ (выбирает человек), а не цвет системы.
 * Те же восемь пастельных тонов, что у Групп окружения: одна палитра на платформу,
 * ничего не выдумываем (правило DESIGN.md «цвета не придумывать»).
 */
export const NOTE_COLORS: ReadonlyArray<{ value: string; name: string }> = [
  { value: '#f0c4c2', name: 'Розовый' },
  { value: '#c3d8f0', name: 'Голубой' },
  { value: '#eed6ae', name: 'Песочный' },
  { value: '#c6ddc7', name: 'Зелёный' },
  { value: '#e1bee7', name: 'Сиреневый' },
  { value: '#ffccbc', name: 'Персиковый' },
  { value: '#b2dfdb', name: 'Бирюзовый' },
  { value: '#f0f4c3', name: 'Лаймовый' },
];
export const NOTE_COLOR_VALUES = NOTE_COLORS.map((c) => c.value) as readonly string[];

/**
 * К чему заметка может ссылаться. `note` — вики-ссылка между заметками; остальное —
 * «привязано к» бизнес-сущности (модель Salesforce ContentDocumentLink).
 */
export const NOTE_TARGET_TYPES = ['note', 'task', 'counterparty', 'branch', 'document'] as const;
export const NOTE_RELATED_TARGET_TYPES = ['task', 'counterparty', 'branch', 'document'] as const;
export const NOTE_LINK_KINDS = ['wikilink', 'related'] as const;

export const NOTE_TARGET_LABELS: Record<(typeof NOTE_TARGET_TYPES)[number], string> = {
  note: 'Заметка',
  task: 'Задача',
  counterparty: 'Контрагент',
  branch: 'Объект',
  document: 'Документ',
};

export const NOTE_LIMITS = {
  /** Заголовок заметки */
  maxTitleLength: 200,
  /** Имя папки */
  maxFolderNameLength: 120,
  /** Глубина дерева папок (корень = 0) */
  maxFolderDepth: 16,
  /** Адрес ссылки в тексте (схемы — белым списком, `isSafeNoteHref`) */
  maxHrefLength: 2048,
  /** Документ: размер сериализованного JSON */
  maxDocBytes: 512 * 1024,
  /** Документ: глубина вложенности узлов */
  maxDocDepth: 12,
  /** Документ: общее число узлов */
  maxDocNodes: 20_000,
  /** Markdown на входе (создание заметки текстом / вставка) */
  maxMarkdownLength: 1024 * 1024,
  /** Тегов на заметку и длина тега */
  maxTags: 50,
  maxTagLength: 40,
  /** Упоминаний на заметку (лишние игнорируются, как в чате) */
  maxMentions: 50,
  /** Привязок к сущностям на заметку */
  maxRelated: 20,
  /** Страница списка */
  listPageSize: 40,
  /** Папок чужих пространств в разделе «Открытые мне» */
  foreignFoldersLimit: 200,
  /** Заметок в панели на карточке сущности */
  byTargetLimit: 100,
  /** Сниппет в списке/карточке */
  snippetLength: 160,
  /** Корзина: через столько дней удаляется навсегда */
  trashRetentionDays: 30,
  /** Сколько версий содержимого хранить на заметку */
  revisionsKeep: 30,
  /** Батч purge-джоба */
  purgeBatch: 200,
  /** Стикеров на одной доске (папка × человек) */
  boardMaxItems: 200,
  /** Координаты раскладки — пиксели холста; вниз холст растёт, потолок только от мусора */
  boardMaxCoord: 20_000,
  /** Стикер: размеры в px */
  stickyDefaultW: 260,
  stickyDefaultH: 220,
  stickyMinW: 180,
  stickyMinH: 120,
  stickyMaxW: 720,
  stickyMaxH: 720,
  /** Диктовка: жёсткий потолок записи (секунды) — sync-STT принимает ≤25 МБ */
  dictationMaxSeconds: 300,
  /** Чанкинг под RAG (токены оценочные: ~3 символа на токен для кириллицы) */
  chunkCharsPerToken: 3,
  chunkShortNoteTokens: 500,
  chunkTargetTokens: 400,
  chunkMaxTokens: 600,
  chunkOverlapTokens: 60,
  /** Кандидаты пикеров */
  pickerLimit: 20,
} as const;

/** Типы джобов сервиса (core/jobs) */
export const NOTE_JOB_TYPES = {
  /** Проекции после мутации: витрина поиска + чанки (идемпотентно, ключ — версия) */
  project: 'notes.project',
} as const;

/** Горячие клавиши веба (физические коды клавиш — не зависят от раскладки) */
export const NOTE_HOTKEYS = {
  toggleBoard: 'Alt+N',
  newNote: 'Alt+Shift+N',
} as const;

/** Ключ localStorage: язык диктовки */
export const NOTE_STT_LANGUAGE_STORAGE_KEY = 'sa6_notes_stt_lang';

/** Машинные коды ошибок (клиент ветвится по `details.code`, не по русскому тексту) */
export const NOTE_ERROR_CODES = {
  /** PATCH с устаревшей baseVersion: заметку изменили в другом окне */
  versionConflict: 'NOTE_VERSION_CONFLICT',
  /** Привязка к сущности, которую зритель не видит или которой нет */
  targetNotVisible: 'NOTE_TARGET_NOT_VISIBLE',
} as const;
