/**
 * Имена джобов и очереди сервиса «Документы».
 *
 * Отдельным файлом, а не в сервисе: обработчики живут в `documents.jobs.ts`,
 * а ставит их сервис — общий импорт констант разрывает цикл (приём Диска).
 */
export const DOCUMENTS_QUEUE = 'documents';

/** Сборка .docx по шаблону: подстановка данных организации и сотрудника */
export const DOCUMENTS_GENERATE_JOB = 'documents.generate';

/**
 * Ключ джоба сборки — ПАРА стабильных ключей на документ (схлопывание пересборок).
 *
 * Прежде каждый PATCH ставил джоб со своим ключом `…:${Date.now()}` — «правка не
 * теряется», но два рендера ОДНОГО документа бежали параллельно, второй падал на
 * оптимистичном замке файла («Файл изменён параллельно») и уходил в бэкофф 30с+,
 * всё это время держа отправку стражем assertNotRebuilding. Теперь: одноимённая
 * постановка схлопывается об живой джоб (среди живых ключ уникален), а правка,
 * пришедшая ПОКА джоб рендерил, не теряется двумя ремнями — постановщик, чей
 * enqueue не лёг (`inserted: false`), ставит ПАРНЫЙ ключ `:r`, и сам обработчик
 * в хвосте сверяет снимок входов и перезаказывает себя парным ключом.
 */
export const docGenKey = (documentId: string, rerun = false): string =>
  rerun ? `doc:gen:${documentId}:r` : `doc:gen:${documentId}`;

/** PDF-отпечаток текущего содержимого (то, что видит согласующий и что подписывают) */
export const DOCUMENTS_PDF_JOB = 'documents.pdf';

/** Подшивка подписанного документа на Диск организации (реестр вида + личное дело) */
export const DOCUMENTS_FILE_JOB = 'documents.file';

/** Профиль движка файлов для .docx документов организации */
export const DOCUMENTS_FILE_PROFILE = 'document';

export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** MIME builder-документов: их файл — сам PDF (рендер конструктора, Gotenberg) */
export const PDF_MIME_TYPE = 'application/pdf';
