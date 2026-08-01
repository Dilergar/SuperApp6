/**
 * Имена фоновых типов Диска — в отдельном файле, а не рядом с обработчиками:
 * DriveService ставит джобы, DriveJobs их обрабатывает и при этом импортирует
 * DriveService. Держать константы в файле обработчиков означало бы цикл импортов,
 * в котором значение может оказаться undefined в момент инициализации.
 */
export const DRIVE_INGEST_JOB = 'drive.ingest';
export const DRIVE_ROLLUP_JOB = 'drive.rollup';
export const DRIVE_COPY_JOB = 'drive.copy';
export const DRIVE_PHOTO_JOB = 'drive.photo.index';

/** Своя очередь: копия папки и пересчёт роллапов держат слот минутами */
export const DRIVE_QUEUE = 'drive';

/** Роль связи файла-снимка версии (отдельная от 'attachment') */
export const DRIVE_VERSION_LINK_ROLE = 'version';
