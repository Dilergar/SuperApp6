import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { putWorkspaceNotificationPolicySchema } from '@superapp/shared';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { NotificationsPolicyService } from './notifications.policy.service';

/** Политика организации: дефолты + замки (гейт — admin/owner, проверяет сервис). */
@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/notification-policy')
export class NotificationsPolicyController {
  constructor(private readonly policy: NotificationsPolicyService) {}

  @Get()
  @ApiOperation({ summary: 'Organization notification policy (admin/owner)' })
  async get(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string) {
    return { success: true, data: await this.policy.get(user.sub, workspaceId) };
  }

  @Put()
  @ApiOperation({ summary: 'Replace the rule set (locks: lockable types only, in-app/push only)' })
  async put(@CurrentUser() user: JwtPayload, @Param('workspaceId') workspaceId: string, @Body() body: unknown) {
    const input = putWorkspaceNotificationPolicySchema.parse(body);
    return { success: true, data: await this.policy.put(user.sub, workspaceId, input) };
  }
}
