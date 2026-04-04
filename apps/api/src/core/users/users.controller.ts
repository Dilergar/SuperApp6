import { Controller, Get, Patch, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';

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
    @Body() body: { firstName?: string; lastName?: string; avatar?: string; locale?: string; timezone?: string },
  ) {
    const updated = await this.usersService.updateProfile(user.sub, body);
    return { success: true, data: updated };
  }

  @Get('me/sessions')
  @ApiOperation({ summary: 'Получить активные сессии' })
  async getSessions(@CurrentUser() user: JwtPayload) {
    const sessions = await this.usersService.getSessions(user.sub);
    return { success: true, data: sessions };
  }
}
