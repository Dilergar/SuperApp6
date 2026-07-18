import { isVoiceNoteProfile } from '../constants/files';

/**
 * Превью attachment-сообщения без подписи («🎤 Голосовое сообщение» / «🎵 Аудио» /
 * «📎 Файл(ы): N») — одна точка правды для API (списки чатов, цитаты) и клиентского
 * фолбэка (socket-превью до рефетча). Правка формулировки = одно место.
 */
export function attachmentPreviewText(
  files: Array<{ kind?: string; profile?: string }> | null | undefined,
): string {
  const n = Array.isArray(files) ? files.length : 0;
  if (n === 1 && files?.[0]?.kind === 'audio') {
    return isVoiceNoteProfile(files[0]?.profile) ? '🎤 Голосовое сообщение' : '🎵 Аудио';
  }
  return n <= 1 ? '📎 Файл' : `📎 Файлы: ${n}`;
}
