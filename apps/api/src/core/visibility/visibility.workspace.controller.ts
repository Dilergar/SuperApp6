import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  VISIBILITY_ERROR_CODES,
  isVisibilityRecordType,
  visibilityDraftInputSchema,
  visibilityExplainQuerySchema,
  visibilityPresetInputSchema,
  visibilityPublishInputSchema,
  visibilityRestoreVersionInputSchema,
  workspaceVisibilitySettingsInputSchema,
} from '@superapp/shared';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { NoApiKeys } from '../../shared/decorators/api-keys.decorator';
import { SkipIdempotency } from '../../shared/decorators/idempotency.decorator';
import { badRequest, notFound } from '../../shared/errors/api-error';
import { AuditService } from '../audit/audit.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { VisibilityPolicyService } from './visibility.policy.service';
import { VisibilityRevealService } from './visibility.reveal.service';
import { VisibilityService } from './visibility.service';

const statusQuery = z.object({ status: z.enum(['published', 'draft']).optional() }).strict();

/**
 * «Видимость данных» организации (раздел профиля организации): матрица правил по типам
 * записей, черновик → дифф → публикация (версии неизменяемы), пресеты, «Проверить
 * сотрудника» (объяснение плана — без токенов и чужих сессий), настройки политики, снятие
 * паузы раскрытий после детекции. Право — владелец и админ; ключ API сюда не пускается (R8).
 */
