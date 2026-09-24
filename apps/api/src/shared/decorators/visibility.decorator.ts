import { SetMetadata } from '@nestjs/common';

// ============================================================
// core/visibility — объявление ручки для стража ответа (`VisibilityResponseGuard`).
// ============================================================

export const VISIBILITY_EXEMPT_KEY = 'visibility:exempt';

/**
 * Закрытый список причин, по которым ответ с «защищёнными» ключами НЕ проходит `shape()`:
 * - `self` — человек читает СВОИ данные (`/users/me`, свой реестр ключей): «сам видит своё»;
 * - `console` — Кабинет платформы: свои маски и своё раскрытие командой (`platform.pii.reveal`);
 * - `input_echo` — ответ повторяет то, что вызывающий САМ только что прислал (создание записи).
 * Неизвестная причина — ошибка компиляции.
 */
export type VisibilityExemptReason = 'self' | 'console' | 'input_echo';

export const VisibilityExempt = (reason: VisibilityExemptReason) => SetMetadata(VISIBILITY_EXEMPT_KEY, reason);
