import type { Request } from 'express';

/**
 * Отказ доступа, который увидел глобальный фильтр ошибок: 403 (нет права) и 404 (объекта нет
 * или он чужой — существование не раскрываем). Общий слой не знает о движках: слушатель
 * (журнал безопасности `core/audit` — свёртка `authz.denied` и детекция перебора чужих id)
 * регистрирует себя сам, как наблюдатели записи журнала. Сигнал — после отправки ответа,
 * без ожидания: отказ не ждёт журнала, а сбой слушателя не трогает ответ.
 */
export interface AccessDeniedSignal {
  req: Request;
  status: 403 | 404;
  /** `details.code` конверта ошибки */
  code: string | null;
}

type Listener = (signal: AccessDeniedSignal) => void;

const listeners = new Set<Listener>();

export function onAccessDenied(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitAccessDenied(signal: AccessDeniedSignal): void {
  for (const listener of listeners) {
    try {
      listener(signal);
    } catch {
      // слушатель не роняет ответ
    }
  }
}
