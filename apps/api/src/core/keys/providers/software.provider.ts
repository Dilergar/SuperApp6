import { Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDevEnv } from '../../../shared/config/env.validation';
import { ed25519Sign, ed25519Verify, generateEd25519 } from '../keys.jwt';
import { KeyProviderError, type KeyProvider } from './key-provider';

/** Версия формата обёртки: `WRAP_V1 | iv(12) | tag(16) | ct` */
const WRAP_V1 = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const ROOT_LEN = 32;

/**
 * Корень — 32 байта из файла (hex-строка, base64 или сырые байты). Файл создаётся
 * церемонией `apps/api/scripts/keys-init-root.cjs` (две офлайн-копии у двух людей),
 * права 0600; в development отсутствующий файл по дефолтному пути создаётся при
 * первом старте с громким предупреждением — в production отсутствие = отказ бута.
 */
export class SoftwareProvider implements KeyProvider {
  readonly kind = 'software' as const;
  readonly rootKid: string;
  readonly nextRootKid: string | null;
  /** Все корни, которые держит инстанс: текущий и (на окне ротации) следующий — по отпечатку */
  private readonly roots = new Map<string, Buffer>();
  private readonly logger = new Logger(SoftwareProvider.name);

  constructor(rootKeyFile: string, opts: { createIfMissing: boolean; nextRootKeyFile?: string | null }) {
    const root = SoftwareProvider.loadRoot(rootKeyFile, opts.createIfMissing, this.logger);
    this.rootKid = SoftwareProvider.fingerprint(root);
    this.roots.set(this.rootKid, root);
    let nextKid: string | null = null;
    if (opts.nextRootKeyFile) {
      // Следующий корень НИКОГДА не создаётся молча: его делает церемония (две офлайн-копии)
      const next = SoftwareProvider.loadRoot(opts.nextRootKeyFile, false, this.logger);
      const kid = SoftwareProvider.fingerprint(next);
      if (kid !== this.rootKid) {
        this.roots.set(kid, next);
        nextKid = kid;
      }
    }
    this.nextRootKid = nextKid;
  }

  private rootOf(rootKid: string): Buffer {
    const root = this.roots.get(rootKid);
    if (!root) throw new KeyProviderError('root_mismatch', `this instance does not hold the root ${rootKid} (holds: ${[...this.roots.keys()].join(', ')})`);
    return root;
  }

  static fingerprint(root: Buffer): string {
    return createHash('sha256').update(root).digest('hex').slice(0, 16);
  }

  /** Разбор содержимого файла: hex (64 символа) → base64 (44) → сырые 32 байта. */
  static parseRoot(raw: Buffer): Buffer | null {
    if (raw.length === ROOT_LEN) return Buffer.from(raw);
    const text = raw.toString('utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
    if (/^[A-Za-z0-9+/=_-]{43,44}$/.test(text)) {
      const b = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (b.length === ROOT_LEN) return b;
    }
    return null;
  }

  private static loadRoot(file: string, createIfMissing: boolean, logger: Logger): Buffer {
    if (!fs.existsSync(file)) {
      if (!createIfMissing || !isDevEnv()) {
        throw new KeyProviderError(
          'root_missing',
          `root key file not found: ${file} (create it with apps/api/scripts/keys-init-root.cjs; production never generates it silently)`,
        );
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fresh = randomBytes(ROOT_LEN).toString('hex') + '\n';
      try {
        // `wx`: второй процесс, стартовавший одновременно (API + скрипт), НЕ перезапишет уже
        // созданный корень — иначе первый остался бы с корнем в памяти, которого нет на диске
        fs.writeFileSync(file, fresh, { mode: 0o600, flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      logger.warn(
        `⚠️  Generated a DEVELOPMENT root key at ${file}. Everything encrypted by this API is bound to it: back it up or accept losing the data. ` +
          'Production requires KEYS_ROOT_KEY_FILE created by the key ceremony (keys-init-root.cjs).',
      );
    }
    let raw: Buffer;
    try {
      raw = fs.readFileSync(file);
    } catch (err) {
      throw new KeyProviderError('root_unreadable', `root key file ${file} is not readable: ${(err as Error).message}`);
    }
    const root = SoftwareProvider.parseRoot(raw);
    if (!root) throw new KeyProviderError('root_unreadable', `root key file ${file} must hold 32 bytes (hex, base64 or raw)`);
    // Права: на POSIX файл, читаемый группой/всеми, — ошибка конфигурации (в production — отказ)
    if (process.platform !== 'win32') {
      const mode = fs.statSync(file).mode & 0o777;
      if (mode & 0o077) {
        const msg = `root key file ${file} is readable by others (mode ${mode.toString(8)}); chmod 600 it`;
        if (!isDevEnv()) throw new KeyProviderError('root_unreadable', msg);
        logger.warn(`⚠️  ${msg}`);
      }
    }
    return root;
  }

  async wrap(plain: Buffer, aad: string, rootKid: string = this.rootKid): Promise<Buffer> {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.rootOf(rootKid), iv, { authTagLength: TAG_LEN });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([WRAP_V1]), iv, cipher.getAuthTag(), ct]);
  }

  async unwrap(wrapped: Buffer, aad: string, rootKid?: string): Promise<Buffer> {
    if (wrapped.length < 1 + IV_LEN + TAG_LEN || wrapped[0] !== WRAP_V1) {
      throw new KeyProviderError('wrap_format', 'wrapped material has an unknown format');
    }
    const iv = wrapped.subarray(1, 1 + IV_LEN);
    const tag = wrapped.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
    const ct = wrapped.subarray(1 + IV_LEN + TAG_LEN);
    // Корень называет сама строка версии (`root_kid`); без подсказки — пробуем все, что держим
    const candidates = rootKid ? [this.rootOf(rootKid)] : [...this.roots.values()];
    for (const root of candidates) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', root, iv, { authTagLength: TAG_LEN });
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]);
      } catch {
        /* следующий кандидат */
      }
    }
    throw new KeyProviderError('root_mismatch', 'wrapped material does not open with this root key (rotated root or tampered row)');
  }

  async generateSymmetric(): Promise<Buffer> {
    return randomBytes(ROOT_LEN);
  }

  async generateSigningPair(): Promise<{ privateKey: Buffer; publicKey: Buffer }> {
    return generateEd25519();
  }

  async sign(privateKey: Buffer, data: Buffer): Promise<Buffer> {
    return ed25519Sign(privateKey, data);
  }

  async verify(publicKey: Buffer, data: Buffer, signature: Buffer): Promise<boolean> {
    return ed25519Verify(publicKey, data, signature);
  }
}
