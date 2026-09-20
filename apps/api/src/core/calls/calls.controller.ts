import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { callKickSchema, callMuteSchema, callTokenSchema } from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Idempotent, SkipIdempotency } from '../../shared/decorators/idempotency.decorator';
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
  @ApiOperation({ summary: 'The calls engine status (the web hides its buttons when it is off)' })
  status() {
    return { success: true, data: this.calls.getStatus() };
  }

  // Ответ — токен доступа к комнате (секрет, короткоживущий): снимка нет
  @Idempotent({ store: 'none' })
  @Post('token')
  @Throttle({ long: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'A join token for an entity call (refType+refId; the resolver decides the access)' })
  async token(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = callTokenSchema.parse(body);
    const data = await this.calls.issueToken(user.sub, dto);
    return { success: true, data };
  }

  @Post('rooms/:sessionId/end')
  @ApiOperation({ summary: 'End the call for everyone (moderator)' })
  async end(@CurrentUser() user: JwtPayload, @Param('sessionId') sessionId: string) {
    await this.calls.endSession(user.sub, sessionId);
    return { success: true };
  }

  @Post('rooms/:sessionId/kick')
  @ApiOperation({ summary: 'Remove a participant from the call (moderator)' })
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
  @ApiOperation({ summary: 'Force-mute a participant track (moderator)' })
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
  @ApiOperation({ summary: 'Start recording the call (a participant; one active recording per session)' })
  async recordingStart(@CurrentUser() user: JwtPayload, @Param('sessionId') sessionId: string) {
    return { success: true, data: await this.recording.start(user.sub, sessionId) };
  }

  @Post('rooms/:sessionId/recording/stop')
  @ApiOperation({ summary: 'Stop the recording (whoever started it, or a moderator)' })
  async recordingStop(@CurrentUser() user: JwtPayload, @Param('sessionId') sessionId: string) {
    return { success: true, data: await this.recording.stop(user.sub, sessionId) };
  }

  @Post('rooms/:sessionId/recording/claim')
  @ApiOperation({ summary: '“Get the recording”: the full recording lands in my Recorder (a participant)' })
  async recordingClaim(@CurrentUser() user: JwtPayload, @Param('sessionId') sessionId: string) {
    return { success: true, data: await this.recording.claim(user.sub, sessionId) };
  }
}
