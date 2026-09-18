import type { KeysProviderKind } from '@superapp/shared';

/**
 * Разъём под корень доверия. Провайдер отвечает за ДВЕ вещи: (1) обернуть/распаковать
 * материал версии ключа корнем, которого нет в БД; (2) при HSM-ключах — подписать/
 * проверить, не отдавая приватный материал наружу. Всё остальное (AES полей, HMAC
 * индексов) делает движок в памяти на распакованном материале.
 *
 * Реализации: `SoftwareProvider` (файл с правами 0600) — сейчас; `Pkcs11Provider`
 * (YubiHSM 2 / SoftHSM / сертифицированный ГОСТ-модуль по заключению юриста) — слот к проду.
 */
export interface KeyProvider {
  readonly kind: KeysProviderKind;
  /** Отпечаток ТЕКУЩЕГО корня (SHA-256 материала, первые 16 hex) — пишется в каждую версию */
  readonly rootKid: string;
  /**
   * Отпечаток СЛЕДУЮЩЕГО корня на окне ротации (`KEYS_ROOT_KEY_FILE_NEXT`); `null` — окна нет.
   * Пока окно открыто, инстанс читает версии под ЛЮБЫМ из двух корней: перешивка идёт порциями,
   * и состояние «часть под старым, часть под новым» — рабочее, а не аварийное.
   */
  readonly nextRootKid: string | null;
  /** Обернуть материал корнем `rootKid` (по умолчанию — текущим): AAD связывает блоб с версией и назначением */
  wrap(plain: Buffer, aad: string, rootKid?: string): Promise<Buffer>;
  /** Распаковать корнем из строки версии (`rootKid`); корень неизвестен или блоб подменён → KeyProviderError */
  unwrap(wrapped: Buffer, aad: string, rootKid?: string): Promise<Buffer>;
  /** 32 байта CSPRNG — материал KEK/HMAC */
  generateSymmetric(): Promise<Buffer>;
  /** Пара Ed25519: приватный — PKCS#8 DER (будет обёрнут), публичный — SPKI DER */
  generateSigningPair(): Promise<{ privateKey: Buffer; publicKey: Buffer }>;
  sign(privateKey: Buffer, data: Buffer): Promise<Buffer>;
  verify(publicKey: Buffer, data: Buffer, signature: Buffer): Promise<boolean>;
}

export type KeyProviderErrorCode = 'root_missing' | 'root_unreadable' | 'root_mismatch' | 'not_implemented' | 'wrap_format';

export class KeyProviderError extends Error {
  constructor(
    readonly code: KeyProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KeyProviderError';
  }
}

/** DI-токен провайдера (фабрика в KeysModule читает env). */
export const KEY_PROVIDER = Symbol('KEY_PROVIDER');
