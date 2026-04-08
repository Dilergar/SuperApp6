import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CirclesService } from './circles.service';
import {
  CurrentUser,
  type JwtPayload,
} from '../../shared/decorators/current-user.decorator';
import {
  createCircleSchema,
  updateCircleSchema,
  addToCircleSchema,
  reorderCirclesSchema,
} from '@superapp/shared';

@ApiTags('Circles')
@ApiBearerAuth()
@Controller('circles')
export class CirclesController {
  constructor(private circles: CirclesService) {}

  @Get()
  @ApiOperation({ summary: 'Мои окружения' })
  async list(@CurrentUser() user: JwtPayload) {
    const data = await this.circles.listCircles(user.sub);
    return { success: true, data };
  }

  @Post()
  @ApiOperation({ summary: 'Создать окружение' })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() body: unknown,
  ) {
    const data = createCircleSchema.parse(body);
    const circle = await this.circles.createCircle(user.sub, data);
    return { success: true, data: circle };
  }

  @Post('reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Изменить порядок окружений' })
  async reorder(
    @CurrentUser() user: JwtPayload,
    @Body() body: unknown,
  ) {
    const data = reorderCirclesSchema.parse(body);
    await this.circles.reorderCircles(user.sub, data.circles);
    return { success: true };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Получить окружение с участниками' })
  async get(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    const data = await this.circles.getCircle(user.sub, id);
    return { success: true, data };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Обновить окружение' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = updateCircleSchema.parse(body);
    const circle = await this.circles.updateCircle(user.sub, id, data);
    return { success: true, data: circle };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Удалить окружение' })
  async delete(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    await this.circles.deleteCircle(user.sub, id);
    return { success: true };
  }

  @Post(':id/members')
  @ApiOperation({ summary: 'Добавить контакт в окружение' })
  async addMember(
    @CurrentUser() user: JwtPayload,
    @Param('id') circleId: string,
    @Body() body: unknown,
  ) {
    const data = addToCircleSchema.parse(body);
    const result = await this.circles.addMember(user.sub, circleId, data.contactLinkId);
    return { success: true, data: result };
  }

  @Delete(':id/members/:linkId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Убрать контакт из окружения' })
  async removeMember(
    @CurrentUser() user: JwtPayload,
    @Param('id') circleId: string,
    @Param('linkId') contactLinkId: string,
  ) {
    await this.circles.removeMember(user.sub, circleId, contactLinkId);
    return { success: true };
  }
}
