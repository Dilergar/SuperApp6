import { Injectable } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { FILE_LIMITS } from '@superapp/shared';

/**
 * Подписанные ссылки для local-драйвера (аналог presigned GET): `<img src>`/`<video src>`
 * не умеют слать JWT, поэтому приватная раздача идёт по токен-без-авторизации ссылке
 * с HMAC и сроком жизни. ВАЖНО: подписываются ТОЛЬКО query-параметры (fileId:variant:exp) —
 * path нельзя, его переписывает алиас /api ↔ /api/v1 в main.ts.
 */
@Injectable()
export class FilesUrlService {
  private secret: Buffer | null = null;

  /** Секрет — производный от JWT_SECRET (лениво: .env уже загружен к моменту первого вызова) */
  private getSecret(): Buffer {
    if (!this.secret) {
      this.secret = createHash('sha256').update(`files:${process.env.JWT_SECRET}`).digest();
    }
    return this.secret;
  }

  private apiBase(): string {
    const base = process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
    return base.replace(/\/+$/, '');
  }

  sign(fileId: string, variant: string | null, exp: number): string {
    return createHmac('sha256', this.getSecret())
      .update(`${fileId}:${variant ?? 'original'}:${exp}`)
      .digest('base64url');
  }

  verify(fileId: string, variant: string | null, exp: number, sig: string): boolean {
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
    const expected = this.sign(fileId, variant, exp);
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Приватная ссылка на raw-роут API (local-драйвер) */
  rawUrl(fileId: string, variant: string | null): { url: string; expiresAt: string } {
    const exp = Math.floor(Date.now() / 1000) + FILE_LIMITS.urlTtlSec;
    const sig = this.sign(fileId, variant, exp);
    const qs = new URLSearchParams();
    if (variant) qs.set('variant', variant);
    qs.set('exp', String(exp));
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
