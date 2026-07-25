import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SessionValidatorService } from './session-validator.service';

/**
 * @Global по образцу RedisModule/DatabaseModule: валидатор нужен и AuthModule (HTTP,
 * JwtStrategy), и MessengerModule (рукопожатие сокета). Глобальность убирает ребро
 * между этими модулями — иначе пришлось бы импортировать AuthModule в мессенджер.
 *
 * JwtModule.register({}) БЕЗ секрета намеренно: секрет передаётся на каждый verify.
 * Аргумент декоратора вычисляется при импорте модуля, то есть ДО validateEnv() в
 * main.ts — зашитый сюда process.env.JWT_SECRET читался бы слишком рано.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [SessionValidatorService],
  exports: [SessionValidatorService],
})
export class SessionValidatorModule {}
