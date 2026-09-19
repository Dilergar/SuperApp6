import { SetMetadata } from '@nestjs/common';

export const SKIP_CONSENT_GATE_KEY = 'skipConsentGate';

/**
 * Белый список шлюза согласий (core/consents): маршрут работает, даже когда у человека
 * есть непринятые обязательные документы. Ставится ТОЛЬКО на то, без чего блокирующий
 * экран не исполнить: вход/выход, сами согласия, профиль для шапки, удаление аккаунта
 * и его блокеры. Всё остальное закрыто по умолчанию (`403 consents.pending`).
 */
export const SkipConsentGate = () => SetMetadata(SKIP_CONSENT_GATE_KEY, true);
