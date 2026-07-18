// ============================================
// Calls Engine (core/calls) — константы
// ============================================

export const CALL_SESSION_STATUSES = ['active', 'ended'] as const;

// Запись звонка (LiveKit Egress): recording → processing (stop послан) →
// ingesting (вебхук клеймит финализацию) → ready | error. «Активная» запись
// (partial unique «одна на сессию») = recording|processing|ingesting.
export const CALL_RECORDING_STATUSES = ['recording', 'processing', 'ingesting', 'ready', 'error'] as const;

export const CALL_LIMITS = {
  /** TTL токена входа, сек — нужен только на connect (живому соединению LiveKit продлевает сам) */
  tokenTtlSec: 600,
  /**
   * Реконсиляция: активная сессия, чьей комнаты нет в LiveKit, старше N минут закрывается
   * кроном. Держим коротким (клиент подключается за секунды) — иначе «токен взял и не
   * подключился» долго висит фантомным «Идёт звонок» в группах/контекстных чатах.
   */
  reconcileGraceMin: 3,
  /** DM-дозвон: сколько секунд звоним, прежде чем caller сам отменяет (клиентский таймер, WhatsApp ~45с) */
  dmRingTimeoutSec: 45,
} as const;
