import { Global, Module } from '@nestjs/common';
import {
  DatabaseService,
  buildScopedPrismaClient,
} from './database.service';
import { WorkspaceContextService } from '../context/workspace-context.service';

/**
 * Provides DatabaseService as a workspace-scoped (chokepoint) Prisma client.
 * The factory connects on startup; the WorkspaceContextService it depends on comes
 * from the @Global WorkspaceContextModule.
 */
@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      inject: [WorkspaceContextService],
      useFactory: async (wsContext: WorkspaceContextService) => {
        const client = buildScopedPrismaClient(wsContext);
        await client.$connect();
        return client;
      },
    },
  ],
  exports: [DatabaseService],
})
export class DatabaseModule {}
