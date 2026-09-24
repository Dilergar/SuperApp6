import { Module } from '@nestjs/common';
import { RecorderService } from './recorder.service';
import { RecorderController } from './recorder.controller';
import { RecorderCron } from './recorder.cron';
import { RecorderEvents } from './recorder.events';
import { RecorderNotificationRefsProvider } from './recorder-notification-refs.provider';

/**
 * Диктофон — сервис-потребитель голосового движка (Files/Voice/Notifications
 * @Global — явных импортов не нужно). Записи собраний → транскрипт со спикерами;
 * дом будущих протоколов собраний и записей SuperTerminal6.
 */
@Module({
  controllers: [RecorderController],
  providers: [
    // Движок уведомлений: резолвер объекта (право видеть батчем + deep link) — фича → движок
    RecorderNotificationRefsProvider, RecorderService, RecorderEvents, RecorderCron],
  exports: [RecorderService],
})
export class RecorderModule {}
