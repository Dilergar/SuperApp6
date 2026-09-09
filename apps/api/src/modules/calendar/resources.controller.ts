import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ResourcesService } from './resources.service';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { createResourceSchema, updateResourceSchema } from '@superapp/shared';

@ApiTags('Resources')
@ApiBearerAuth()
@Controller('resources')
export class ResourcesController {
  constructor(private resources: ResourcesService) {}

  @Get()
  @ApiOperation({ summary: 'My resources plus the ones I may book' })
  async list(@CurrentUser() user: JwtPayload) {
    const data = await this.resources.list(user.sub);
    return { success: true, data };
  }

  @Get('requests')
  @ApiOperation({ summary: 'Incoming booking requests for my resources' })
  async requests(@CurrentUser() user: JwtPayload) {
    const data = await this.resources.incomingRequests(user.sub);
    return { success: true, data };
  }

  @Post()
  @ApiOperation({ summary: 'Create a resource' })
  async create(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    const data = createResourceSchema.parse(body);
    const resource = await this.resources.create(user.sub, data);
    return { success: true, data: resource };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a resource (owner)' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const data = updateResourceSchema.parse(body);
    const resource = await this.resources.update(user.sub, id, data);
    return { success: true, data: resource };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a resource (owner)' })
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.resources.remove(user.sub, id);
    return { success: true };
  }

  @Get(':id/schedule')
  @ApiOperation({ summary: 'The resource schedule for a period' })
  async schedule(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const data = await this.resources.schedule(user.sub, id, from, to);
    return { success: true, data };
  }

  @Post('bookings/:eventId/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm a booking (resource owner)' })
  async confirm(@CurrentUser() user: JwtPayload, @Param('eventId') eventId: string) {
    await this.resources.confirm(user.sub, eventId);
    return { success: true };
  }

  @Post('bookings/:eventId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a booking (resource owner)' })
  async reject(@CurrentUser() user: JwtPayload, @Param('eventId') eventId: string) {
    await this.resources.reject(user.sub, eventId);
    return { success: true };
  }
}
