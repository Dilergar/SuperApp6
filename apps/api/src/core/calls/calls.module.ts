import { Global, Module } from '@nestjs/common';
import { CallsService } from './calls.service';
import { CallsLivekitClient } from './calls-livekit.client';
import { CallsRefRegistry } from './calls-ref.registry';
import { CallsRecordingRegistry } from './calls-recording.registry';
import { CallsRecordingService } from './calls-recording.service';
import { CallsController } from './calls.controller';
import { CallsWebhookController } from './calls-webhook.controller';
import { CallsCron } from './calls.cron';

/**
 * Движок звонков (core/calls) — 8-й платформенный движок: аудио/видеокомнаты
 * уровня Google Meet (LiveKit SFU: simulcast/adaptive/RED из коробки). Комната
 * привязана к сущности полиморфно (refType+refId); доступ решает резолвер
 * потребителя (CallsRefRegistry, регистрация в onModuleInit — паттерн files).
 * @Global — потребители (Виртуальный офис, будущие DM-звонки/календарь) инжектят
 * CallsService/CallsRefRegistry напрямую. Инертен без LIVEKIT_* (паттерн voice).
 */
@Global()
@Module({
  controllers: [CallsController, CallsWebhookController],
  providers: [
    CallsService,
    CallsLivekitClient,
    CallsRefRegistry,
    CallsRecordingRegistry,
    CallsRecordingService,
    CallsCron,
  ],
  // CallsRecordingRegistry — потребители записей (Диктофон; офис Ф3) регистрируют
  // хук доставки по своему refType
  exports: [CallsService, CallsRefRegistry, CallsRecordingRegistry],
})
export class CallsModule {}
