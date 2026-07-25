import { Global, Module } from '@nestjs/common';
import { VerifyService } from './verify.service';
import { VerifySmsService } from './verify.sms';
import { VerifyController } from './verify.controller';
import { VerifyCron } from './verify.cron';

/**
 * Движок подтверждений (core/verify) — 11-й платформенный движок: SMS-OTP
 * «владеешь ли ты номером» для всех сервисов. Цели v1: регистрация (verify-first),
 * сброс пароля, смена пароля, смена номера; расширяемо purpose-реестром (step-up
 * денежных операций, вход с нового устройства — позже). @Global — потребители
 * (auth, users, будущие) инжектят VerifyService напрямую; consume() зовётся
 * В ТРАНЗАКЦИИ целевого действия. SMS — синхронно, драйверы kazinfoteh|mock.
 * Secure-by-default: в production verifyToken при регистрации ОБЯЗАТЕЛЕН.
 */
@Global()
@Module({
  controllers: [VerifyController],
  providers: [VerifyService, VerifySmsService, VerifyCron],
  exports: [VerifyService],
})
export class VerifyModule {}
