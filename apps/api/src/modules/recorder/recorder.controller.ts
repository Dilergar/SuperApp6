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
  @ApiOperation({ summary: 'Мои записи Диктофона (с файлом и статусом расшифровки)' })
  async list(@CurrentUser() user: JwtPayload) {
    const data = await this.recorder.list(user.sub);
    return { success: true, data };
  }

  @Post('recordings')
  @ApiOperation({ summary: 'Создать запись из готового аудио-файла (профиль dictaphone/voice_message)' })
  async create(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const dto = createRecordingSchema.parse(body);
    const data = await this.recorder.create(user.sub, dto);
    return { success: true, data };
  }

  @Patch('recordings/:id')
  @ApiOperation({ summary: 'Переименовать запись' })
  async rename(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const { title } = renameRecordingSchema.parse(body);
    const data = await this.recorder.rename(user.sub, id, title);
    return { success: true, data };
  }

  @Delete('recordings/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить запись (файл и расшифровка чистятся движками)' })
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.recorder.remove(user.sub, id);
    return { success: true, data: { ok: true } };
  }
}
