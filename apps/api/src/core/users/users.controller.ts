import { Controller, Get, Patch, Delete, Body, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { updateProfileSchema } from '@superapp/shared';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Получить профиль текущего пользователя' })
  async getProfile(@CurrentUser() user: JwtPayload) {
    const profile = await this.usersService.getProfile(user.sub);
    return { success: true, data: profile };
  }

  @Patch('me')
  @ApiOperation({ summary: 'Обновить профиль' })
  async updateProfile(
    @CurrentUser() user: JwtPayload,
    @Body() body: unknown,
  ) {
    const data = updateProfileSchema.parse(body);
    const updated = await this.usersService.updateProfile(user.sub, data);
    return { success: true, data: updated };
  }

  @Get('me/sessions')
  @ApiOperation({ summary: 'Получить активные сессии' })
  async getSessions(@CurrentUser() user: JwtPayload) {
    const sessions = await this.usersService.getSessions(user.sub);
    return { success: true, data: sessions };
  }

  @Delete('me/sessions/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Завершить сессию' })
  async deleteSession(
    @CurrentUser() user: JwtPayload,
    @Param('id') sessionId: string,
  ) {
    await this.usersService.deleteSession(user.sub, sessionId);
    return { success: true };
  }

  @Get('lookup')
  @ApiOperation({ summary: 'Найти пользователя по номеру телефона' })
  async lookupByPhone(@Query('phone') phone: string) {
    if (!phone) return { success: true, data: null };
    const user = await this.usersService.findByPhone(phone);
    return { success: true, data: user };
  }
}
