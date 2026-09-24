import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  VISIBILITY_TYPE_KEYS,
  discoverabilityInputSchema,
  isVisibilityRecordType,
  personalVisibilityInputSchema,
  personalVisibilityResetInputSchema,
  visibilityPlanQuerySchema,
  visibilityRevealInputSchema,
  visibilityCircleFieldsInputSchema,
  VISIBILITY_ERROR_CODES,
} from '@superapp/shared';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { NoApiKeys } from '../../shared/decorators/api-keys.decorator';
import { Idempotent, SkipIdempotency } from '../../shared/decorators/idempotency.decorator';
import { badRequest } from '../../shared/errors/api-error';
import { VisibilityPolicyService } from './visibility.policy.service';
import { VisibilityRevealService } from './visibility.reveal.service';
import { VisibilityService } from './visibility.service';

/**
 * Правила видимости глазами человека: его план по типу записи (заголовки таблиц — R14),
 * раскрытие одной записи (break-glass), его личная политика карточки и находимость по номеру.
 * Ключ API сюда не пускается (`@NoApiKeys`, R8): раскрытие и настройки видимости — дело
 * человека, а не интеграции (боты раскрывать не могут никогда).
 */
@ApiTags('Visibility')
@ApiBearerAuth()
@NoApiKeys()
@Controller('visibility')
export class VisibilityController {
  constructor(
    private readonly visibility: VisibilityService,
    private readonly reveals: VisibilityRevealService,
    private readonly policies: VisibilityPolicyService,
  ) {}

  /** Паспорт реестра (типы, секции, группы, классы полей) — публичен, как `IsSecured` у Dataverse. */
  @Get('types')
  @ApiOperation({ summary: 'Visibility registry: record types, sections, groups and field classes' })
  types() {
    return { success: true, data: VISIBILITY_TYPE_KEYS.map((t) => this.policies.typeMeta(t)) };
  }

  /** План зрителя по типу в «шляпе» запроса (без «почему»): таблица не предлагает то, что сервер отвергнет. */
  @Get('plan')
  @ApiOperation({ summary: 'My field plan for a record type in the current context (no reasons)' })
  async plan(@Query() q: unknown) {
    const { recordType } = visibilityPlanQuerySchema.parse(q ?? {});
    if (!isVisibilityRecordType(recordType)) throw badRequest(VISIBILITY_ERROR_CODES.unknownRecordType, undefined, { code: VISIBILITY_ERROR_CODES.unknownRecordType });
    return { success: true, data: await this.visibility.planDto(this.visibility.viewer('api'), recordType) };
  }

  /**
   * Раскрыть маску ОДНОЙ записи. Ответ несёт полные значения — тела не храним вовсе
   * (`store: 'none'`), кэшам запрещено (`no-store`); повтор получит 409, а не значения.
   */
  @Post('reveal')
  @HttpCode(HttpStatus.OK)
  @Idempotent({ store: 'none' })
  @Throttle({ long: { limit: 60, ttl: 600_000 } })
  @ApiOperation({ summary: 'Reveal masked fields of ONE record (step-up for restricted data, audited)' })
  async reveal(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = visibilityRevealInputSchema.parse(body ?? {});
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    return { success: true, data: await this.reveals.reveal(this.visibility.viewer('api'), input) };
  }

  /** Моя карточка и видимость: кто видит каждое поле, исключения, находимость. */
  @Get('me')
  @ApiOperation({ summary: 'My card visibility: who sees each field, exceptions, discoverability' })
  async me(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.policies.personalGet(user.sub) };
  }

  /** Автосейв «кто видит»: затронутые поля заменяются целиком — повтор даёт то же состояние. */
  @Put('me')
  @SkipIdempotency('naturally_idempotent')
  @ApiOperation({ summary: 'Set who sees the given fields of my card (audiences + always/never exceptions)' })
  async updateMe(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const input = personalVisibilityInputSchema.parse(body ?? {});
    return { success: true, data: await this.policies.personalUpdate(user.sub, input) };
  }

  /** Редактор Группы: по полю показать Группе / скрыть от Группы / как в карточке (правила `circle:<id>`). */
  @Put('me/circles/:circleId')
  @SkipIdempotency('naturally_idempotent')
  @ApiOperation({ summary: 'Show / hide fields of my card to one of my groups' })
  async circleFields(@CurrentUser() user: JwtPayload, @Param('circleId', ParseUUIDPipe) circleId: string, @Body() body: unknown) {
    const { fields } = visibilityCircleFieldsInputSchema.parse(body ?? {});
    return { success: true, data: await this.policies.setCircleFields(user.sub, circleId, fields) };
  }

  @Post('me/reset')
  @HttpCode(HttpStatus.OK)
  @SkipIdempotency('naturally_idempotent')
  @ApiOperation({ summary: 'Reset fields of my card to platform defaults' })
  async resetMe(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const { fieldKeys } = personalVisibilityResetInputSchema.parse(body ?? {});
    return { success: true, data: await this.policies.personalReset(user.sub, fieldKeys) };
  }

  /** Кто может найти меня по номеру (ось отдельна от видимости полей). */
  @Put('me/discoverability')
  @SkipIdempotency('naturally_idempotent')
  @ApiOperation({ summary: 'Who can find me by my phone number: everybody | circle | nobody' })
  async discoverability(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const { discoverableBy } = discoverabilityInputSchema.parse(body ?? {});
    return { success: true, data: await this.policies.setDiscoverability(user.sub, discoverableBy) };
  }
}
