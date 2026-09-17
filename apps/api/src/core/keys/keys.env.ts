import * as path from 'node:path';
import type { KeysPiiReadMode, KeysProviderKind } from '@superapp/shared';
import { isProdEnv } from '../../shared/config/env.validation';

/**
 * Настройки движка ключей — читаются НА ВЫЗОВ (env-константы модуля вычислялись бы
 * до validateEnv в main.ts). Fail-closed: production обязан назвать провайдера и
 * файл корня явно; в development файл по умолчанию лежит в `./.keys/root.key`
 * (генерируется при первом старте, путь — в .env.example).
 */
export interface KeysEnv {
  provider: KeysProviderKind;
  /** Путь к файлу корня (software); в dev — дефолт `./.keys/root.key` */
  rootKeyFile: string;
  /** Файл корня был подставлен дефолтом (только dev) — можно создать при первом старте */
  rootKeyFileIsDefault: boolean;
  /** До этой даты верификаторы принимают legacy HS256 (`JWT_SECRET_LEGACY`); null — окно закрыто */
  legacyHs256Until: Date | null;
  /** Секрет legacy-окна (пусто → HS256 не принимается вовсе) */
  legacySecret: string | null;
  piiReadMode: KeysPiiReadMode;
  pkcs11: { module: string | null; slot: number | null; pin: string | null; keyLabel: string | null };
}

export const DEFAULT_ROOT_KEY_FILE = path.resolve(process.cwd(), '.keys', 'root.key');

export function keysEnv(): KeysEnv {
  const providerRaw = process.env.KEYS_PROVIDER;
  const provider: KeysProviderKind = providerRaw === 'pkcs11' ? 'pkcs11' : 'software';
  const rootRaw = process.env.KEYS_ROOT_KEY_FILE;
  const untilRaw = process.env.KEYS_LEGACY_HS256_UNTIL;
  const until = untilRaw ? new Date(untilRaw) : null;
  const legacySecret = process.env.JWT_SECRET_LEGACY || process.env.JWT_SECRET || null;
  return {
    provider,
    rootKeyFile: rootRaw ? path.resolve(rootRaw) : DEFAULT_ROOT_KEY_FILE,
    rootKeyFileIsDefault: !rootRaw,
    legacyHs256Until: until && Number.isFinite(until.getTime()) ? until : null,
    legacySecret,
    piiReadMode: process.env.KEYS_PII_READ_MODE === 'encrypted' ? 'encrypted' : 'legacy',
    pkcs11: {
      module: process.env.KEYS_PKCS11_MODULE || null,
      slot: process.env.KEYS_PKCS11_SLOT ? Number(process.env.KEYS_PKCS11_SLOT) : null,
      pin: process.env.KEYS_PKCS11_PIN || null,
      keyLabel: process.env.KEYS_PKCS11_KEY_LABEL || null,
    },
  };
}

/** Окно legacy HS256 открыто: секрет задан и дата не наступила. В production без даты окно закрыто. */
export function legacyHs256Open(env: KeysEnv = keysEnv()): boolean {
  if (!env.legacySecret) return false;
  if (!env.legacyHs256Until) return !isProdEnv();
  return Date.now() < env.legacyHs256Until.getTime();
}