@ApiTags('Visibility')
@ApiBearerAuth()
@NoApiKeys()
@Controller('workspaces/:workspaceId/visibility')
export class VisibilityWorkspaceController {
  constructor(
    private readonly policies: VisibilityPolicyService,
    private readonly visibility: VisibilityService,
    private readonly reveals: VisibilityRevealService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: 'Visibility of the organization: record types, published/draft policies, settings, plan limits' })
  async overview(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return { success: true, data: await this.policies.overview(user.sub, workspaceId) };
  }

  @Get('settings')
  @ApiOperation({ summary: 'Visibility policy settings (reveal notices, four eyes, delegation)' })
  async settings(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return { success: true, data: await this.policies.getSettings(user.sub, workspaceId) };
  }

  /** Настройки меняет только владелец; ослабление контроля и выдача делегирования — под SMS. */
  @Patch('settings')
  @SkipIdempotency('naturally_idempotent')
  @ApiOperation({ summary: 'Change visibility policy settings (owner only; loosening needs step-up)' })
  async updateSettings(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: unknown) {
    const input = workspaceVisibilitySettingsInputSchema.parse(body ?? {});
    return { success: true, data: await this.policies.updateSettings(user.sub, workspaceId, input) };
  }

  /** Пресет создаёт ЧЕРНОВИК (опубликованное не трогается до публикации). */
  @Post('presets')
  @ApiOperation({ summary: 'Apply a preset (retail / office / strict) as a draft' })
  async preset(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: unknown) {
    const { preset } = visibilityPresetInputSchema.parse(body ?? {});
    return { success: true, data: await this.policies.applyPreset(user.sub, workspaceId, preset) };
  }

  /**
   * «Проверить сотрудника»: уровень и «почему» по каждому полю для выбранного зрителя —
   * только вычисление плана (урок Facebook View As 2018), событие журнала организации.
   */
  @Get('explain')
  @ApiOperation({ summary: 'Explain which fields an employee sees and why (read-only, no tokens)' })
  async explain(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query() q: unknown) {
    await this.policies.assertManager(user.sub, workspaceId);
    const input = visibilityExplainQuerySchema.parse(q ?? {});
    // Только СЛУЖЕБНЫЕ типы: объяснение личной карточки (`user.card`) выдало бы организации личный
    // граф двух людей (связь в Окружении, Группы) — это не её данные
    if (!isVisibilityRecordType(input.recordType) || this.policies.assertWorkspaceType(input.recordType) !== input.recordType) {
      throw badRequest(VISIBILITY_ERROR_CODES.unknownRecordType, undefined, { code: VISIBILITY_ERROR_CODES.unknownRecordType });
    }
    await this.entitlements.assertFeature(user.sub, 'visibility.explain', { type: 'workspace', id: workspaceId });
    // Зритель и субъект — люди ЭТОЙ организации (иначе объяснение стало бы оракулом членства)
    const [viewerRole, subjectRole] = await Promise.all([
      this.policies.roleIn(input.viewerId, workspaceId),
      input.subjectId ? this.policies.roleIn(input.subjectId, workspaceId) : Promise.resolve('owner' as const),
    ]);
    if (!viewerRole || !subjectRole) throw notFound('staff.notInWorkspace');
    const data = await this.visibility.explain(input.viewerId, workspaceId, input.recordType, input.subjectId ?? null);
    await this.audit.record(null, {
      key: 'org.visibility.explain_viewed',
      workspaceId,
      subjectUserId: input.viewerId,
      target: { type: 'user', id: input.viewerId },
      details: { recordType: input.recordType, viewer: input.viewerId },
    });
    return { success: true, data };
  }

  /** Снять паузу раскрытий после детекции массового раскрытия (решение админа). */
  @Post('reveal-pause/:userId/lift')
  @HttpCode(HttpStatus.OK)
  @SkipIdempotency('naturally_idempotent')
  @ApiOperation({ summary: 'Lift the reveal pause put by the mass-reveal detection' })
  async liftPause(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('userId', ParseUUIDPipe) userId: string) {
    await this.policies.assertManager(user.sub, workspaceId);
    if (!(await this.policies.roleIn(userId, workspaceId))) throw notFound('staff.notInWorkspace');
    await this.reveals.liftPause(userId);
    return { success: true, data: { lifted: true } };
  }

  @Get('policies/:recordType')
  @ApiOperation({ summary: 'The published (default) or draft policy of a record type' })
  async policy(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('recordType') recordType: string, @Query() q: unknown) {
    const { status } = statusQuery.parse(q ?? {});
    return { success: true, data: await this.policies.getPolicy(user.sub, workspaceId, recordType, status ?? 'published') };
  }

  /** Автосейв черновика: правила заменяются целиком; `baseToken` — защита от затирания чужой правки. */
  @Put('policies/:recordType/draft')
  @SkipIdempotency('naturally_idempotent')
  @ApiOperation({ summary: 'Save the draft rules of a record type (replaces the draft rule set)' })
  async saveDraft(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('recordType') recordType: string, @Body() body: unknown) {
    const input = visibilityDraftInputSchema.parse(body ?? {});
    return { success: true, data: await this.policies.saveDraft(user.sub, workspaceId, recordType, input) };
  }

  @Delete('policies/:recordType/draft')
  @SkipIdempotency('naturally_idempotent')
  @ApiOperation({ summary: 'Discard the draft (published rules stay)' })
  async discard(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('recordType') recordType: string) {
    await this.policies.discardDraft(user.sub, workspaceId, recordType);
    return { success: true, data: { discarded: true } };
  }

  @Get('policies/:recordType/diff')
  @ApiOperation({ summary: 'Diff of the draft against the published version (who sees more / less)' })
  async diff(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('recordType') recordType: string) {
    return { success: true, data: await this.policies.diff(user.sub, workspaceId, recordType) };
  }

  /** Публикация: ровно то, что показал дифф (`draftToken`); ослабление строгих полей — под SMS. */
  @Post('policies/:recordType/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish the draft (exactly the reviewed diff; step-up when loosening restricted fields)' })
  async publish(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('recordType') recordType: string, @Body() body: unknown) {
    const { draftToken } = visibilityPublishInputSchema.parse(body ?? {});
    return { success: true, data: await this.policies.publish(user.sub, workspaceId, recordType, draftToken) };
  }

  @Get('policies/:recordType/versions')
  @ApiOperation({ summary: 'Published versions of a record type policy' })
  async versions(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('recordType') recordType: string) {
    return { success: true, data: await this.policies.versions(user.sub, workspaceId, recordType) };
  }

  /** «Вернуть эту версию» = новый черновик (публикуется обычным путём, с диффом). */
  @Post('policies/:recordType/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create a draft from a published version' })
  async restore(@CurrentUser() user: JwtPayload, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('recordType') recordType: string, @Body() body: unknown) {
    const { version } = visibilityRestoreVersionInputSchema.parse(body ?? {});
    return { success: true, data: await this.policies.restoreVersion(user.sub, workspaceId, recordType, version) };
  }
}
