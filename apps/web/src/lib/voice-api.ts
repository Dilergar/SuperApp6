import { isAxiosError } from 'axios';
import type {
  CreateRecordingInput,
  VoiceLanguage,
  VoiceRecordingDto,
  VoiceStatusDto,
  VoiceTranscriptDto,
} from '@superapp/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from './api';

// ============================================================
// Голосовой движок (core/voice) + Диктофон — API-клиент веба
// ============================================================

export async function getVoiceStatus(): Promise<VoiceStatusDto> {
  return apiGet<VoiceStatusDto>('/voice/status');
}

/** Идемпотентно: 1 файл = 1 транскрипт навсегда (повторный вызов вернёт существующий) */
export async function requestTranscript(
  fileId: string,
  opts?: { language?: VoiceLanguage; diarize?: boolean },
): Promise<VoiceTranscriptDto> {
  return apiPost<VoiceTranscriptDto>('/voice/transcripts', {
    fileId,
    ...(opts?.language ? { language: opts.language } : {}),
    ...(opts?.diarize !== undefined ? { diarize: opts.diarize } : {}),
  });
}

/** null = расшифровка ещё не запрашивалась (404 движка) */
export async function getTranscript(fileId: string): Promise<VoiceTranscriptDto | null> {
  try {
    return apiGet<VoiceTranscriptDto | null>(`/voice/transcripts/${fileId}`);
  } catch (err) {
    if (isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}

// ---- Диктофон ----

export async function listRecordings(): Promise<VoiceRecordingDto[]> {
  return apiGet<VoiceRecordingDto[]>('/recorder/recordings');
}

export async function createRecording(input: CreateRecordingInput): Promise<VoiceRecordingDto> {
  return apiPost<VoiceRecordingDto>('/recorder/recordings', input);
}

/** Лёгкий ответ {id,title}: веб патчит title в кэше списка, полный DTO серверу собирать незачем */
export async function renameRecording(id: string, title: string): Promise<{ id: string; title: string }> {
  return apiPatch<{ id: string; title: string }>(`/recorder/recordings/${id}`, { title });
}

export async function deleteRecording(id: string): Promise<void> {
  await apiDelete(`/recorder/recordings/${id}`);
}
