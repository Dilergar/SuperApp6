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
  @ApiOperation({ summary: 'Цельный граф оргструктуры (фильтр объекта — ?branchId)' })
  async chart(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Query() query: unknown) {
    const q = orgChartQuerySchema.parse(query ?? {});
    return { success: true, data: await this.org.chart(user.sub, id, q) };
  }

  @Get('unassigned')
  @ApiOperation({ summary: '«Вне структуры»: люди без назначений, вакансии, несколько корней' })
  async unassigned(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.org.unassigned(user.sub, id) };
  }

  @Get('my-scope')
  @ApiOperation({ summary: 'Область правки структуры текущего пользователя' })
  async myScope(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { success: true, data: await this.org.myScope(user.sub, id) };
  }

  @Get('deputies')
  @ApiOperation({ summary: 'Заместители (?positionId, ?activeOnly)' })
  async deputies(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Query() query: unknown) {
    const q = listStaffDeputiesQuerySchema.parse(query ?? {});
    return { success: true, data: await this.org.listDeputies(user.sub, id, q) };
  }

  @Post('deputies')
  @ApiOperation({ summary: 'Назначить заместителя (сам · руководитель · управляющий)' })
  async createDeputy(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const dto = createStaffDeputySchema.parse(body);
    return { success: true, data: await this.org.createDeputy(user.sub, id, dto) };
  }

  @Patch('deputies/:deputyId')
  @ApiOperation({ summary: 'Изменить период/комментарий замещения' })
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
  @ApiOperation({ summary: 'Снять заместителя' })
  async deleteDeputy(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('deputyId') deputyId: string) {
    await this.org.deleteDeputy(user.sub, id, deputyId);
    return { success: true };
  }

  @Post('setup')
  @ApiOperation({ summary: 'Мастер «Соберём структуру»: вершина + руководители отделов/объектов' })
  async setup(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const dto = orgSetupSchema.parse(body);
    return { success: true, data: await this.org.setup(user.sub, id, dto) };
  }

  @Get('people/:userId/line')
  @ApiOperation({ summary: '«Место в структуре» человека: должности, руководитель, команда, цепочка' })
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
