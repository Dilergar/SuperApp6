/** Константы кабинета платформы: ключи Redis, темы шины, refType заявок. */
export const PLATFORM_REDIS = {
  /** Секунды последней активности сессии (простой > idleMinutes → 401) */
  sessionActive: (sid: string) => `platform:session:${sid}`,
  /** Окно sudo после step-up */
  sudo: (sid: string) => `platform:sudo:${sid}`,
  /** Неудачные пароли на входе по номеру */
  loginFail: (phone: string) => `platform:loginfail:${phone}`,
  /** Неудачные пароли на step-up (по сотруднику: сессия уже есть, номер не нужен) */
  stepUpFail: (userId: string) => `platform:stepupfail:${userId}`,
  /** Кэш ролей/capabilities сотрудника (60 с) */
  caps: (userId: string) => `platform:caps:${userId}`,
  /** Троттлинг чтений на сотрудника */
  rate: (kind: string, userId: string, window: string) => `platform:rate:${kind}:${userId}:${window}`,
} as const;

export const PLATFORM_CAPS_TTL_SEC = 60;

export const PLATFORM_BUS_EVENTS = {
  /** `{auditId, commandKey, actorId, targetType, targetId}` — после коммита команды */
  commandExecuted: 'platform.command.executed',
} as const;

/** refType заявки four-eyes в core/approvals; originType — тот же (хук возврата) */
export const PLATFORM_COMMAND_REF_TYPE = 'platform_command';

/** Ключ строки политики */
export const PLATFORM_POLICY_ID = 'default';

/** Служебные ключи журнала (не команды реестра) */
export const PLATFORM_AUDIT_KEYS = {
  bootstrap: 'platform.staff.bootstrap',
  httpDenied: 'http.denied',
  login: 'platform.auth.login',
  logout: 'platform.auth.logout',
  stepUp: 'platform.auth.step_up',
} as const;
