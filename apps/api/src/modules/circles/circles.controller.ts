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
  @ApiOperation({ summary: 'My groups' })
  async list(@CurrentUser() user: JwtPayload) {
    const data = await this.circles.listCircles(user.sub);
    return { success: true, data };
  }

  @Post()
  @ApiOperation({ summary: 'Create a group' })
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
  @ApiOperation({ summary: 'Reorder the groups' })
  async reorder(
    @CurrentUser() user: JwtPayload,
    @Body() body: unknown,
  ) {
    const data = reorderCirclesSchema.parse(body);
    await this.circles.reorderCircles(user.sub, data.circles);
    return { success: true };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a group with its members' })
  async get(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    const data = await this.circles.getCircle(user.sub, id);
    return { success: true, data };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a group' })
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
  @ApiOperation({ summary: 'Delete a group' })
  async delete(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    await this.circles.deleteCircle(user.sub, id);
    return { success: true };
  }

  @Post(':id/members')
  @ApiOperation({ summary: 'Add a contact to a group' })
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
  @ApiOperation({ summary: 'Remove a contact from a group' })
  async removeMember(
    @CurrentUser() user: JwtPayload,
    @Param('id') circleId: string,
    @Param('linkId') contactLinkId: string,
  ) {
    await this.circles.removeMember(user.sub, circleId, contactLinkId);
    return { success: true };
  }
}
