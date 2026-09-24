import { Controller, Get, Post, Patch, Delete, Body, Param, Query, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { badRequest } from '../../shared/errors/api-error';
import { UsersService } from './users.service';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { updateProfileSchema, changePasswordSchema, changePhoneSchema, deleteAccountSchema, visibilityPreviewQuerySchema, type AccountDeletionBlockersDto } from '@superapp/shared';
import { NoApiKeys } from '../../shared/decorators/api-keys.decorator';
import { VisibilityExempt } from '../../shared/decorators/visibility.decorator';
import { SkipConsentGate } from '../../shared/decorators/skip-consent-gate.decorator';
import { AuditSessionsService } from '../audit/audit.sessions.service';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private usersService: UsersService,
    private sessions: AuditSessionsService,
  ) {}

  // Мотивированный отказ показывается ДО ввода пароля — и за блокирующим экраном согласий тоже
  @SkipConsentGate()
  @Get('me/deletion-blockers')
  @ApiOperation({ summary: 'What prevents the account deletion right now (sole ownership, open escrow, unfinished orders)' })
  async deletionBlockers(@CurrentUser() user: JwtPayload): Promise<{ success: true; data: AccountDeletionBlockersDto }> {
    return { success: true, data: await this.usersService.deletionBlockers(user.sub) };
  }

  // Профиль нужен шапке блокирующего экрана согласий
  @SkipConsentGate()
  // Свой профиль: человек видит своё целиком (ЗоПД ст. 24) — страж ответа не про него
  @VisibilityExempt('self')
  @Get('me')
  @ApiOperation({ summary: 'The current user profile' })
  async getProfile(@CurrentUser() user: JwtPayload) {
    const profile = await this.usersService.getProfile(user.sub);
    return { success: true, data: profile };
  }

  @Patch('me')
  @VisibilityExempt('self')
  @ApiOperation({ summary: 'Update the profile' })
  async updateProfile(
    @CurrentUser() user: JwtPayload,
    @Body() body: unknown,
  ) {
    const data = updateProfileSchema.parse(body);
    const updated = await this.usersService.updateProfile(user.sub, data);
    return { success: true, data: updated };
  }

  @Post('me/change-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 5, ttl: 900000 } })
  @ApiOperation({ summary: 'Change the password (the current password plus an SMS code; other sessions are revoked)' })
  async changePassword(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const data = changePasswordSchema.parse(body);
    // Cooling (core/audit): свежая неподтверждённая сессия не меняет пароль (угонщик с паролем)
    await this.sessions.assertConfirmed(user);
    const result = await this.usersService.changePassword(user, data);
    return { success: true, data: result };
  }

  @Post('me/change-phone')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 5, ttl: 900000 } })
  @ApiOperation({ summary: 'Change the phone number (password plus an SMS code to the old and to the new one)' })
  async changePhone(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const data = changePhoneSchema.parse(body);
    await this.sessions.assertConfirmed(user);
    const result = await this.usersService.changePhone(user, data);
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

  /**
   * Поиск по номеру (форма приглашения). Находимость — ОТДЕЛЬНАЯ ось (core/visibility):
   * владелец номера, не разрешивший находить себя, неотличим от «не найден» (тот же `null`).
   * Ответ — минимальная карточка по ЕГО правилам: имя, фамилия (посторонним — инициалом),
   * фото. Свой потолок 30/час против перебора номеров.
   */
  @Get('lookup')
  @Throttle({ long: { limit: 30, ttl: 60 * 60 * 1000 } })
  @ApiOperation({ summary: 'Find a person by phone number (only if they allow being found by you)' })
  async lookupByPhone(@CurrentUser() user: JwtPayload, @Query('phone') phone: string) {
    if (!phone) return { success: true, data: null };
    return { success: true, data: await this.usersService.lookupForViewer(user.sub, phone) };
  }

  /**
   * «Моя карточка и видимость» → «Как видит»: своя карточка глазами синтетического зрителя
   * (посторонний / Окружение / Группа / коллега / конкретный человек). Только вычисление
   * плана — никаких чужих сессий и токенов (урок Facebook View As 2018).
   */
  @NoApiKeys()
  @Get('me/card-preview')
  @ApiOperation({ summary: 'Preview my card as a stranger / my circle / a group / a colleague / a person sees it' })
  async cardPreview(@CurrentUser() user: JwtPayload, @Query() q: unknown) {
    const query = visibilityPreviewQuerySchema.parse(q ?? {});
    return { success: true, data: await this.usersService.cardPreview(user.sub, query) };
  }
}
