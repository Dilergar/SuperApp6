'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Button } from '@/components/ui';
import { isOutcomeUnknown } from '@/lib/api-errors';

// ============================================================
// «Исход неизвестен» — единственный отказ движка идемпотентности, который НЕЛЬЗЯ
// показывать тостом.
//
// Тост говорит «не получилось» и исчезает; человек нажимает ещё раз. Здесь же
// правда другая: операция МОГЛА ПРОЙТИ, просто сервер не успел подтвердить. Тихо
// подталкивать к повтору в этой ситуации — худшее, что может сделать интерфейс,
// когда за кнопкой стоят деньги. Поэтому плашка остаётся на экране и ведёт туда,
// где видно, прошло ли: в историю операций.
//
// Цветов новых нет — существующий предупреждающий вариант `Alert` кита.
// ============================================================

export function OutcomeUnknownAlert({
  error,
  historyHref,
  onOpenHistory,
  onDismiss,
}: {
  /** Отказ мутации; плашка сама решает, её ли это случай */
  error: unknown;
  /** Куда сходить проверить (история операций, лента записи) — отдельная страница */
  historyHref?: string;
  /** …либо история живёт на ЭТОЙ странице (вкладка, раздел) — переключить её */
  onOpenHistory?: () => void;
  onDismiss?: () => void;
}) {
  const t = useTranslations('common');
  if (!isOutcomeUnknown(error)) return null;
  const open = historyHref ? (
    <Button href={historyHref} size="sm" variant="matte" tone="warning">
      {t('idempotency.openHistory')}
    </Button>
  ) : onOpenHistory ? (
    <Button onClick={onOpenHistory} size="sm" variant="matte" tone="warning">
      {t('idempotency.openHistory')}
    </Button>
  ) : undefined;
  return (
    <Alert tone="warning" title={t('idempotency.outcomeUnknownTitle')} onClose={onDismiss} action={open}>
      {/* Нет перехода — общий запасной вид: тот же текст, только без кнопки */}
      {t('idempotency.outcomeUnknownBody')}
    </Alert>
  );
}

/**
 * Пара к плашке: развилка «этот отказ показывает плашка ИЛИ общая дверь тостов».
 *
 * Без неё каждая необратимая форма писала бы одно и то же: свой `useState`, своё
 * `if (isOutcomeUnknown) … else toastApiError(…)` и свой сброс перед попыткой.
 * Развилка одна на платформу — значит и живёт она в одном месте.
 */
export interface OutcomeUnknownHandle {
  /** Последний отказ «исход неизвестен» — отдаётся плашке как есть */
  error: unknown;
  /**
   * Забрать отказ себе (`true`) либо отдать вызывающему (`false` → `toastApiError`).
   * Любой ДРУГОЙ отказ гасит плашку: она говорила о прошлой попытке, и держать её
   * рядом со свежей ошибкой — врать дважды.
   */
  capture: (err: unknown) => boolean;
  clear: () => void;
}

export function useOutcomeUnknown(): OutcomeUnknownHandle {
  const [error, setError] = useState<unknown>(null);
  const capture = useCallback((err: unknown) => {
    const mine = isOutcomeUnknown(err);
    setError(mine ? err : null);
    return mine;
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { error, capture, clear };
}

/**
 * «Проверяем соединение…» — подпись у кнопки, когда транспорт уже несколько секунд
 * повторяет запрос сам. Без неё долгий авто-повтор выглядит как зависшая кнопка, и
 * человек ищет способ нажать ещё раз (а кнопка в это время заблокирована — и правильно).
 */
export function SlowRequestNote({ pending, afterMs = 3000 }: { pending: boolean; afterMs?: number }) {
  const t = useTranslations('common');
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!pending) {
      setShow(false);
      return;
    }
    const id = setTimeout(() => setShow(true), afterMs);
    return () => clearTimeout(id);
  }, [pending, afterMs]);
  if (!pending || !show) return null;
  return (
    <span className="label-sm" style={{ opacity: 0.75 }}>
      {t('idempotency.checkingConnection')}
    </span>
  );
}
