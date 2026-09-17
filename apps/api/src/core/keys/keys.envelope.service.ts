import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { KEYS_ARTIFACT_PREFIX, KEYS_ERROR_CODES, KEY_ALGORITHMS, type KeyScopeRef, type MacKeyName } from '@superapp/shared';
import { forbidden } from '../../shared/errors/api-error';
import { KEK_NAME, PLATFORM_SCOPE, userScope, workspaceScope } from './keys.constants';
import { KeysStoreService, type LoadedVersion } from './keys.store.service';
import { MetricsService } from '../../shared/metrics/metrics.service';
import type { Histogram } from 'prom-client';

/**
 * Контекст поля — уезжает в AAD и связывает шифротекст с ЕГО строкой: перенос значения
 * в другую строку, поле, сущность или организацию не расшифруется криптографически,
 * а не только «проверкой в коде». AAD не хранится и не логируется.
 */
export interface FieldCtx {
  entity: string;
  field: string;
  ownerType: string;
  ownerId: string;
}

export type DecryptResult = { ok: true; value: string } | { ok: false; error: string };

const ENV_PREFIX = KEYS_ARTIFACT_PREFIX.envelope;
const BI_PREFIX = KEYS_ARTIFACT_PREFIX.blindIndex;
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Envelope-шифрование полей: DEK на запись (AES-256-GCM, 32 байта CSPRNG), обёрнутый
 * KEK'ом скоупа (организация / человек / платформа); всё inline в одной text-колонке:
 * `sa6e:1:<kek_kid>:A256GCM:<wrappedDek>:<iv>:<ct+tag>` (base64url). Читаем любой
 * `active`-версией KEK, пишем primary — ротация KEK не трогает данные до фоновой
 * перешивки. Слепой индекс — `sa6b:1:<mac_kid>:<HMAC-SHA256(normalized)>` для
 * поиска по равенству. Права здесь не проверяются (system-слой).
 */
@Injectable()
export class KeysEnvelopeService {
  private readonly logger = new Logger(KeysEnvelopeService.name);

  /** Латентность расшифровки поля (KEK из кэша + два AES-GCM), секунды; метка — только исход */
  private readonly decryptLatency: Histogram<string>;

  constructor(
    private readonly store: KeysStoreService,
    metrics: MetricsService,
  ) {
    this.decryptLatency = metrics.histogram('keys_decrypt_latency_seconds', 'Envelope field decrypt latency', [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1], ['result']);
  }

  scopeKey(scope: KeyScopeRef): string {
    if (scope.type === 'platform') return PLATFORM_SCOPE;
    return scope.type === 'workspace' ? workspaceScope(scope.id) : userScope(scope.id);
  }

  isEnvelope(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.startsWith(`${ENV_PREFIX}:`);
  }

  isBlindIndex(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.startsWith(`${BI_PREFIX}:`);
  }

  private aad(ctx: FieldCtx, kekKid: string): Buffer {
    return Buffer.from(`${ctx.entity}|${ctx.field}|${ctx.ownerType}|${ctx.ownerId}|${kekKid}`, 'utf8');
  }

  /** KEK скоупа — лениво создаётся при первом шифровании. */
  private async kek(scope: KeyScopeRef): Promise<LoadedVersion> {
    const s = this.scopeKey(scope);
    await this.store.ensureKey(s, 'kek', KEK_NAME);
    return this.store.primary(s, 'kek', KEK_NAME);
  }

  async encrypt(scope: KeyScopeRef, ctx: FieldCtx, plaintext: string): Promise<string> {
    const kek = await this.kek(scope);
    return this.encryptWith(kek, ctx, plaintext);
  }

