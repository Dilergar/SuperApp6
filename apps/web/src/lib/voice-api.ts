import { isAxiosError } from 'axios';
import type {
  CreateRecordingInput,
  VoiceLanguage,
  VoiceRecordingDto,
  VoiceStatusDto,
  VoiceTranscriptDto,
} from '@superapp/shared';
import { api } from './api';

// ============================================================
// Голосовой движок (core/voice) + Диктофон — API-клиент веба
// ============================================================

export async function getVoiceStatus(): Promise<VoiceStatusDto> {
  const res = await api.get('/voice/status');
  return res.data.data;
}

/** Идемпотентно: 1 файл = 1 транскрипт навсегда (повторный вызов вернёт существующий) */
export async function requestTranscript(
  fileId: string,
  opts?: { language?: VoiceLanguage; diarize?: boolean },
): Promise<VoiceTranscriptDto> {
  const res = await api.post('/voice/transcripts', {
    fileId,
    ...(opts?.language ? { language: opts.language } : {}),
    ...(opts?.diarize !== undefined ? { diarize: opts.diarize } : {}),
  });
  return res.data.data;
}

/** null = расшифровка ещё не запрашивалась (404 движка) */
export async function getTranscript(fileId: string): Promise<VoiceTranscriptDto | null> {
  try {
    const res = await api.get(`/voice/transcripts/${fileId}`);
    return res.data.data;
  } catch (err) {
    if (isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}

// ---- Диктофон ----

export async function listRecordings(): Promise<VoiceRecordingDto[]> {
  const res = await api.get('/recorder/recordings');
  return res.data.data;
}

export async function createRecording(input: CreateRecordingInput): Promise<VoiceRecordingDto> {
  const res = await api.post('/recorder/recordings', input);
  return res.data.data;
}

/** Лёгкий ответ {id,title}: веб патчит title в кэше списка, полный DTO серверу собирать незачем */
export async function renameRecording(id: string, title: string): Promise<{ id: string; title: string }> {
  const res = await api.patch(`/recorder/recordings/${id}`, { title });
  return res.data.data;
}

export async function deleteRecording(id: string): Promise<void> {
  await api.delete(`/recorder/recordings/${id}`);
}
