import type { ChatMessage } from '@superapp/shared';

// ============================================================
// Состояние ОТПРАВКИ пузыря — только на клиенте.
//
// До движка идемпотентности неотправленный пузырь просто ИСЧЕЗАЛ: человек видел
// свой текст, сеть обрывалась, текст пропадал — и было неясно, дошло сообщение или
// нет. Теперь пузырь остаётся и честно говорит «Не отправлено · Повторить», а
// повтор уходит С ТЕМ ЖЕ ключом: в чате окажется ровно одно сообщение, сколько бы
// раз человек ни нажал.
//
// Поле локальное и в провод НЕ едет: `ChatMessage` — общая форма, сервер таких
// состояний не знает и знать не должен.
// ============================================================

export type LocalSendState = 'pending' | 'failed';

/** Что нужно, чтобы отправить пузырь ещё раз ТЕМ ЖЕ намерением. */
export interface LocalSendDraft {
  kind: 'text' | 'attachment';
  content: string;
  replyToId?: string;
  fileIds?: string[];
}

export interface LocalChatMessage extends ChatMessage {
  /** `id` такого пузыря = ключ повтора (uuid): по нему идёт подмена на сохранённое */
  local?: { state: LocalSendState };
}

export const localStateOf = (m: ChatMessage): LocalSendState | undefined =>
  (m as LocalChatMessage).local?.state;

/** Классификация отказа для аналитики — только коды, без текста ошибки. */
export function sendFailureReason(err: unknown, outcomeUnknown: boolean): 'network' | 'server' | 'unknown_outcome' {
  if (outcomeUnknown) return 'unknown_outcome';
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status ? 'server' : 'network';
}
