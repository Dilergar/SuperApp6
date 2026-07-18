import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { callKickSchema, callMuteSchema, callTokenSchema } from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { CallsService } from './calls.service';
import { CallsRecordingService } from './calls-recording.service';

/**
 * Движок звонков — тонкий контроллер (Zod → сервис, AI-ready по Принципу 4).
 * Доступ к комнате решает резолвер refType (CallsRefRegistry потребителя).
 */
@ApiTags('Calls')
@ApiBearerAuth()
@Controller('calls')
export class CallsController {
  constructor(
    private readonly calls: CallsService,
    private readonly recording: CallsRecordingService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Статус движка звонков (веб прячет кнопки, когда выключен)' })
  status() {
    return { success: true, data: this.calls.getStatus() };
  }

  @Post('token')
  @Throttle({ long: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'Токен входа в звонок сущности (refType+refId; доступ решает резолвер)' })
  async token(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = callTokenSchema.parse(body);
    const data = await this.calls.issueToken(user.sub, dto);
    return { success: true, data };
  }

  @Post('rooms/:sessionId/end')
  @ApiOperation({ summary: 'Завершить созвон для всех (модератор)' })
  async end(@CurrentUser() user: JwtPayload, @Param('sessionId') sessionId: string) {
    await this.calls.endSession(user.sub, sessionId);
    return { success: true };
  }

  @Post('rooms/:sessionId/kick')
  @ApiOperation({ summary: 'Исключить участника из звонка (модератор)' })
  async kick(
    @CurrentUser() user: JwtPayload,
    @Param('sessionId') sessionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dto = callKickSchema.parse(body);
    await this.calls.kick(user.sub, sessionId, dto.userId);
    return { success: true };
  }

  @Post('rooms/:sessionId/mute')
  @ApiOperation({ summary: 'Принудительный mute трека участника (модератор)' })
  async mute(
    @CurrentUser() user: JwtPayload,
    @Param('sessionId') sessionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const dto = callMuteSchema.parse(body);
    await this.calls.muteTrack(user.sub, sessionId, dto);
    return { success: true };
  }

  // ---------- Запись созвона (LiveKit Egress; индикатор «● Запись» видят все) ----------

  @Post('rooms/:sessionId/recording/start')
  @ApiOperation({ summary: 'Начать запись созвона (участник; одна активная на сессию)' })
  async recordingStart(@CurrentUser() user: JwtPayload, @Param('sessionId') sessionId: string) {
    return { success: true, data: await this.recording.start(user.sub, sessionId) };
  }

  @Post('rooms/:sessionId/recording/stop')
  @ApiOperation({ summary: 'Остановить запись (инициатор записи или модератор)' })
  async recordingStop(@CurrentUser() user: JwtPayload, @Param('sessionId') sessionId: string) {
    return { success: true, data: await this.recording.stop(user.sub, sessionId) };
  }

  @Post('rooms/:sessionId/recording/claim')
  @ApiOperation({ summary: '«Получить запись»: полная запись придёт в мой Диктофон (участник)' })
  async recordingClaim(@CurrentUser() user: JwtPayload, @Param('sessionId') sessionId: string) {
    return { success: true, data: await this.recording.claim(user.sub, sessionId) };
  }
}
