import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import { VOICE_LANGUAGES, VoiceLanguage, VoiceSegment } from '@superapp/shared';

/**
 * STT-клиент голосового движка — реестр драйверов (паттерн process-ai-client):
 *  - `openai_compatible` — POST {VOICE_STT_URL}/v1/audio/transcriptions (multipart,
 *    verbose_json). Покрывает self-host whisper-server/speaches, OpenAI, Groq —
 *    смена провайдера = env. Диаризация: whisper-server при WHISPER_DIARIZATION=true
 *    кладёт `speaker` в сегменты verbose_json — мапим защитно (поле опционально).
 *  - `mock` (VOICE_STT_MOCK=true) — канонический ответ без сети и ffmpeg: CI/verify
 *    гоняют весь конвейер на голой машине.
 * Без VOICE_STT_URL и без mock движок инертен (паттерн ClamAV/Google Calendar).
 */

export interface SttInput {
  filePath: string;
  mime: string;
  /** Имя файла для multipart (по расширению бэкенд определяет контейнер) */
  fileName: string;
  /** undefined = автоопределение языка */
  language?: Exclude<VoiceLanguage, 'auto'>;
  timeoutMs: number;
}

export interface SttResult {
  text: string;
  /** Язык, который определил бэкенд (ISO-код) */
  language: string | null;
  durationSec: number | null;
  segments: VoiceSegment[];
  provider: string;
  model: string;
}

interface VerboseJsonResponse {
  text?: string;
  language?: string;
  duration?: number | string;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
    speaker?: string;
  }>;
}

@Injectable()
export class VoiceSttClient {
  private readonly logger = new Logger(VoiceSttClient.name);

  get mockMode(): boolean {
    return process.env.VOICE_STT_MOCK === 'true';
  }

  get enabled(): boolean {
    return this.mockMode || !!process.env.VOICE_STT_URL;
  }

  /** Капабилити для UI: сегменты могут нести метки спикеров */
  get diarization(): boolean {
    return this.enabled;
  }

  get languages(): readonly VoiceLanguage[] {
    return VOICE_LANGUAGES;
  }

  /** Модель под язык: казахский можно увести на дообученную (VOICE_STT_MODEL_KK) */
  modelFor(language?: string): string {
    if (language === 'kk' && process.env.VOICE_STT_MODEL_KK) return process.env.VOICE_STT_MODEL_KK;
    return process.env.VOICE_STT_MODEL || 'whisper-1';
  }

  async transcribe(input: SttInput): Promise<SttResult> {
    if (this.mockMode) return this.mockTranscribe(input);
    if (!process.env.VOICE_STT_URL) throw new Error('STT не сконфигурирован (VOICE_STT_URL)');
    return this.openAiCompatTranscribe(input);
  }

  // ---------- openai_compatible ----------

  private endpoint(): string {
    const base = (process.env.VOICE_STT_URL as string).replace(/\/+$/, '');
    return base.endsWith('/v1') ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`;
  }

  private async openAiCompatTranscribe(input: SttInput): Promise<SttResult> {
    const model = this.modelFor(input.language);
    const form = new FormData();
    // fs.openAsBlob стримит с диска (Node 20+) — 200-МБ запись не буферизуется в RSS;
    // фолбэк на readFile для сред без openAsBlob
    const openAsBlob = (fs as unknown as { openAsBlob?: (p: string, o: { type: string }) => Promise<Blob> }).openAsBlob;
    const blob = openAsBlob
      ? await openAsBlob(input.filePath, { type: input.mime })
      : new Blob([await fs.promises.readFile(input.filePath)], { type: input.mime });
    form.append('file', blob, input.fileName);
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    if (input.language) form.append('language', input.language);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (process.env.VOICE_STT_API_KEY) headers.Authorization = `Bearer ${process.env.VOICE_STT_API_KEY}`;
      const res = await fetch(this.endpoint(), {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`STT ${res.status}: ${body.slice(0, 300) || res.statusText}`);
      }
      const data = (await res.json()) as VerboseJsonResponse;
      return this.mapVerboseJson(data, 'openai_compatible', model);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`STT-таймаут (${Math.round(input.timeoutMs / 1000)}с)`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private mapVerboseJson(data: VerboseJsonResponse, provider: string, model: string): SttResult {
    const segments: VoiceSegment[] = Array.isArray(data.segments)
      ? data.segments
          .filter((s) => typeof s?.text === 'string')
          .map((s) => ({
            start: typeof s.start === 'number' ? round2(s.start) : 0,
            end: typeof s.end === 'number' ? round2(s.end) : 0,
            text: String(s.text).trim(),
            ...(typeof s.speaker === 'string' && s.speaker ? { speaker: s.speaker } : {}),
          }))
      : [];
    const text = typeof data.text === 'string' && data.text.trim()
      ? data.text.trim()
      : segments.map((s) => s.text).join(' ').trim();
    const durationRaw = typeof data.duration === 'string' ? parseFloat(data.duration) : data.duration;
    return {
      text,
      language: typeof data.language === 'string' ? data.language : null,
      durationSec: typeof durationRaw === 'number' && Number.isFinite(durationRaw) ? durationRaw : null,
      segments,
      provider,
      model,
    };
  }

  // ---------- mock ----------

  private async mockTranscribe(input: SttInput): Promise<SttResult> {
    await new Promise((r) => setTimeout(r, 300));
    const segments: VoiceSegment[] = [
      { start: 0, end: 2.4, text: 'Привет, это тестовая расшифровка голосового движка.', speaker: 'SPEAKER_00' },
      { start: 2.4, end: 5.1, text: 'Отлично слышно, встречаемся завтра в десять.', speaker: 'SPEAKER_01' },
    ];
    return {
      text: segments.map((s) => s.text).join(' '),
      language: input.language ?? 'ru',
      durationSec: 5.1,
      segments,
      provider: 'mock',
      model: 'mock',
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
