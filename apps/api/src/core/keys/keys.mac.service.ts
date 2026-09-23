import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { KEYS_ARTIFACT_PREFIX, KEYS_ERROR_CODES, type MacKeyName } from '@superapp/shared';
import { forbidden } from '../../shared/errors/api-error';
import { PLATFORM_SCOPE } from './keys.constants';
import { KeysStoreService, type LoadedVersion } from './keys.store.service';

const PREFIX = KEYS_ARTIFACT_PREFIX.mac;

/**
 * Именованные HMAC-ключи платформы (`verify_otp`, `oauth_state`, `api_key_pepper`):
 * один ключ — одно назначение, `kid` в каждом артефакте (`sa6m:1:<kid>:<hmac>`),
 * проверка — любой активной версией (ротация без окна простоя).
 */
@Injectable()
export class KeysMacService {
  constructor(private readonly store: KeysStoreService) {}

  private async primary(name: MacKeyName): Promise<LoadedVersion> {
    await this.store.ensureKey(PLATFORM_SCOPE, 'mac', name);
    return this.store.primary(PLATFORM_SCOPE, 'mac', name);
  }

  /** HMAC primary-версией: `{kid, mac}` (сырой). */
  async mac(name: MacKeyName, data: string | Buffer): Promise<{ kid: string; mac: Buffer }> {
    const v = await this.primary(name);
    if (!v.material) throw forbidden(KEYS_ERROR_CODES.keyUnavailable);
    return { kid: v.kid, mac: createHmac('sha256', v.material).update(data).digest() };
  }

  /** Самодостаточная строка `sa6m:1:<kid>:<b64url>` — для хранения в колонке. */
  async tagged(name: MacKeyName, data: string | Buffer): Promise<string> {
    const { kid, mac } = await this.mac(name, data);
    return `${PREFIX}:1:${kid}:${mac.toString('base64url')}`;
  }

  /**
   * Та же строка КАЖДОЙ активной версией ключа — поиск по равенству сквозь ротацию: строка,
   * записанная прежней версией, находится её собственным `kid` (журнал безопасности: «все
   * события с этого IP»). Порядок — как у keystore (primary первым).
   */
  async taggedAll(name: MacKeyName, data: string | Buffer): Promise<string[]> {
    await this.store.ensureKey(PLATFORM_SCOPE, 'mac', name);
    const versions = await this.store.activeVersions(PLATFORM_SCOPE, 'mac', name);
    return versions.filter((v) => v.material).map((v) => `${PREFIX}:1:${v.kid}:${createHmac('sha256', v.material!).update(data).digest('base64url')}`);
  }

  isTagged(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.startsWith(`${PREFIX}:`);
  }

  /** Проверка сохранённой строки (константное время); версия берётся из `kid`, обязана быть живой. */
  async verifyTagged(name: MacKeyName, data: string | Buffer, stored: string): Promise<boolean> {
    const parts = stored.split(':');
    if (parts.length !== 4 || parts[0] !== PREFIX || parts[1] !== '1') return false;
    let v: LoadedVersion;
    try {
      v = await this.store.usable(parts[2]!);
    } catch {
      return false;
    }
    if (v.scope !== PLATFORM_SCOPE || v.purpose !== 'mac' || v.name !== name || !v.material) return false;
    const expected = createHmac('sha256', v.material).update(data).digest();
    const got = Buffer.from(parts[3]!, 'base64url');
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  /** HMAC сырыми байтами любой активной версии совпадает с ожидаемым? (state OAuth: kid едет в самой строке) */
  async verifyAny(name: MacKeyName, data: string | Buffer, expected: Buffer): Promise<boolean> {
    const versions = await this.store.activeVersions(PLATFORM_SCOPE, 'mac', name);
    for (const v of versions) {
      const mac = createHmac('sha256', v.material!).update(data).digest();
      if (mac.length === expected.length && timingSafeEqual(mac, expected)) return true;
    }
    return false;
  }

  /** Материал pepper'а для хеша ключей API (lookup по хешу — один HMAC на запрос). */
  async pepper(): Promise<{ kid: string; material: Buffer }> {
    const v = await this.primary('api_key_pepper');
    return { kid: v.kid, material: v.material! };
  }

  async pepperVersions(): Promise<Array<{ kid: string; material: Buffer }>> {
    const versions = await this.store.activeVersions(PLATFORM_SCOPE, 'mac', 'api_key_pepper');
    return versions.map((v) => ({ kid: v.kid, material: v.material! }));
  }
}
