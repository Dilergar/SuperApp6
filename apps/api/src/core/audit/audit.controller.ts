import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AUDIT_ERROR_CODES,
  auditPersonFilterKeys,
  deviceRenameSchema,
  notMeCompleteSchema,
  notMeStartSchema,
  personSecurityEventsQuerySchema,
  securitySettingsSchema,
  sessionConfirmSchema,
  type SecurityMyDataExportDto,
} from '@superapp/shared';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { NoApiKeys } from '../../shared/decorators/api-keys.decorator';
import { Idempotent } from '../../shared/decorators/idempotency.decorator';
import { DatabaseService } from '../../shared/database/database.service';
import { forbidden, notFound } from '../../shared/errors/api-error';
import { VerifyService } from '../verify/verify.service';
import { AuditAccountService } from './audit.account.service';
import { AuditMyDataService } from './audit.my-data.service';
import { AuditQueryService } from './audit.query.service';
import { AuditService } from './audit.service';
import { AuditSessionsService } from './audit.sessions.service';

/**
 * Безопасность человека (core/audit): сессии и устройства, лента событий, «Это не я»,
 * настройки, «Мои данные». Только своей сессией — ключ API сюда не пускается (`@NoApiKeys`):
 * управлять своими сессиями, устройствами и защитой аккаунта может человек, а не интеграция.
 */
