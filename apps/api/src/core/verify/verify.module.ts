import { Global, Module } from '@nestjs/common';
import { VerifyService } from './verify.service';
import { VerifySmsService } from './verify.sms';
import { SmsOutboundService } from './sms-outbound.service';
import { VerifyController } from './verify.controller';
import { StepUpService } from './step-up.service';

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
  // SmsOutboundService — служебные SMS (доставка ссылок наружу): зародыш
  // канального движка уведомлений, живёт рядом с драйвером, пока канал один.
  // StepUpService — окно «сильного подтверждения» по цели (ключи, правила видимости)
  providers: [VerifyService, VerifySmsService, SmsOutboundService, StepUpService],
  exports: [VerifyService, VerifySmsService, SmsOutboundService, StepUpService],
})
export class VerifyModule {}
