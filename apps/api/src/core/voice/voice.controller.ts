import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { badRequest } from '../../shared/errors/api-error';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import {
  requestTranscriptSchema,
  VOICE_LIMITS,
  voiceSyncSttSchema,
  VoiceLanguage,
} from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { VoiceService } from './voice.service';
import { appTmpDir } from '../../shared/fs/temp-file.util';

/**
 * Голосовой движок — тонкий контроллер (Zod → сервис, AI-ready по Принципу 4).
 * Транскрипт ключуется по fileId; доступ = доступ к файлу.
 */
@ApiTags('Voice')
@ApiBearerAuth()
@Controller('voice')
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  @Get('status')
  @ApiOperation({ summary: 'Engine status: is STT on, is diarization available (the web hides its buttons)' })
  status() {
    return { success: true, data: this.voice.getStatus() };
  }

  @Post('transcripts')
  @Throttle({ long: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Request the transcription of an audio file (idempotent: 1 file = 1 transcript forever)' })
  async request(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = requestTranscriptSchema.parse(body);
    const data = await this.voice.requestTranscript(user.sub, dto);
    return { success: true, data };
  }

  @Get('transcripts/:fileId')
  @ApiOperation({ summary: 'The transcription status or result (the web polls while queued|processing)' })
  async get(@CurrentUser() user: JwtPayload, @Param('fileId') fileId: string) {
    const data = await this.voice.getTranscript(user.sub, fileId);
    return { success: true, data };
  }

  /**
   * Синхронная расшифровка короткого аудио — фундамент голосовых AI-команд
   * (SuperAIAgent6) и SuperTerminal6: multipart с полем "file" → { text, language }.
   */
  @Post('stt')
  @Throttle({ long: { limit: 20, ttl: 60000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        // Каталог платформы: брошенную загрузку (обрыв клиента) уберёт шаг files.upload-tmp раннера сроков
        destination: (_req, _file, cb) => cb(null, appTmpDir()),
        filename: (_req, _file, cb) => cb(null, `stt-${Date.now()}-${randomUUID()}`),
      }),
      limits: { fileSize: VOICE_LIMITS.maxSyncSttBytes, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Synchronous transcription of short audio (≤25 MB): AI and terminal commands' })
  async stt(
    @CurrentUser() _user: JwtPayload,
    @Body() body: Record<string, unknown>,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw badRequest('voice.noFile');
    try {
      const { language } = voiceSyncSttSchema.parse(body ?? {});
      const data = await this.voice.transcribeSync(
        file.path,
        file.mimetype || 'application/octet-stream',
        file.originalname || 'audio',
        language as VoiceLanguage | undefined,
      );
      return { success: true, data };
    } finally {
      await fs.promises.unlink(file.path).catch(() => undefined);
    }
  }
}
