import { Global, Module } from '@nestjs/common';
import { WorkspaceContextService } from './workspace-context.service';

/**
 * Provides the request-scoped WorkspaceContext globally so both the DatabaseService
 * (chokepoint middleware) and the WorkspaceContextInterceptor can share one instance.
 */
@Global()
@Module({
  providers: [WorkspaceContextService],
  exports: [WorkspaceContextService],
})
export class WorkspaceContextModule {}
