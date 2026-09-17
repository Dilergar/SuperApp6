import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { FILE_LIMITS } from '@superapp/shared';
import { KeysSigningService } from '../keys/keys.signing.service';
import { legacyOpen, legacySha256Key } from '../keys/keys.legacy';

/**
 * Подписанные ссылки для local-драйвера (аналог presigned GET): `<img src>`/`<video src>`
 * не умеют слать JWT, поэтому приватная раздача идёт по токен-без-авторизации ссылке
 * с подписью и сроком жизни. ВАЖНО: подписываются ТОЛЬКО query-параметры (fileId:variant:exp) —
 * path нельзя, его переписывает алиас /api ↔ /api/v1 в main.ts.
 *
 * Подпись — Ed25519 аудитории `files_url` keystore (core/keys), `k=<kid>` в query;
 * прошлая HMAC-подпись (ключ, производный от мастер-секрета) принимается без `k`
 * только на legacy-окне и только для проверки.
 */
@Injectable()
export class FilesUrlService {
  constructor(private readonly signing: KeysSigningService) {}

  private apiBase(): string {
    const base = process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
    return base.replace(/\/+$/, '');
  }

  private message(fileId: string, variant: string | null, exp: number): string {
    return `${fileId}:${variant ?? 'original'}:${exp}`;
  }

  async sign(fileId: string, variant: string | null, exp: number): Promise<{ kid: string; sig: string }> {
    return this.signing.signRaw('files_url', this.message(fileId, variant, exp));
  }

  async verify(fileId: string, variant: string | null, exp: number, sig: string, kid?: string | null): Promise<boolean> {
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
    if (!/^[0-9a-f-]{36}$/i.test(fileId)) return false;
    if (kid) return this.signing.verifyRaw('files_url', kid, this.message(fileId, variant, exp), sig);
    // Ссылки прошлой эпохи (без kid): HMAC производным ключом — пока открыто окно
    if (!legacyOpen()) return false;
    const key = legacySha256Key('files:');
    if (!key) return false;
    const expected = Buffer.from(createHmac('sha256', key).update(this.message(fileId, variant, exp)).digest('base64url'));
    const got = Buffer.from(sig);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  /** Приватная ссылка на raw-роут API (local-драйвер) */
  async rawUrl(fileId: string, variant: string | null): Promise<{ url: string; expiresAt: string }> {
    const exp = Math.floor(Date.now() / 1000) + FILE_LIMITS.urlTtlSec;
    const { kid, sig } = await this.sign(fileId, variant, exp);
    const qs = new URLSearchParams();
    if (variant) qs.set('variant', variant);
    qs.set('exp', String(exp));
    qs.set('k', kid);
    qs.set('sig', sig);
    return {
      url: `${this.apiBase()}/api/v1/files/raw/${fileId}?${qs.toString()}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /** Вечная публичная ссылка (неугадываемый токен) */
  publicUrl(publicToken: string): string {
    return `${this.apiBase()}/api/v1/public-files/${publicToken}`;
  }
}
