import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AUDIO_MIME_TO_EXT } from '@superapp/shared';
import { execFF, ffBinaries, ffprobeFormat } from '../../shared/ffmpeg/ffmpeg.util';
import { mediaSemaphore } from '../../shared/utils/semaphore';

/**
 * Подготовка звука перед STT: транскод в 16 кГц mono WAV + лёгкий серверный
 * шумодав (highpass + afftdn) и выравнивание громкости (dynaudnorm) — точность
 * распознавания растёт, играбельный оригинал НЕ трогаем (шумодав живого звука
 * делают браузерные constraints при записи). Обвязка ffmpeg — общая
 * (shared/ffmpeg); отсутствие бинарников не валит движок — отдаём оригинал
 * (whisper-server сам декодит большинство контейнеров).
 */

/** Таймаут ffmpeg-шагов подготовки: транскод многочасовой записи на CPU — минуты, не секунды */
const PREP_TIMEOUT_MS = 10 * 60 * 1000;

export interface PreparedAudio {
  path: string;
  mime: string;
  fileName: string;
  durationMs: number | null;
  cleanup(): Promise<void>;
}

@Injectable()
export class VoiceAudioPrep {
  private readonly logger = new Logger(VoiceAudioPrep.name);

  /**
   * knownDurationMs — длительность, уже посчитанная конвейером files при загрузке:
   * когда она есть, 200-МБ файл не перепробивается лишним ffprobe.
   */
  async prepareForStt(
    sourcePath: string,
    originalMime: string,
    originalName: string,
    knownDurationMs?: number | null,
  ): Promise<PreparedAudio> {
    const bins = ffBinaries();
    const passthrough: PreparedAudio = {
      path: sourcePath,
      mime: originalMime,
      fileName: safeFileName(originalName, originalMime),
      durationMs: knownDurationMs ?? null,
      cleanup: async () => undefined,
    };
    if (!bins) {
      this.logger.warn('ffmpeg недоступен — STT получит оригинальные байты');
      return passthrough;
    }

    const durationMs = knownDurationMs ?? (await this.probeDurationMs(bins.ffprobe, sourcePath));
    const out = path.join(os.tmpdir(), `sa6-voice-${randomUUID()}.wav`);
    try {
      // Пер-инстансный лимит медиа-CPU: транскод часовой записи — минуты ffmpeg;
      // параллельные джобы/синхронный /voice/stt без потолка душили бы инстанс.
      await mediaSemaphore.run(() =>
        execFF(
          bins.ffmpeg,
          [
            '-y',
            '-i', sourcePath,
            '-ac', '1',
            '-ar', '16000',
            '-af', 'highpass=f=80,afftdn=nf=-25,dynaudnorm',
            '-c:a', 'pcm_s16le',
            out,
          ],
          { timeoutMs: PREP_TIMEOUT_MS },
        ),
      );
      const stat = await fs.promises.stat(out);
      if (!stat.size) throw new Error('пустой результат транскода');
      return {
        path: out,
        mime: 'audio/wav',
        fileName: 'audio.wav',
        durationMs,
        cleanup: () => fs.promises.unlink(out).catch(() => undefined) as Promise<void>,
      };
    } catch (err) {
      await fs.promises.unlink(out).catch(() => undefined);
      this.logger.warn(`prep не удался (${err instanceof Error ? err.message : err}) — оригинал в STT`);
      return { ...passthrough, durationMs };
    }
  }

  async probeDurationMs(ffprobeBin: string | null, sourcePath: string): Promise<number | null> {
    const bin = ffprobeBin ?? ffBinaries()?.ffprobe ?? null;
    if (!bin) return null;
    return (await ffprobeFormat(bin, sourcePath, { timeoutMs: PREP_TIMEOUT_MS })).durationMs;
  }
}

/** Имя файла для multipart: по расширению бэкенд определяет контейнер */
function safeFileName(name: string, mime: string): string {
  const ext = /\.[a-z0-9]{2,5}$/i.test(name) ? '' : extFromMime(mime);
  const base = name.replace(/[^\w.\-Ѐ-ӿ ]+/g, '_').slice(0, 100) || 'audio';
  return `${base}${ext}`;
}

/** Каноническая карта контейнеров — в shared (одна точка с AUDIO_MIME и веб-нормализацией) */
function extFromMime(mime: string): string {
  return AUDIO_MIME_TO_EXT[mime.toLowerCase()] ?? '.bin';
}
