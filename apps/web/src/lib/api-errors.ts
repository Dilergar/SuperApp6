'use client';

// ============================================================
// ЕДИНАЯ ДВЕРЬ ОТКАЗОВ API на вебе.
//
// До неё каждое место писало «красный тост с текстом отказа» — 179 копий одной
// строки. Это работало, пока у отказа был ровно один смысл. С движком
// идемпотентности смыслов стало несколько, и они РАЗНЫЕ по тону:
//
//   • `already_completed` — операция УЖЕ прошла. Это успех, а не беда: красный
//     тост здесь заставлял бы человека нажать ещё раз и пугаться;
//   • `in_flight` — первая попытка ещё идёт (транспорт уже повторял сам и сдался):
//     спокойное сообщение, не тревога;
//   • `key_reused` — ключ намерения протух (форму правили между попытками):
//     обычный отказ + сброс ключа, чтобы следующая попытка прошла;
//   • `outcome_unknown` — исход неизвестен. Тостом это показывать НЕЛЬЗЯ: человеку
//     нужно объяснение и путь проверить историю (см. `OutcomeUnknownAlert`).
//
// Заодно у платформы появилась ОДНА точка для будущих кодов (402 тарифа, согласия).
// ============================================================

import { IDEMPOTENCY_ERROR_CODES } from '@superapp/shared';
import { apiErrorDetails, apiErrorMessage } from '@/lib/api';
import { getQueryClient } from '@/lib/session-reset';
import { toast } from '@/lib/toast';

/** Ключ намерения протух: форма обязана взять новый (слушает `useIdempotencyKey`). */
export const IDEMPOTENCY_KEY_RESET_EVENT = 'superapp6:idempotency-key-reset';

/** Машинный код отказа (`details.code`), если сервер его назвал. */
export function apiErrorCode(err: unknown): string | undefined {
  const code = apiErrorDetails(err)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Исход первой попытки неизвестен — форма обязана объяснить это, а не «покраснеть». */
export function isOutcomeUnknown(err: unknown): boolean {
  return apiErrorCode(err) === IDEMPOTENCY_ERROR_CODES.outcomeUnknown;
}

/** Ссылка на созданную сущность, если сервер её знает (`409 already_completed`). */
export function apiErrorResourceId(err: unknown): string | undefined {
  const id = apiErrorDetails(err)?.resourceId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Каким статусом закончилась ПЕРВАЯ попытка (`409 already_completed`).
 *
 * Отличать обязательно: «эффект случился» ≠ «человек добился своего». Первая
 * попытка могла закоммитить часть работы и упасть — тогда снимка тела нет, и
 * движок отвечает тем же `already_completed`. Тон успеха на таком исходе — ложь.
 */
export function apiErrorCompletedStatus(err: unknown): number | undefined {
  const status = apiErrorDetails(err)?.completedStatus;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Показать отказ API человеку. Заменяет прежнюю пару «взять текст отказа → красный
 * тост» ВЕЗДЕ: на старую форму стоит ESLint-страж.
 *
 * Текст всегда берётся с сервера: он собран в языке ЭТОГО запроса, в том числе на
 * повторе (отказ хранится кодом, а не фразой).
 */
export function toastApiError(err: unknown): void {
  const code = apiErrorCode(err);

  if (code === IDEMPOTENCY_ERROR_CODES.alreadyCompleted) {
    // Эффект случился — обычно это значит, что человек добился своего: тон успеха
    // и перечитать данные (экран мог остаться со старым состоянием).
    //
    // Но `already_completed` приходит и тогда, когда первая попытка закоммитила
    // эффект и УПАЛА (снимка тела нет). Зелёный тост на её отказе соврал бы, а
    // данные перечитать нужно в обоих случаях — состояние всё равно изменилось.
    const completed = apiErrorCompletedStatus(err);
    toast(apiErrorMessage(err), completed !== undefined && completed >= 400 ? 'danger' : 'success');
    void getQueryClient()?.invalidateQueries();
    return;
  }

  if (code === IDEMPOTENCY_ERROR_CODES.inFlight) {
    // Транспорт уже повторял сам и исчерпал попытки — сообщаем спокойно
    toast(apiErrorMessage(err), 'info');
    return;
  }

  if (code === IDEMPOTENCY_ERROR_CODES.keyReused) {
    toast(apiErrorMessage(err), 'danger');
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(IDEMPOTENCY_KEY_RESET_EVENT));
    return;
  }

  toast(apiErrorMessage(err), 'danger');
}

