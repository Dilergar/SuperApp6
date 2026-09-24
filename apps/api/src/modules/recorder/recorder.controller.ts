import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createRecordingSchema, renameRecordingSchema } from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { RecorderService } from './recorder.service';

/** Диктофон — тонкий контроллер (Zod → сервис). Транскрипция — через /voice/*. */
@ApiTags('Recorder')
@ApiBearerAuth()
@Controller('recorder')
export class RecorderController {
  constructor(private readonly recorder: RecorderService) {}

  @Get('recordings')
  @ApiOperation({ summary: 'My recordings (with the file and the transcript status)' })
  async list(@CurrentUser() user: JwtPayload) {
    const data = await this.recorder.list(user.sub);
    return { success: true, data };
  }

  @Get('trash')
  @ApiOperation({ summary: 'My trash: recordings I moved there (restorable for 30 days)' })
  async trash(@CurrentUser() user: JwtPayload) {
    const data = await this.recorder.listTrash(user.sub);
    return { success: true, data };
  }

  @Post('recordings')
  @ApiOperation({ summary: 'Create a recording from an uploaded audio file (profile dictaphone/voice_message)' })
  async create(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = createRecordingSchema.parse(body);
    const data = await this.recorder.create(user.sub, dto);
    return { success: true, data };
  }

  @Patch('recordings/:id')
  @ApiOperation({ summary: 'Rename a recording' })
  async rename(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const { title } = renameRecordingSchema.parse(body);
    const data = await this.recorder.rename(user.sub, id, title);
    return { success: true, data };
  }

  @Post('recordings/:id/trash')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'To the trash (the file and the transcript stay until deleted for good)' })
  async trashRecording(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.recorder.trash(user.sub, id);
    return { success: true, data: { ok: true } };
  }

  @Post('recordings/:id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore from the trash' })
  async restoreRecording(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.recorder.restore(user.sub, id);
    return { success: true, data };
  }

  @Delete('recordings/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete for good — from the trash only (the engines clean up the file and the transcript)' })
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.recorder.purge(user.sub, id);
    return { success: true, data: { ok: true } };
  }
}
