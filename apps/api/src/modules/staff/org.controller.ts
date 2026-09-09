import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createStaffDeputySchema,
  listStaffDeputiesQuerySchema,
  orgChartQuerySchema,
  orgLineQuerySchema,
  orgSetupSchema,
  updateStaffDeputySchema,
} from '@superapp/shared';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { OrgService } from './org.service';

/**
 * Орг. структура (B2B): граф должностей и объектов, «место в структуре», заместители,
 * область правки, мастер сборки. Тонкие хендлеры (Zod → сервис) — каждая операция
 * вызываема программно (AI-ready). Статические пути объявлены ДО параметрических.
 * Головы отдела/объекта и переопределение подчинения — через существующие PATCH
 * справочников (`/staff/departments|branches|positions`), отдельных ручек нет.
 */
@ApiTags('Org')
@ApiBearerAuth()
@Controller('workspaces/:id/org')
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @Get('chart')
  @ApiOperation({ summary: 'The whole org chart (filter by site — ?branchId)' })
  async chart(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Query() query: unknown) {
    const q = orgChartQuerySchema.parse(query ?? {});
    return { success: true, data: await this.org.chart(user.sub, id, q) };
  }

  @Get('unassigned')
  @ApiOperation({ summary: 'Outside the structure: people with no assignments, vacancies, several roots' })
  async unassigned(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.org.unassigned(user.sub, id) };
  }

  @Get('my-scope')
  @ApiOperation({ summary: 'The editing scope of the current user' })
  async myScope(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.org.myScope(user.sub, id) };
  }

  @Get('deputies')
  @ApiOperation({ summary: 'Deputies (?positionId, ?activeOnly)' })
  async deputies(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Query() query: unknown) {
    const q = listStaffDeputiesQuerySchema.parse(query ?? {});
    return { success: true, data: await this.org.listDeputies(user.sub, id, q) };
  }

  @Post('deputies')
  @ApiOperation({ summary: 'Appoint a deputy (self, own manager or an org manager)' })
  async createDeputy(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const dto = createStaffDeputySchema.parse(body);
    return { success: true, data: await this.org.createDeputy(user.sub, id, dto) };
  }

  @Patch('deputies/:deputyId')
  @ApiOperation({ summary: 'Change the period or the note of a deputy' })
  async updateDeputy(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('deputyId') deputyId: string,
    @Body() body: unknown,
  ) {
    const dto = updateStaffDeputySchema.parse(body);
    return { success: true, data: await this.org.updateDeputy(user.sub, id, deputyId, dto) };
  }

  @Delete('deputies/:deputyId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a deputy' })
  async deleteDeputy(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('deputyId') deputyId: string) {
    await this.org.deleteDeputy(user.sub, id, deputyId);
    return { success: true };
  }

  @Post('setup')
  @ApiOperation({ summary: 'Setup wizard: the top position plus the heads of departments and sites' })
  async setup(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const dto = orgSetupSchema.parse(body);
    return { success: true, data: await this.org.setup(user.sub, id, dto) };
  }

  @Get('people/:userId/line')
  @ApiOperation({ summary: 'The place of a person in the structure: positions, manager, team, chain' })
  async line(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Query() query: unknown,
  ) {
    const q = orgLineQuerySchema.parse(query ?? {});
    return { success: true, data: await this.org.line(user.sub, id, userId, q) };
  }
}
