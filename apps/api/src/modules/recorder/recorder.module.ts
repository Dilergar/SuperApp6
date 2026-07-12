import { Module } from '@nestjs/common';
import { RecorderService } from './recorder.service';
import { RecorderController } from './recorder.controller';
import { RecorderEvents } from './recorder.events';

/**
 * Диктофон — сервис-потребитель голосового движка (Files/Voice/Notifications
 * @Global — явных импортов не нужно). Записи собраний → транскрипт со спикерами;
 * дом будущих протоколов собраний и записей SuperTerminal6.
 */
@Module({
  controllers: [RecorderController],
  providers: [RecorderService, RecorderEvents],
  exports: [RecorderService],
})
export class RecorderModule {}
