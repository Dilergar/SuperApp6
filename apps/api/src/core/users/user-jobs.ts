/**
 * Тип джоба core/jobs: активация приглашений (окружение + организации),
 * висевших на номере пользователя.
 *
 * Живёт отдельным файлом, потому что ставят его ДВА модуля — регистрация
 * (AuthService) и смена номера (UsersService), — а обработчик регистрирует
 * UsersService. Общая константа в нейтральном файле избавляет от импорта
 * одного сервисного модуля в другой ради одной строки.
 */
export const USER_PHONE_INVITATIONS_JOB = 'users.phone.invitations';
/**
 * Псевдонимизация следа стёртого человека вне строки User (реестр core/lifecycle:
 * `ChatterEntry.actorName`, `NotificationEvent.snapshot`) — пачками, джобом из транзакции
 * анонимизации (outbox: падение процесса не теряет редакцию).
 */
export const USER_ANONYMIZE_REDACT_JOB = 'users.anonymize.redact';
