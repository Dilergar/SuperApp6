import { Global, Module } from '@nestjs/common';
import { VoiceService } from './voice.service';
import { VoiceSttClient } from './voice-stt.client';
import { VoiceAudioPrep } from './voice-audio';
import { VoiceController } from './voice.controller';

/**
 * Голосовой движок (core/voice) — 7-й платформенный движок: транскрипция аудио
 * (Whisper-совместимый STT по драйверу, mock для CI), подготовка звука (ffmpeg),
 * исполнение — джоб core/jobs `voice.transcribe`. @Global — потребители (мессенджер,
 * Диктофон, будущие AI-команды/терминал/звонки) инжектят VoiceService напрямую.
 * Инертен без VOICE_STT_URL / VOICE_STT_MOCK (паттерн ClamAV/Google Calendar).
 */
@Global()
@Module({
  controllers: [VoiceController],
  providers: [VoiceService, VoiceSttClient, VoiceAudioPrep],
  exports: [VoiceService],
})
export class VoiceModule {}
