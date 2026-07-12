import type {
  VOICE_LANGUAGES,
  VOICE_RECORDING_SOURCES,
  VOICE_TRANSCRIPT_STATUSES,
} from '../constants/voice';
import type { FileDto } from './file';

// ============================================
// Voice Engine (core/voice) — типы
// Транскрипт ключуется по файлу: 1 файл = 1 расчёт навсегда.
// Доступ к транскрипту = доступ к файлу (резолвер привязанной сущности).
// ============================================

export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];
export type VoiceTranscriptStatus = (typeof VOICE_TRANSCRIPT_STATUSES)[number];
export type VoiceRecordingSource = (typeof VOICE_RECORDING_SOURCES)[number];

/** Сегмент транскрипта; speaker присутствует, когда STT-бэкенд отдал диаризацию */
export interface VoiceSegment {
  /** Секунды от начала записи */
  start: number;
  end: number;
  text: string;
  /** Метка диаризации ("SPEAKER_00", …) — опциональна, зависит от бэкенда */
  speaker?: string;
}

export interface VoiceTranscriptDto {
  fileId: string;
  status: VoiceTranscriptStatus;
  /** Язык, запрошенный пользователем (auto = автоопределение) */
  language: VoiceLanguage | null;
  /** Язык, который определил STT-бэкенд (ISO-код) */
  detectedLanguage: string | null;
  text: string | null;
  segments: VoiceSegment[] | null;
  durationMs: number | null;
  diarize: boolean;
  error: string | null;
  createdAt: string;
  readyAt: string | null;
}

/** GET /voice/status — веб прячет кнопки расшифровки, когда движок выключен */
export interface VoiceStatusDto {
  enabled: boolean;
  mock: boolean;
  diarization: boolean;
  languages: readonly VoiceLanguage[];
}

/** POST /voice/stt — синхронная расшифровка короткого аудио (команды AI/терминала) */
export interface VoiceSyncSttResult {
  text: string;
  language: string | null;
}

/** Запись Диктофона (файл привязан FileLink'ом refType='voice_recording') */
export interface VoiceRecordingDto {
  id: string;
  ownerId: string;
  title: string;
  source: VoiceRecordingSource;
  language: VoiceLanguage | null;
  durationMs: number | null;
  createdAt: string;
  file: FileDto | null;
  transcriptStatus: VoiceTranscriptStatus | null;
}