@ApiTags('Security')
@ApiBearerAuth()
@NoApiKeys()
@Controller('users/me')
export class AuditMeController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly query: AuditQueryService,
    private readonly sessions: AuditSessionsService,
    private readonly account: AuditAccountService,
    private readonly verify: VerifyService,
    private readonly myData: AuditMyDataService,
  ) {}

  // ---- Сессии ----

  @Get('sessions')
  @ApiOperation({ summary: 'Sessions: active and ended (the session = a refresh family of one sign-in)' })
  async list(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.sessions.list(user) };
  }

  @Get('security/cooling')
  @ApiOperation({ summary: 'Is the current session confirmed (cooling of a new sign-in)' })
  async cooling(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.sessions.cooling(user) };
  }

  /** Подтвердить новую сессию раньше срока: пропуск `security_confirm` (пароль + SMS на свой номер). */
  @Post('sessions/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({ long: { limit: 10, ttl: 900_000 } })
  @ApiOperation({ summary: 'Confirm the current session now (password + SMS step-up)' })
  async confirm(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const data = sessionConfirmSchema.parse(body);
    const familyId = await this.sessions.currentFamilyOf(user);
    if (!familyId) throw notFound('audit.session_not_found', undefined, { code: AUDIT_ERROR_CODES.sessionNotFound });
    const head = await this.db.session.findFirst({ where: { userId: user.sub, familyId, revokedAt: null }, orderBy: { createdAt: 'desc' }, select: { deviceId: true } });
    if (!head) throw notFound('audit.session_not_found', undefined, { code: AUDIT_ERROR_CODES.sessionNotFound });
    await this.db.$transaction(async (tx) => {
      const consumed = await this.verify.consume(tx, { verifyToken: data.verifyToken, purpose: 'security_confirm', expectedUserId: user.sub });
      await this.sessions.markConfirmed(tx, user.sub, familyId, head.deviceId, 'step_up', { factor: 'password+sms', verifyChallengeId: consumed.challengeId });
      await this.audit.record(tx, { key: 'auth.step_up.success', subjectUserId: user.sub, details: { purpose: 'security_confirm' } });
    });
    return { success: true, data: await this.sessions.cooling(user) };
  }

  /** Завершить ЧУЖУЮ сессию (семейство). Своя — это выход (`POST /auth/logout`). */
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End another session (its whole refresh family)' })
  async end(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.sessions.assertConfirmed(user);
    // id — семейство (список сессий), либо строка сессии (клиенты прошлой версии)
    const row = await this.db.session.findFirst({ where: { userId: user.sub, OR: [{ familyId: id }, { id }] }, select: { familyId: true } });
    if (!row) throw notFound('auth.sessionNotFound');
    const current = await this.sessions.currentFamilyOf(user);
    if (row.familyId === current) throw forbidden('audit.current_session', undefined, { code: AUDIT_ERROR_CODES.currentSession });
    const revoked = await this.db.$transaction(async (tx) => {
      const r = await this.sessions.revokeFamilies(tx, user.sub, { only: [row.familyId] }, 'other_session');
      if (r.count) await this.audit.record(tx, { key: 'auth.session.revoked', subjectUserId: user.sub, target: { type: 'session', id: row.familyId }, details: { by: 'other_session', sessions: r.count } });
      return r;
    });
    await revoked.afterCommit();
    return { success: true };
  }

  // ---- Устройства ----

  @Get('devices')
  @ApiOperation({ summary: 'Devices of the account (by X-Device-Id)' })
  async devices(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.sessions.devices(user) };
  }

  @Patch('devices/:id')
  @ApiOperation({ summary: 'Rename a device' })
  async rename(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() body: unknown) {
    const data = deviceRenameSchema.parse(body);
    await this.sessions.assertConfirmed(user);
    return { success: true, data: await this.sessions.renameDevice(user, id, data.label) };
  }

  @Delete('devices/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Forget a device: its sessions end, the next sign-in from it notifies' })
  async forget(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.sessions.assertConfirmed(user);
    return { success: true, data: await this.sessions.forgetDevice(user, id) };
  }

  // ---- Лента ----

  @Get('security/events')
  @ApiOperation({ summary: 'My security activity (365 days; data transfers and consents — the whole history)' })
  async events(@CurrentUser() user: JwtPayload, @Query() q: unknown) {
    const f = personSecurityEventsQuerySchema.parse(q ?? {});
    return { success: true, data: await this.query.query({ kind: 'subject', userId: user.sub }, { keys: auditPersonFilterKeys(f.filter ?? 'all'), cursor: f.cursor, limit: f.limit }) };
  }

  @Get('security/events/:id')
  @ApiOperation({ summary: 'One event of my security activity' })
  async event(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const dto = await this.query.getOne({ kind: 'subject', userId: user.sub }, id);
    if (!dto) throw notFound('audit.event_not_found', undefined, { code: AUDIT_ERROR_CODES.eventNotFound });
    return { success: true, data: dto };
  }

  // ---- «Это не я» ----

  @Post('security/not-me')
  @HttpCode(HttpStatus.OK)
  @Idempotent({ required: true })
  @Throttle({ long: { limit: 10, ttl: 3_600_000 } })
  @ApiOperation({ summary: '“This wasn’t me”: end other sessions, forget other devices, revoke personal API keys and Google' })
  async notMe(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const data = notMeStartSchema.parse(body);
    return { success: true, data: await this.account.notMeStart(user, data.eventId) };
  }

  @Post('security/not-me/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Finish the “This wasn’t me” wizard' })
  async notMeComplete(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const data = notMeCompleteSchema.parse(body);
    return { success: true, data: await this.account.notMeComplete(user, data) };
  }

  // ---- Настройки ----

  @Get('security/settings')
  @ApiOperation({ summary: 'My security settings' })
  async settings(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.sessions.settings(user.sub) };
  }

  @Patch('security/settings')
  @ApiOperation({ summary: 'Change my security settings (auto-end of inactive sessions)' })
  async updateSettings(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const data = securitySettingsSchema.parse(body);
    return { success: true, data: await this.sessions.updateSettings(user.sub, data) };
  }

  // ---- «Мои данные» ----

  /**
   * Вся история журнала с полными IP — самое ценное для угонщика чтение: свежая неподтверждённая
   * сессия (пароль без SIM) его не получает (cooling), как не может и гасить чужие сессии.
   */
  @Get('security/export')
  @Throttle({ long: { limit: 5, ttl: 3_600_000 } })
  @ApiOperation({ summary: 'My data: my security log as JSON (full IP addresses of my own actions)' })
  async export(@CurrentUser() user: JwtPayload) {
    await this.sessions.assertConfirmed(user);
    const data: SecurityMyDataExportDto = await this.myData.export(user.sub);
    return { success: true, data };
  }
}
