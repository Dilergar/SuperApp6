import { Module, Global } from '@nestjs/common';
import { RolesService } from './roles.service';

@Global()
@Module({
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
