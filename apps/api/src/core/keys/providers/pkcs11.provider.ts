import * as fs from 'node:fs';
import { KeyProviderError, type KeyProvider } from './key-provider';

/**
 * Слот под HSM / сертифицированную СКЗИ (PKCS#11: YubiHSM 2, SoftHSM, ГОСТ-модуль по
 * заключению юриста — приказ МЦРИАП № 179/НҚ требует СКЗИ ≥ 3 уровня для ПДн
 * ограниченного доступа). Интерфейс и смоук конфигурации есть, реализации нет:
 * бут с `KEYS_PROVIDER=pkcs11` падает честно, а не молча уходит на software.
 */
export class Pkcs11Provider implements KeyProvider {
  readonly kind = 'pkcs11' as const;
  readonly rootKid: string;
  readonly nextRootKid = null;

  constructor(cfg: { module: string | null; slot: number | null; pin: string | null; keyLabel: string | null }) {
    if (!cfg.module || !fs.existsSync(cfg.module)) {
      throw new KeyProviderError('root_missing', `KEYS_PKCS11_MODULE must point to an existing PKCS#11 library (got ${cfg.module ?? 'nothing'})`);
    }
    if (cfg.slot === null || !cfg.pin || !cfg.keyLabel) {
      throw new KeyProviderError('root_missing', 'KEYS_PKCS11_SLOT, KEYS_PKCS11_PIN and KEYS_PKCS11_KEY_LABEL are required with KEYS_PROVIDER=pkcs11');
    }
    this.rootKid = `pkcs11:${cfg.keyLabel}`;
    throw new KeyProviderError('not_implemented', 'the pkcs11 provider is a reserved slot: the certified module is chosen after the legal review (docs/keys_engine.md)');
  }

  wrap(): Promise<Buffer> {
    return Promise.reject(new KeyProviderError('not_implemented', 'pkcs11 wrap is not implemented'));
  }
  unwrap(): Promise<Buffer> {
    return Promise.reject(new KeyProviderError('not_implemented', 'pkcs11 unwrap is not implemented'));
  }
  generateSymmetric(): Promise<Buffer> {
    return Promise.reject(new KeyProviderError('not_implemented', 'pkcs11 generate is not implemented'));
  }
  generateSigningPair(): Promise<{ privateKey: Buffer; publicKey: Buffer }> {
    return Promise.reject(new KeyProviderError('not_implemented', 'pkcs11 generate is not implemented'));
  }
  sign(): Promise<Buffer> {
    return Promise.reject(new KeyProviderError('not_implemented', 'pkcs11 sign is not implemented'));
  }
  verify(): Promise<boolean> {
    return Promise.reject(new KeyProviderError('not_implemented', 'pkcs11 verify is not implemented'));
  }
}
