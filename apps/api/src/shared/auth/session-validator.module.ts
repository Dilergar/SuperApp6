import { Global, Module } from '@nestjs/common';
import { SessionValidatorService } from './session-validator.service';

/**
 * @Global по образцу RedisModule/DatabaseModule: валидатор нужен и JwtAuthGuard (HTTP),
 * и RealtimeGateway (рукопожатие сокета). Глобальность убирает ребро между этими
 * модулями. Подпись проверяет `KeysSigningService` (core/keys, тоже @Global) — своего
 * JwtModule здесь больше нет.
 */
@Global()
@Module({
  providers: [SessionValidatorService],
  exports: [SessionValidatorService],
})
export class SessionValidatorModule {}
