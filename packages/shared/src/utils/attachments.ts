import { isVoiceNoteProfile } from '../constants/files';

/** Что показать вместо подписи у attachment-сообщения: ветка каталога + число файлов. */
export type AttachmentPreviewKind = {
  /** Ключ внутри `messenger.attachmentPreview.*` */
  key: 'voice' | 'audio' | 'file' | 'files';
  /** Число файлов — параметр `{n}` у ветки `files` */
  count: number;
};

/**
 * Превью attachment-сообщения без подписи — одна точка правды для API (списки чатов,
 * цитаты) и клиентского фолбэка (socket-превью до рефетча). Функция решает ЧТО
 * показать, а слово даёт каталог у вызывающего: у API язык запроса, у веба — язык
 * зрителя, и одна фраза литералом сделала бы оба языка одним навсегда.
 */
export function attachmentPreviewKind(
  files: Array<{ kind?: string; profile?: string }> | null | undefined,
): AttachmentPreviewKind {
  const n = Array.isArray(files) ? files.length : 0;
  if (n === 1 && files?.[0]?.kind === 'audio') {
    return { key: isVoiceNoteProfile(files[0]?.profile) ? 'voice' : 'audio', count: n };
  }
  return { key: n <= 1 ? 'file' : 'files', count: n };
}
