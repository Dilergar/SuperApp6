// ============================================================
// core/idempotency — публичная дверь движка для сервисов
// ============================================================
export { IdempotencyModule } from './idempotency.module';
export { IdempotencyService } from './idempotency.service';
export { IdempotencyInboxService, type InboxRef, type InboxVerdict } from './idempotency.inbox.service';
export {
  IdempotencyReplayRegistry,
  type ReplayContext,
  type ReplayGate,
  type ReplayGateRequest,
  type ReplayRenderer,
} from './idempotency.replay.registry';
export { IDEMPOTENCY_PRINCIPALS, type IdempotencyPrincipalKind } from './idempotency.constants';
