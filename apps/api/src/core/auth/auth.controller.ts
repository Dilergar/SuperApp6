import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { Public } from '../../shared/decorators/public.decorator';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import {
  loginSchema,
  registerSchema,
  refreshTokenSchema,
} from '@superapp/shared';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @ApiOperation({ summary: 'Регистрация нового пользователя' })
  async register(@Body() body: unknown) {
    const data = registerSchema.parse(body);
    const tokens = await this.authService.register(data);
    return { success: true, data: tokens };
  }

  @Public()
  @Post('login')
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Вход в аккаунт' })
  async login(@Body() body: { phone: string; password: string }) {
    const data = loginSchema.parse(body);
    const tokens = await this.authService.login(data.phone, data.password);
    return { success: true, data: tokens };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Обновить токены' })
  async refresh(@Body() body: { refreshToken: string }) {
    const data = refreshTokenSchema.parse(body);
    const tokens = await this.authService.refreshToken(data.refreshToken);
    return { success: true, data: tokens };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Выход из аккаунта' })
  async logout(
    @CurrentUser() user: JwtPayload,
    @Body() body: { refreshToken: string },
  ) {
    await this.authService.logout(user.sub, body.refreshToken);
    return { success: true };
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Выход со всех устройств' })
  async logoutAll(@CurrentUser() user: JwtPayload) {
    await this.authService.logoutAll(user.sub);
    return { success: true };
  }
}
