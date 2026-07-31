'use client';

// ============================================================
// Тосты — замена нативному alert() для сообщений об ошибках.
//
// Почему не alert(): браузер даёт человеку галочку «Блокировать создание
// диалогов», и после неё alert() не показывается ВООБЩЕ. Сообщение об ошибке
// становится невидимым, и неудачное действие выглядит как удачное. Плюс alert
// блокирует поток и рисуется средствами ОС — мимо дизайн-системы.
//
// Устройство намеренно простое: модульный список + подписчики, БЕЗ контекста и
// без зависимостей от кита. Toaster сидит в Providers, то есть в корневом графе
// каждой страницы, — тянуть туда Modal/Icon ради всплывашки нельзя.
// Обновление списка будит только сам Toaster, не дерево приложения.
// ============================================================
import { useEffect, useState } from 'react';

export type ToastTone = 'danger' | 'success' | 'info';

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

let items: ToastItem[] = [];
let nextId = 1;
const subscribers = new Set<(v: ToastItem[]) => void>();

function emit() {
  for (const fn of subscribers) fn(items);
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

/** Показать сообщение. Ошибки живут дольше — их читают, а не замечают. */
export function toast(message: string, tone: ToastTone = 'info') {
  if (!message) return;
  const id = nextId;
  nextId += 1;
  items = [...items, { id, message, tone }];
  emit();
  setTimeout(() => dismiss(id), tone === 'danger' ? 7000 : 4000);
}

/** Частый случай: показать человеческий текст ошибки от API. */
export function toastError(message: string) {
  toast(message, 'danger');
}

export function Toaster() {
  const [list, setList] = useState<ToastItem[]>(items);

  useEffect(() => {
    subscribers.add(setList);
    return () => {
      subscribers.delete(setList);
    };
  }, []);

  // Контейнер живёт в DOM ПОСТОЯННО (и пустым): aria-live-регион, вставленный
  // вместе с первым сообщением, скринридеры часто не озвучивают — регион должен
  // существовать до события. Пустой он ничего не перекрывает: pointer-events
  // отключены на стеке и возвращены самим тостам (globals.css).
  return (
    <div className="toast-stack" role="region" aria-label="Уведомления">
      {list.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.tone}`}
          // assertive только для ошибок: успех не должен перебивать чтение
          role={t.tone === 'danger' ? 'alert' : 'status'}
          aria-live={t.tone === 'danger' ? 'assertive' : 'polite'}
        >
          <span className="toast-text">{t.message}</span>
          <button type="button" className="toast-close" aria-label="Закрыть" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
