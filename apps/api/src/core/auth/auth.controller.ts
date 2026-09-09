import { Controller, Post, Body, HttpCode, HttpStatus, Headers } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { Public } from '../../shared/decorators/public.decorator';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import {
  loginSchema,
  registerSchema,
  refreshTokenSchema,
  passwordResetCompleteSchema,
} from '@superapp/shared';

/**
 * User-Agent берём из заголовка ЗДЕСЬ и передаём в сервис: он уезжает в
 * `sessions.device_info`, из-за отсутствия которого список устройств в профиле
 * навсегда показывал «Неизвестное устройство» (колонка в схеме была, писать её
 * было некому). Обрезаем: заголовок присылает кто угодно и любой длины.
 */
function deviceInfoOf(userAgent?: string): string | null {
  const ua = (userAgent ?? '').trim();
  return ua ? ua.slice(0, 255) : null;
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('register')
  @Throttle({ long: { limit: 5, ttl: 900000 } })
  @ApiOperation({ summary: 'Register a new user' })
  async register(@Body() body: unknown, @Headers('user-agent') userAgent?: string) {
    const data = registerSchema.parse(body);
    const tokens = await this.authService.register(data, deviceInfoOf(userAgent));
    return { success: true, data: tokens };
  }

  @Public()
  @Post('login')
  @Throttle({ long: { limit: 5, ttl: 900000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in' })
  async login(@Body() body: unknown, @Headers('user-agent') userAgent?: string) {
    const data = loginSchema.parse(body);
    const tokens = await this.authService.login(data.phone, data.password, deviceInfoOf(userAgent));
    return { success: true, data: tokens };
  }

  @Public()
  @Post('password-reset')
  @Throttle({ long: { limit: 5, ttl: 900000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Finish the password reset (verifyToken from /verify/check) → auto sign-in' })
  async passwordReset(@Body() body: unknown, @Headers('user-agent') userAgent?: string) {
    const data = passwordResetCompleteSchema.parse(body);
    const tokens = await this.authService.resetPassword(
      data.verifyToken,
      data.newPassword,
      deviceInfoOf(userAgent),
    );
    return { success: true, data: tokens };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh the tokens' })
  async refresh(@Body() body: unknown) {
    const data = refreshTokenSchema.parse(body);
    const tokens = await this.authService.refreshToken(data.refreshToken);
    return { success: true, data: tokens };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out' })
  async logout(
    @CurrentUser() user: JwtPayload,
    @Body() body: { refreshToken: string },
  ) {
    await this.authService.logout(user.sub, body.refreshToken);
    return { success: true };
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out on every device' })
  async logoutAll(@CurrentUser() user: JwtPayload) {
    await this.authService.logoutAll(user.sub);
    return { success: true };
  }
}
