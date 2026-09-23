import { defineNotifications } from './types';

/**
 * Безопасность аккаунта: смена пароля/номера (core/verify, core/users), заражённый
 * файл (core/files), журнал безопасности (core/audit). Критично — неотключаемо. SMS о смене пароля — по opt-in
 * (уйдёт на текущий номер); о смене номера — нет: номер только что сменился.
 */
export const SECURITY_NOTIFICATIONS = defineNotifications({
  'auth.password.changed': { service: 'security', priority: 'critical', icon: 'lock', contexts: 'personal', collapse: 'none', smsEligible: true },
  'auth.phone.changed': { service: 'security', priority: 'critical', icon: 'device', contexts: 'personal', collapse: 'none' },
  'files.scan.infected': { service: 'security', priority: 'critical', icon: 'shield', contexts: 'personal', collapse: 'none' },
  // Прокрученный refresh-токен предъявлен повторно вне окна grace (RFC 9700 §2.2.2):
  // семейство сессии отозвано целиком — владельцу нужно знать, что токен утёк.
  'auth.session.reuseDetected': { service: 'security', priority: 'critical', icon: 'shield', contexts: 'personal', collapse: 'none', smsEligible: true },

  // ---- core/audit: журнал безопасности ----
  // Шлёт движок журнала САМ в транзакции события (паспорт `notify`), продюсер не дублирует.
  // Тексты — без ссылок (фишинг прикидывается нашими письмами), с причиной «почему вы это
  // получили»; SMS — только когда у человека нет живого push-устройства (правило продюсера).
  'security.login.newDevice': { service: 'security', priority: 'critical', icon: 'device', contexts: 'personal', collapse: 'none', smsEligible: true },
  'security.login.newCountry': { service: 'security', priority: 'critical', icon: 'globe', contexts: 'personal', collapse: 'none', smsEligible: true },
  'security.login.locked': { service: 'security', priority: 'critical', icon: 'lock', contexts: 'personal', collapse: 'none', smsEligible: true },
  'security.account.frozen': { service: 'security', priority: 'critical', icon: 'snowflake', contexts: 'personal', collapse: 'none', smsEligible: true },
  'security.account.unfrozen': { service: 'security', priority: 'critical', icon: 'snowflake', contexts: 'personal', collapse: 'none', smsEligible: true },
  'security.notMe.completed': { service: 'security', priority: 'critical', icon: 'shield', contexts: 'personal', collapse: 'none' },
  // Устройство забыли из ДРУГОЙ сессии (своё текущее устройство человек забыть не может)
  'security.device.forgotten': { service: 'security', priority: 'critical', icon: 'device', contexts: 'personal', collapse: 'none' },
  // Выгрузка журнала организации готова — владельцу и админам (файл на Диске в «Безопасности»)
  'security.org.exportReady': { service: 'security', priority: 'high', icon: 'download', contexts: 'workspace', collapse: 'none' },
  // Детекция mass_export внутри организации: владелец и админы узнают о массовой выгрузке данных
  // своим журналом (ссылка — на событие-причину в журнале организации); одна тревога — одно письмо
  'security.org.massExport': { service: 'security', priority: 'high', icon: 'warning', contexts: 'workspace', collapse: 'none' },
});