  /** Шифрование заранее взятым KEK (батч одной строки/списка — один unwrap на всё). */
  encryptWith(kek: LoadedVersion, ctx: FieldCtx, plaintext: string): string {
    if (!kek.material) throw forbidden(KEYS_ERROR_CODES.keyUnavailable);
    const dek = randomBytes(32);
    const aad = this.aad(ctx, kek.kid);
    // Данные под DEK
    const iv = randomBytes(IV_LEN);
    const c = createCipheriv('aes-256-gcm', dek, iv);
    c.setAAD(aad);
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]);
    // DEK под KEK (свой IV, тот же AAD)
    const iv2 = randomBytes(IV_LEN);
    const w = createCipheriv('aes-256-gcm', kek.material, iv2);
    w.setAAD(aad);
    const wrapped = Buffer.concat([iv2, w.update(dek), w.final(), w.getAuthTag()]);
    return [ENV_PREFIX, '1', kek.kid, KEY_ALGORITHMS.kek, wrapped.toString('base64url'), iv.toString('base64url'), ct.toString('base64url')].join(':');
  }

  /** `kek_kid` шифротекста (для перешивки и диагностики). */
  kekKidOf(stored: string): string | null {
    const parts = stored.split(':');
    return parts.length === 7 && parts[0] === ENV_PREFIX && parts[1] === '1' ? parts[2]! : null;
  }

  async decrypt(scope: KeyScopeRef, ctx: FieldCtx, stored: string): Promise<string> {
    const r = await this.tryDecrypt(scope, ctx, stored);
    if (!r.ok) throw forbidden(KEYS_ERROR_CODES.keyUnavailable);
    return r.value;
  }

  /** Расшифровка с исходом вместо исключения (списки: одна битая строка не роняет ростер). */
  async tryDecrypt(scope: KeyScopeRef, ctx: FieldCtx, stored: string): Promise<DecryptResult> {
    const started = process.hrtime.bigint();
    const r = await this.tryDecryptInner(scope, ctx, stored);
    this.decryptLatency.observe({ result: r.ok ? 'ok' : r.error }, Number(process.hrtime.bigint() - started) / 1e9);
    return r;
  }

  private async tryDecryptInner(scope: KeyScopeRef, ctx: FieldCtx, stored: string): Promise<DecryptResult> {
    const parts = stored.split(':');
    if (parts.length !== 7 || parts[0] !== ENV_PREFIX || parts[1] !== '1' || parts[3] !== KEY_ALGORITHMS.kek) return { ok: false, error: 'format' };
    const kid = parts[2]!;
    let kek: LoadedVersion;
    try {
      kek = await this.store.usable(kid);
    } catch {
      return { ok: false, error: 'key_unavailable' };
    }
    // Скоуп шифротекста обязан совпасть со скоупом читателя: чужой KEK не годится даже если жив
    if (kek.scope !== this.scopeKey(scope) || kek.purpose !== 'kek') return { ok: false, error: 'scope' };
    return this.decryptWith(kek, ctx, parts);
  }

  private decryptWith(kek: LoadedVersion, ctx: FieldCtx, parts: string[]): DecryptResult {
    try {
      const aad = this.aad(ctx, kek.kid);
      const wrapped = Buffer.from(parts[4]!, 'base64url');
      const iv2 = wrapped.subarray(0, IV_LEN);
      const wct = wrapped.subarray(IV_LEN, wrapped.length - TAG_LEN);
      const wtag = wrapped.subarray(wrapped.length - TAG_LEN);
      const u = createDecipheriv('aes-256-gcm', kek.material!, iv2);
      u.setAAD(aad);
      u.setAuthTag(wtag);
      const dek = Buffer.concat([u.update(wct), u.final()]);
      const iv = Buffer.from(parts[5]!, 'base64url');
      const blob = Buffer.from(parts[6]!, 'base64url');
      const ct = blob.subarray(0, blob.length - TAG_LEN);
      const tag = blob.subarray(blob.length - TAG_LEN);
      const d = createDecipheriv('aes-256-gcm', dek, iv);
      d.setAAD(aad);
      d.setAuthTag(tag);
      return { ok: true, value: Buffer.concat([d.update(ct), d.final()]).toString('utf8') };
    } catch {
      return { ok: false, error: 'integrity' };
    }
  }

  /**
   * Батч: один KEK на скоуп из кэша, дальше AES в памяти. Порядок ответа = порядок входа;
   * `null` в `stored` → `{ok:true, value:''}` не выдумывается — отдаём null.
   */
  async decryptMany(items: Array<{ scope: KeyScopeRef; ctx: FieldCtx; stored: string | null }>): Promise<Array<DecryptResult | null>> {
    const out: Array<DecryptResult | null> = new Array(items.length).fill(null);
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.stored === null || it.stored === undefined) continue;
      out[i] = await this.tryDecrypt(it.scope, it.ctx, it.stored);
    }
    return out;
  }

  /** Перешить DEK шифротекста на primary-версию KEK (данные не трогаются). Не наш формат → как есть. */
  async rewrap(scope: KeyScopeRef, ctx: FieldCtx, stored: string): Promise<string> {
    if (!this.isEnvelope(stored)) return stored;
    const primary = await this.kek(scope);
    if (this.kekKidOf(stored) === primary.kid) return stored;
    const plain = await this.decrypt(scope, ctx, stored);
    return this.encryptWith(primary, ctx, plain);
  }

  // ------------------------------------------------------------
  // Слепой индекс (поиск по равенству без расшифровки)
  // ------------------------------------------------------------

  private async macKey(name: MacKeyName): Promise<LoadedVersion> {
    await this.store.ensureKey(PLATFORM_SCOPE, 'mac', name);
    return this.store.primary(PLATFORM_SCOPE, 'mac', name);
  }

  /** `sa6b:1:<kid>:<hmac>` по НОРМАЛИЗОВАННОМУ значению (E.164, 12 цифр ИИН, lower-case e-mail). */
  async blindIndex(field: string, normalized: string): Promise<string> {
    const key = await this.macKey('blind_index');
    return this.blindIndexWith(key, field, normalized);
  }

  blindIndexWith(key: LoadedVersion, field: string, normalized: string): string {
    if (!key.material) throw forbidden(KEYS_ERROR_CODES.keyUnavailable);
    const mac = createHmac('sha256', key.material).update(`${field}|${normalized}`).digest('base64url');
    return `${BI_PREFIX}:1:${key.kid}:${mac}`;
  }

  /** Все значения индекса, которыми могла быть записана строка (на окне переиндексации — все активные версии). */
  async blindIndexCandidates(field: string, normalized: string): Promise<string[]> {
    const versions = await this.store.activeVersions(PLATFORM_SCOPE, 'mac', 'blind_index');
    if (!versions.length) return [await this.blindIndex(field, normalized)];
    return versions.map((v) => this.blindIndexWith(v, field, normalized));
  }

  /** Сравнить сохранённый индекс с новым значением (константное время). */
  equalsBlindIndex(stored: string, computed: string): boolean {
    const a = Buffer.from(stored);
    const b = Buffer.from(computed);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
