'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { VoiceLanguage, VoiceTranscriptDto } from '@superapp/shared';
import { VOICE_LIMITS } from '@superapp/shared';
import { apiErrorMessage } from '../api';
import { getTranscript, requestTranscript } from '../voice-api';
import { voiceTranscriptKey } from '../queries';

// ============================================================
// Транскрипт файла: запрос «Расшифровать» + поллинг с бэкоффом —
// общий хук голосового движка (бабл в чате, деталь Диктофона,
// будущие протоколы). Поллинг — СВОЙ setTimeout-цикл по
// dataUpdatedAt: refetchInterval RQ не перевзводится после
// setQueryData/включения запроса (проверено в браузере) — таймер
// руками детерминирован и одинаков для всех потребителей.
// ============================================================

/** Бэкофф поллинга: 2с первые полминуты → 5с → 15с (длинные записи Диктофона не бомбят API) */
function pollInterval(dto: VoiceTranscriptDto): number {
  const elapsed = Date.now() - new Date(dto.createdAt).getTime();
  if (elapsed < 30_000) return VOICE_LIMITS.pollIntervalMs;
  if (elapsed < 180_000) return VOICE_LIMITS.pollIntervalSlowMs;
  return VOICE_LIMITS.pollIntervalIdleMs;
}

export function useVoiceTranscript(
  fileId: string | null,
  opts?: {
    /** false = не фетчить (бабл ждёт клика «Расшифровать»); дефолт true */
    enabled?: boolean;
  },
) {
  const qc = useQueryClient();
  const [requestError, setRequestError] = useState<string | null>(null);

  const {
    data: transcript,
    dataUpdatedAt,
    refetch,
  } = useQuery<VoiceTranscriptDto | null>({
    queryKey: voiceTranscriptKey(fileId ?? 'none'),
    queryFn: () => getTranscript(fileId as string),
    enabled: !!fileId && (opts?.enabled ?? true),
    refetchOnWindowFocus: false,
  });

  // Поллинг: пока джоб в работе — таймер до следующего refetch. Каждый ответ (и
  // setQueryData из ask) двигает dataUpdatedAt → эффект перевзводит таймер сам;
  // финальный статус/размонтирование гасят цикл.
  const status = transcript?.status;
  useEffect(() => {
    if (status !== 'queued' && status !== 'processing') return;
    if (!transcript) return;
    const timer = setTimeout(() => void refetch(), pollInterval(transcript));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, dataUpdatedAt]);

  /** Запросить расшифровку (идемпотентно). true = принято, ошибка — в requestError */
  const ask = useCallback(
    async (req?: { language?: VoiceLanguage; diarize?: boolean }): Promise<boolean> => {
      if (!fileId) return false;
      setRequestError(null);
      try {
        const dto = await requestTranscript(fileId, req);
        // Свежий ответ POST кладём в кэш — поллинг стартует от него (эффект выше)
        qc.setQueryData(voiceTranscriptKey(fileId), dto);
        return true;
      } catch (err) {
        setRequestError(apiErrorMessage(err));
        return false;
      }
    },
    [fileId, qc],
  );

  return { transcript: transcript ?? null, requestError, ask };
}
