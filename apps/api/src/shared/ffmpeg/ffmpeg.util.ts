import { execFile } from 'child_process';
import * as path from 'path';

/**
 * Общая обвязка ffmpeg/ffprobe для files-pipeline и voice-audio: поиск статических
 * бинарников, запуск с таймаутом, разбор ffprobe-JSON. Отсутствие бинарников не
 * валит движки — вызывающие деградируют (dev без ffmpeg). Одна копия = фиксы
 * инфраструктуры (maxBuffer, формат ошибок, новые поля probe) не расходятся.
 */

export interface FfBinaries {
  ffmpeg: string;
  ffprobe: string;
}

/** ffmpeg-static/ffprobe-static: их отсутствие не валит движок (dev без бинарников) */
export function ffBinaries(): FfBinaries | null {
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

/** stdout строкой (бинарный вывод — только через временный файл, не сюда) */
export function execFF(bin: string, args: string[], opts?: { timeoutMs?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: opts?.timeoutMs ?? 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${path.basename(bin)}: ${err.message} ${String(stderr).slice(0, 200)}`));
        else resolve(String(stdout));
      },
    );
  });
}

export interface FfprobeInfo {
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

/** Длительность/размеры из ffprobe; любая ошибка → nulls (битый файл ≠ падение конвейера) */
export async function ffprobeFormat(
  ffprobeBin: string,
  source: string,
  opts?: { timeoutMs?: number },
): Promise<FfprobeInfo> {
  try {
    const raw = await execFF(
      ffprobeBin,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', source],
      opts,
    );
    const data = JSON.parse(raw) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    };
    const durationSec = data.format?.duration ? parseFloat(data.format.duration) : NaN;
    const video = data.streams?.find((s) => s.codec_type === 'video');
    return {
      durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
    };
  } catch {
    return { durationMs: null, width: null, height: null };
  }
}
