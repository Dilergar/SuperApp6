import { Controller, Get, Post, Patch, Delete, Body, Param, Query, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { badRequest } from '../../shared/errors/api-error';
import { UsersService } from './users.service';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { updateProfileSchema, changePasswordSchema, changePhoneSchema, deleteAccountSchema, maskLastName, type AccountDeletionBlockersDto } from '@superapp/shared';
import { SkipConsentGate } from '../../shared/decorators/skip-consent-gate.decorator';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  // Мотивированный отказ показывается ДО ввода пароля — и за блокирующим экраном согласий тоже
  @SkipConsentGate()
  @Get('me/deletion-blockers')
  @ApiOperation({ summary: 'What prevents the account deletion right now (sole ownership, open escrow, unfinished orders)' })
  async deletionBlockers(@CurrentUser() user: JwtPayload): Promise<{ success: true; data: AccountDeletionBlockersDto }> {
    return { success: true, data: await this.usersService.deletionBlockers(user.sub) };
  }

  // Профиль нужен шапке блокирующего экрана согласий
  @SkipConsentGate()
  @Get('me')
  @ApiOperation({ summary: 'The current user profile' })
  async getProfile(@CurrentUser() user: JwtPayload) {
    const profile = await this.usersService.getProfile(user.sub);
    return { success: true, data: profile };
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update the profile' })
  async updateProfile(
    @CurrentUser() user: JwtPayload,
    @Body() body: unknown,
  ) {
    const data = updateProfileSchema.parse(body);
    const updated = await this.usersService.updateProfile(user.sub, data);
    return { success: true, data: updated };
  }

  @Get('me/sessions')
  @ApiOperation({ summary: 'The active sessions' })
  async getSessions(@CurrentUser() user: JwtPayload) {
    const sessions = await this.usersService.getSessions(user.sub, user.sid);
    return { success: true, data: sessions };
  }

  @Delete('me/sessions/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End a session' })
  async deleteSession(
    @CurrentUser() user: JwtPayload,
    @Param('id') sessionId: string,
  ) {
    await this.usersService.deleteSession(user.sub, sessionId);
    return { success: true };
  }

  @Post('me/change-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 5, ttl: 900000 } })
  @ApiOperation({ summary: 'Change the password (the current password plus an SMS code; other sessions are revoked)' })
  async changePassword(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const data = changePasswordSchema.parse(body);
    const result = await this.usersService.changePassword(user.sub, data);
    return { success: true, data: result };
  }

  @Post('me/change-phone')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 5, ttl: 900000 } })
  @ApiOperation({ summary: 'Change the phone number (password plus an SMS code to the old and to the new one)' })
  async changePhone(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const data = changePhoneSchema.parse(body);
    const result = await this.usersService.changePhone(user.sub, data);
    return { success: true, data: result };
  }

  // «Не принимаю, удалить аккаунт» — единственный выход из блокирующего экрана помимо принятия
  @SkipConsentGate()
  @Delete('me')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 5, ttl: 900000 } })
  @ApiOperation({
    summary:
      'Schedule the account deletion (= revoke the personal data consent): password + SMS step-up; 14 days to restore by signing in',
  })
  async deleteAccount(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const data = deleteAccountSchema.parse(body ?? {});
    // Единый конверт ответа (контракт API↔клиенты): раньше ручка отдавала голый объект
    return { success: true, data: await this.usersService.scheduleDeletion(user.sub, data) };
  }

  @Get('lookup')
  // Dedicated cap: this endpoint answers "is this phone registered?" — without
  // its own limit an authed user could enumerate the user base at 200/min.
  @Throttle({ long: { limit: 30, ttl: 60 * 60 * 1000 } })
  @ApiOperation({ summary: 'Find a user by phone number' })
  async lookupByPhone(@Query('phone') phone: string) {
    if (!phone) return { success: true, data: null };
    const user = await this.usersService.findByPhone(phone);
    // Privacy (Kaspi-style): until the two are linked, only "Имя Ф." is shown.
    const data = user ? { ...user, lastName: maskLastName(user.lastName) } : null;
    return { success: true, data };
  }
}
