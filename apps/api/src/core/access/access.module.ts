import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service';
import { AccessProjectionService } from './access-projection.service';
import { AccessReconcileCron } from './access-reconcile.cron';
import { AccessLifecycleProvider } from './access.lifecycle.provider';

/**
 * Unified authorization engine (core/access). @Global so any module can inject
 * AccessService ("can this subject do X on this resource") or AccessProjectionService
 * (mirror domain membership/roles into tuples) without importing.
 * DatabaseService + RedisService come from the @Global Database/Redis modules.
 */
@Global()
@Module({
  providers: [AccessLifecycleProvider, AccessService, AccessProjectionService, AccessReconcileCron],
  exports: [AccessService, AccessProjectionService],
})
export class AccessModule {}
