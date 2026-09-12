import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { isDevEnv } from '../../shared/config/env.validation';
import { DatabaseService } from '../../shared/database/database.service';
import { RedisService } from '../../shared/redis/redis.service';
import { forbidden } from '../../shared/errors/api-error';
import { CurrentPlatformActor, PlatformRoute, PlatformSession, type PlatformActor } from '../../shared/decorators/platform.decorator';
import { PLATFORM_REDIS } from './platform.constants';

/**
 * Дев-полигон кабинета (только development/test): «состарить» свою сессию, чтобы
 * сьют проверил простой без ожидания 20 минут. Под тем же гардом, что и всё
 * /platform/* (deny by default): дев-ручка — не дыра.
 */
@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformRoute()
@Controller('platform/dev')
export class PlatformDevController {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  private assertDev(): void {
    if (!isDevEnv()) throw forbidden('dev.developmentOnly');
  }

  @PlatformSession()
  @Post('idle')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Age the current console session past the idle limit' })
  async idle(@CurrentPlatformActor() actor: PlatformActor) {
    this.assertDev();
    await this.db.platformSession.update({ where: { id: actor.sessionId }, data: { lastActiveAt: new Date(Date.now() - 60 * 60_000) } });
    await this.redis.del(PLATFORM_REDIS.sessionActive(actor.sessionId));
    return { success: true, data: { ok: true } };
  }
}
