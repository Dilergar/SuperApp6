import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

/**
 * Вход, регистрация, refresh. Подпись токенов — `KeysSigningService` (core/keys, @Global):
 * EdDSA, `kid`, аудитория `product`; JwtModule/passport здесь больше нет — проверку
 * подписи и живости делает `JwtAuthGuard` через `SessionValidatorService` (общий с сокетом).
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
