import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  approvalDecideSchema,
  approvalInboxQuerySchema,
  approvalMineQuerySchema,
} from '@superapp/shared';
import { CurrentUser, JwtPayload } from '../../shared/decorators/current-user.decorator';
import { ApprovalsService } from './approvals.service';

/**
 * Согласования — для человека это «Ждут решения». Тонкий контроллер: Zod → сервис.
 *
 * ВАЖЕН ПОРЯДОК: статические пути объявлены ДО `:id`, иначе Nest сопоставит
 * `/approvals/inbox` с параметром и уйдёт искать заявку с идентификатором «inbox»
 * (ровно эта ловушка уже стоила времени в движке гостевых ссылок).
 */
@ApiTags('Approvals')
@ApiBearerAuth()
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get('inbox')
  @ApiOperation({ summary: 'Стопка «Ждут решения» — по реестру источников' })
  async inbox(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = approvalInboxQuerySchema.parse(query);
    const data = await this.approvals.inbox(user.sub, q);
    return { success: true, data };
  }

  @Get('inbox/count')
  @ApiOperation({ summary: 'Счётчик бейджа: одно число, без списков' })
  async inboxCount(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = approvalInboxQuerySchema.parse(query);
    const data = await this.approvals.inboxCount(user.sub, q);
    return { success: true, data };
  }

  @Get('mine')
  @ApiOperation({ summary: 'Мои заявки: где сейчас то, что я отправил' })
  async mine(@CurrentUser() user: JwtPayload, @Query() query: Record<string, unknown>) {
    const q = approvalMineQuerySchema.parse(query);
    // ApprovalMinePage целиком: тип уже стоял на API и НЕ стоял на вебе именно
    // потому, что страница разбиралась здесь.
    return { success: true, data: await this.approvals.listMine(user.sub, q) };
  }

  // ЗАВЕДЕНИЯ ЗАЯВКИ ПО HTTP ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО.
  //
  // Право «отправить это на согласование» знает только ПОТРЕБИТЕЛЬ (для документа это
  // одно, для счёта другое), поэтому заявку заводит он — вызовом `ApprovalsService.create`
  // из своего кода, уже проверив своё правило. Пока такая ручка существовала, любой
  // авторизованный слал сюда `{refType:'org_document', refId:<чужой приказ>}` и получал
  // в ответе название и НОМЕР чужого документа, а выбранному человеку прилетало
  // «Подпишите …» с произвольным текстом и неизменяемой записью решения: HTTP-путь шёл
  // мимо потребителя, а движок правил предметной области не знает по определению.
  // Веб её не вызывал ни разу — это была чистая незакрытая поверхность.

  @Get(':id')
  @ApiOperation({ summary: 'Заявка целиком: маршрут, кто решил, комментарии' })
  async get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const data = await this.approvals.get(user.sub, id);
    return { success: true, data };
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отозвать свою заявку' })
  async cancel(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.approvals.cancel(user.sub, id);
    return { success: true };
  }

  @Post('steps/:stepId/decide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Согласовать · Отклонить · На доработку' })
  async decide(
    @CurrentUser() user: JwtPayload,
    @Param('stepId') stepId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const dto = approvalDecideSchema.parse(body);
    // IP берём ТОЛЬКО из req.ip: он уважает настройку доверия прокси (TRUST_PROXY).
    // Читать X-Forwarded-For напрямую значило бы записывать в доказательство решения
    // строку, которую пишет сам клиент.
    const data = await this.approvals.decide(user.sub, stepId, dto, req.ip ?? null);
    return { success: true, data };
  }
}
