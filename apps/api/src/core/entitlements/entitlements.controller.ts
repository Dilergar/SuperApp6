import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { entitlementCheckSchema } from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { EntitlementsService } from './entitlements.service';

/**
 * Снимок контекста (личное пространство либо организация из `X-Workspace-Id`) и
 * батч-проверка. Заголовок контекста прошёл chokepoint — членство проверено ДО нас.
 */
@ApiTags('Entitlements')
@ApiBearerAuth()
@Controller('entitlements')
export class EntitlementsController {
  constructor(private readonly entitlements: EntitlementsService) {}

  @Get('me')
  @ApiOperation({ summary: 'Plan, limits and usage of the request context (personal or X-Workspace-Id)' })
  async me(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.entitlements.snapshot(user.sub) };
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Batch check: can the context add N more of each key (for clients and AI tools)' })
  async check(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const dto = entitlementCheckSchema.parse(body ?? {});
    return { success: true, data: await this.entitlements.check(user.sub, dto.items) };
  }
}
