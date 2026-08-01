// ============================================
// OmniDrive («Диск») — константы
//
// Диск это слой ИМЁН И ДЕРЕВА поверх core/files: байтами, квотой, вариантами и
// антивирусом по-прежнему владеет движок файлов. Файл в чате и на Диске — один
// FileObject с двумя FileLink, поэтому байты не копируются, а квота не удваивается.
// ============================================

const MB = 1024 * 1024;

/**
 * refType привязки файла к узлу Диска — он же тип ресурса в core/access.
 * Строка живёт здесь, а не в модуле Диска: на неё смотрит и сам движок файлов
 * («у файла есть место на Диске ⇒ права решает папка»), а импортировать модуль
 * сервиса в движок нельзя.
 */
export const DRIVE_NODE_REF_TYPE = 'drive_node';
export const DRIVE_SPACE_REF_TYPE = 'drive_space';

/** Вид пространства. `project` зарезервирован — в v1 не создаётся. */
export const DRIVE_SPACE_KINDS = ['personal', 'workspace'] as const;

/**
 * Вид узла. `shortcut` («ярлык на чужой файл») заложен колонкой, но интерфейса в v1
 * нет — это задел, а не работающая функция.
 */
export const DRIVE_NODE_KINDS = ['folder', 'file', 'shortcut'] as const;

/**
 * Роли на узле — ровно отношения типа `drive_node` в core/access.
 * Лестница: manager ⇒ editor ⇒ viewer (union в схеме движка).
 */
export const DRIVE_ROLES = ['viewer', 'editor', 'manager'] as const;

/** Числовой ранг роли — «не ниже чем» считается сравнением, а не перечислением */
export const DRIVE_ROLE_RANK: Record<(typeof DRIVE_ROLES)[number], number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
};

/** Порядок сортировки листинга */
export const DRIVE_SORTS = ['name', 'updated', 'size'] as const;
export const DRIVE_SORT_DIRS = ['asc', 'desc'] as const;

/**
 * Системные папки пространства: создаются лениво, не удаляются и не переносятся.
 * Ключ живёт в колонке `systemKey`, название — здесь (переименование не ломает поиск папки).
 */
export const DRIVE_SYSTEM_FOLDERS = {
  chat_uploads: { name: 'Файлы из переписки', icon: 'chats' },
} as const;

export type DriveSystemFolderKey = keyof typeof DRIVE_SYSTEM_FOLDERS;

export const DRIVE_LIMITS = {
  /**
   * Потолок вложенности. Дерево материализовано массивом предков; без потолка одна
   * «папка в папке» на 10 000 уровней превратила бы каждый UPDATE поддерева в мегабайты.
   */
  maxDepth: 32,
  /** Длина имени узла — как у имени файла в движке */
  maxNameLength: 255,
  /** Сколько узлов отдаём за страницу листинга */
  pageSize: 100,
  maxPageSize: 200,
  /** Сколько узлов можно передать в одну пакетную операцию (переместить/удалить/…) */
  maxBulkIds: 200,
  /** Сколько дней узел лежит в корзине до окончательного удаления */
  trashRetentionDays: 30,
  /**
   * Сколько живёт отметка «недавно открывал». Строка заводится на каждую пару
   * (человек, объект) и сама по себе не истекает — без ретеншна таблица растёт вечно,
   * а показываем мы всё равно одну страницу.
   */
  recentRetentionDays: 90,
  /**
   * Ретеншн версий обычного файла — правило движка документов: не «N копий», а БЮДЖЕТ
   * МЕСТА. Снимок это полная копия файла, и «20 версий» у 200-МБ файла означали бы
   * 4 ГБ на один узел; при этом договор на 200 КБ сохраняет все 10.
   */
  historyBudgetBytes: 200 * MB,
  minVersions: 2,
  keepVersions: 10,
  /** Сколько плиток отдаёт одна страница ленты «Фото» */
  photoPageSize: 200,
  /** Сколько «грязных» папок пересчитывает один прогон роллапа */
  rollupBatch: 200,
  /** Сколько узлов удаляет один прогон крона корзины */
  purgeBatch: 200,
} as const;

/**
 * Ключ имени для проверки уникальности в папке: NFC + нижний регистр.
 *
 * Считается В ОДНОМ месте и кладётся отдельной колонкой, потому что «Договор.pdf» и
 * «договор.pdf» — это для человека один файл, а составное «й» (U+0438 U+0306) и
 * готовое «й» (U+0439) выглядят одинаково, но байтами различны: без нормализации
 * частичный unique пропустил бы визуальный дубль.
 */
export function driveNameKey(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/**
 * Свободное имя в папке: «Отчёт.pdf» → «Отчёт (2).pdf» → «Отчёт (3).pdf».
 * Расширение сохраняется — иначе копия перестала бы открываться нужной программой.
 */
export function driveNameWithSuffix(name: string, attempt: number, suffix?: string): string {
  if (attempt <= 1 && !suffix) return name;
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot < name.length - 1;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  const mark = suffix ? ` (${suffix})` : ` (${attempt})`;
  return `${base}${mark}${ext}`;
}

/** Месяц ленты «Фото» — ключ бакета (`YYYY-MM`) */
export function drivePhotoMonth(local: Date): string {
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
