// core/keys — публичная поверхность движка для потребителей
export { KeysModule } from './keys.module';
export { KeysStoreService, type LoadedVersion, type LoadedKey } from './keys.store.service';
export { KeysEnvelopeService, type FieldCtx, type DecryptResult } from './keys.envelope.service';
export { KeysMacService } from './keys.mac.service';
export { KeysSigningService, KeysTokenError, type SignOptions, type VerifyOptions } from './keys.signing.service';
export { KeysAuditService, type KeyAuditInput } from './keys.audit.service';
export { KeysFieldRegistry, type EncryptedColumnDef } from './keys.registry';
export { KeysRotationJobs, AUDIENCE_MAX_TTL_SEC } from './keys.rotation.jobs';
export { keysEnv, legacyHs256Open } from './keys.env';
export * from './keys.legacy';
export { parseDurationSec, parseJws } from './keys.jwt';
export { PLATFORM_SCOPE, KEK_NAME, workspaceScope, userScope } from './keys.constants';
