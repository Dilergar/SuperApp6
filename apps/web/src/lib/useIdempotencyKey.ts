'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { IDEMPOTENCY_KEY_MAX } from '@superapp/shared';
import { IDEMPOTENCY_KEY_RESET_EVENT } from '@/lib/api-errors';

// ============================================================
// Ключ НАМЕРЕНИЯ формы.
//
// Транспорт сам ставит ключ на каждую мутацию, и этого довольно, чтобы обрыв сети
// не удвоил эффект: повтор того же запроса уходит с тем же ключом. Но двойной клик
// по кнопке — это ДВА запроса, и у каждого был бы свой ключ.
//
// Ключ намерения закрывает и это: пока форма не изменилась и отправка не удалась,
// ключ ОДИН. Он живёт от открытия формы до успеха: успех — новое намерение, правка
// полей — тоже новое (иначе исправленная форма получила бы `422 key_reused`).
//
// Ставится на НЕОБРАТИМЫХ формах (деньги, отправка, подпись) — там, где вторая
// сущность стоит дороже лишней строки в хранилище движка.
// ============================================================

/** uuid браузера; в средах без него (старый WebView) — случайная строка того же вида. */
function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  let out = '';
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

export interface IdempotencyKeyHandle {
  /** Текущий ключ намерения — передаётся в `apiPost(..., { idempotencyKey })` */
  key: string;
  /** Намерение исполнено (успех) либо отменено — следующая попытка это уже другое дело */
  reset: () => void;
}

/**
 * `deps` — значения формы. Их изменение означает НОВОЕ намерение: человек правит
 * поля именно потому, что прошлая попытка его не устроила.
 */
export function useIdempotencyKey(deps: readonly unknown[] = []): IdempotencyKeyHandle {
  const [key, setKey] = useState(newKey);
  const reset = useCallback(() => setKey(newKey()), []);

  // Снимок значений формы: сравниваем по содержимому, а не по ссылке — массив
  // `deps` пересоздаётся на каждом рендере, и сравнение ссылок крутило бы ключ.
  const snapshot = JSON.stringify(deps);
  const seen = useRef(snapshot);
  useEffect(() => {
    if (seen.current === snapshot) return;
    seen.current = snapshot;
    setKey(newKey());
  }, [snapshot]);

  // Сервер сказал «этот ключ уже занят другим запросом» — берём новый, иначе форма
  // залипла бы в 422 навсегда
  useEffect(() => {
    const onReset = () => setKey(newKey());
    window.addEventListener(IDEMPOTENCY_KEY_RESET_EVENT, onReset);
    return () => window.removeEventListener(IDEMPOTENCY_KEY_RESET_EVENT, onReset);
  }, []);

  return { key, reset };
}

// ============================================================
// Ключ намерения для СПИСКА.
//
// У формы одна кнопка — и один хук. У списка кнопка на КАЖДОЙ строке («Купить»
// в витрине скинов, «Принять работу» у каждого исполнителя), и хук на строку не
// завести: строки появляются и исчезают на лету. Общий же ключ на весь список
// склеил бы разные строки в одно намерение, и покупка второго скина получила бы
// `422 key_reused` вместо покупки.
//
// Поэтому намерение здесь — ПАРА «эта попытка × эта строка»: разряд попытки
// (обновляется на успех и по событию протухшего ключа) плюс части строки.
// ============================================================

/** uuid попытки; в средах без crypto.randomUUID — случайная строка того же вида. */
function newNonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  let out = '';
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/** FNV-1a: запасной путь, когда идентификаторы строки не влезают в потолок ключа. */
function fold(parts: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface IdempotencyIntentHandle {
  /** Ключ намерения для строки: `keyFor('skin', id)` */
  keyFor: (...parts: Array<string | number | null | undefined>) => string;
  /** Намерение исполнено — следующая попытка это уже другое дело */
  reset: () => void;
}

export function useIdempotencyIntent(): IdempotencyIntentHandle {
  const [nonce, setNonce] = useState(newNonce);
  const reset = useCallback(() => setNonce(newNonce()), []);

  useEffect(() => {
    const onReset = () => setNonce(newNonce());
    window.addEventListener(IDEMPOTENCY_KEY_RESET_EVENT, onReset);
    return () => window.removeEventListener(IDEMPOTENCY_KEY_RESET_EVENT, onReset);
  }, []);

  const keyFor = useCallback(
    (...parts: Array<string | number | null | undefined>) => {
      // Из ключа выкидываем всё, чего нет в алфавите движка (`[A-Za-z0-9_\-:.]`):
      // иначе строка с эмодзи или пробелом дала бы `400 key_invalid`.
      const tail = parts
        .filter((p) => p !== null && p !== undefined && p !== '')
        .join(':')
        .replace(/[^A-Za-z0-9_\-:.]/g, '');
      const key = `i:${nonce}:${tail}`;
      // Потолок ключа — 128 символов. Длинные составные идентификаторы сворачиваем,
      // а не режем: обрезанный хвост двух соседних строк мог бы совпасть.
      return key.length <= IDEMPOTENCY_KEY_MAX ? key : `i:${nonce}:${fold(tail)}`;
    },
    [nonce],
  );

  return { keyFor, reset };
}
