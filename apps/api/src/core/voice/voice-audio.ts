import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Подготовка звука перед STT: транскод в 16 кГц mono WAV + лёгкий серверный
 * шумодав (highpass + afftdn) и выравнивание громкости (dynaudnorm) — точность
 * распознавания растёт, играбельный оригинал НЕ трогаем (шумодав живого звука
 * делают браузерные constraints при записи). Бинарники ffmpeg-static/ffprobe-static;
 * их отсутствие не валит движок — отдаём оригинал (whisper-server сам декодит
 * большинство контейнеров).
 */

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

  async prepareForStt(sourcePath: string, originalMime: string, originalName: string): Promise<PreparedAudio> {
    const bins = this.ffBinaries();
    const passthrough: PreparedAudio = {
      path: sourcePath,
      mime: originalMime,
      fileName: safeFileName(originalName, originalMime),
      durationMs: null,
      cleanup: async () => undefined,
    };
    if (!bins) {
      this.logger.warn('ffmpeg недоступен — STT получит оригинальные байты');
      return passthrough;
    }

    const durationMs = await this.probeDurationMs(bins.ffprobe, sourcePath);
    const out = path.join(os.tmpdir(), `sa6-voice-${randomUUID()}.wav`);
    try {
      await this.execFF(bins.ffmpeg, [
        '-y',
        '-i', sourcePath,
        '-ac', '1',
        '-ar', '16000',
        '-af', 'highpass=f=80,afftdn=nf=-25,dynaudnorm',
        '-c:a', 'pcm_s16le',
        out,
      ]);
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
    const bin = ffprobeBin ?? this.ffBinaries()?.ffprobe ?? null;
    if (!bin) return null;
    try {
      const raw = await this.execFF(bin, [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        sourcePath,
      ]);
      const data = JSON.parse(raw) as { format?: { duration?: string } };
      const sec = data.format?.duration ? parseFloat(data.format.duration) : NaN;
      return Number.isFinite(sec) ? Math.round(sec * 1000) : null;
    } catch {
      return null;
    }
  }

  /** ffmpeg-static/ffprobe-static: их отсутствие не валит движок (dev без бинарников) */
  ffBinaries(): { ffmpeg: string; ffprobe: string } | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ffmpeg: string | null = require('ffmpeg-static');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ffprobe: { path: string } = require('ffprobe-static');
      if (!ffmpeg || !ffprobe?.path) return null;
      return { ffmpeg, ffprobe: ffprobe.path };
    } catch {
      return null;
    }
  }

  /** Таймаут 10 мин: транскод многочасовой записи на CPU — минуты, не секунды */
  private execFF(bin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`${path.basename(bin)}: ${err.message} ${String(stderr).slice(0, 200)}`));
          else resolve(String(stdout));
        },
      );
    });
  }
}

/** Имя файла для multipart: по расширению бэкенд определяет контейнер */
function safeFileName(name: string, mime: string): string {
  const ext = /\.[a-z0-9]{2,5}$/i.test(name) ? '' : extFromMime(mime);
  const base = name.replace(/[^\w.\-Ѐ-ӿ ]+/g, '_').slice(0, 100) || 'audio';
  return `${base}${ext}`;
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'audio/ogg': '.ogg',
    'audio/webm': '.webm',
    'audio/mp4': '.m4a',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/aac': '.aac',
    'audio/x-m4a': '.m4a',
    'audio/flac': '.flac',
  };
  return map[mime.toLowerCase()] ?? '.bin';
}
