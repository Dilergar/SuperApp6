/**
 * Имена джобов и очереди сервиса «Документы».
 *
 * Отдельным файлом, а не в сервисе: обработчики живут в `documents.jobs.ts`,
 * а ставит их сервис — общий импорт констант разрывает цикл (приём Диска).
 */
export const DOCUMENTS_QUEUE = 'documents';

/** Сборка .docx по шаблону: подстановка данных организации и сотрудника */
export const DOCUMENTS_GENERATE_JOB = 'documents.generate';

/** PDF-отпечаток текущего содержимого (то, что видит согласующий и что подписывают) */
export const DOCUMENTS_PDF_JOB = 'documents.pdf';

/** Подшивка подписанного документа на Диск организации (реестр вида + личное дело) */
export const DOCUMENTS_FILE_JOB = 'documents.file';

/** Профиль движка файлов для .docx документов организации */
export const DOCUMENTS_FILE_PROFILE = 'document';

export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
