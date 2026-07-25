// ============================================================
// Движок подтверждений (core/verify) — DTO
// ============================================================

import type { VerifyPurpose, VerifyErrorCode } from '../constants/verify';

/**
 * Машиночитаемая часть конверта ошибок движка (`{success:false, …, details}`).
 * Клиент ветвится по `code`, а не по тексту сообщения (текст — для человека и
 * может поменяться в любой момент).
 */
export interface VerifyErrorDetails {
  code?: VerifyErrorCode;
  /** Сколько секунд до следующей возможной отправки (429). */
  resendInSec?: number;
  /** Сколько неверных вводов осталось у цепочки. */
  attemptsLeft?: number;
}

/** Ответ POST /verify/start — цепочка запущена (или ресенд той же). */
export interface VerifyStartResponse {
  challengeId: string;
  /** Секунд до следующей возможной отправки (серверный таймер — клиент не хардкодит). */
  resendInSec: number;
  /** Секунд до истечения кода. */
  ttlSec: number;
  /** Куда ушёл код (маскированный номер для подписи под полем ввода). */
  phoneMasked: string;
  purpose: VerifyPurpose;
}

/** Ответ POST /verify/check — код верен, выдан одноразовый пропуск. */
export interface VerifyCheckResponse {
  /** Одноразовый пропуск (гасится в транзакции целевого действия, TTL 15 мин). */
  verifyToken: string;
}

/** GET /verify/status — что включено (веб адаптирует формы). */
export interface VerifyStatusResponse {
  /** SMS-подтверждение ОБЯЗАТЕЛЬНО для регистрации и сбросов (production-режим). */
  required: boolean;
  /** Реальный SMS-драйвер сконфигурирован (иначе dev/mock). */
  smsEnabled: boolean;
}
