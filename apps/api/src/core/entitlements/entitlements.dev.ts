import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { entitlementSubjectSchema, isEntitlementKey, type EntitlementSubjectRef } from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { DatabaseService } from '../../shared/database/database.service';
import { forbidden, notFound } from '../../shared/errors/api-error';
import { EntitlementsCache } from './entitlements.cache';
import { EntitlementsLifecycle } from './entitlements.lifecycle';
import { EntitlementsService } from './entitlements.service';

/**
 * Дев-полигон движка (только development/test; образец — approvals.dev.ts): сдвиг
 * сроков подписки и гранта, форс будильника, предупреждений и сверки — чтобы сьют
 * проверял истечение за секунды, а не за 30 дней.
 */
const shiftSubscriptionSchema = z
  .object({
    subject: entitlementSubjectSchema,
    trialEndsAt: z.string().datetime().optional(),
    currentPeriodEnd: z.string().datetime().nullable().optional(),
    graceUntil: z.string().datetime().nullable().optional(),
  })
  .strict();

const shiftGrantSchema = z.object({ grantId: z.string().uuid(), validUntil: z.string().datetime() }).strict();
const subjectBody = z.object({ subject: entitlementSubjectSchema }).strict();

@ApiTags('Entitlements')
@ApiBearerAuth()
@Controller('entitlements/dev')
export class EntitlementsDevController {
  constructor(
    private readonly db: DatabaseService,
    private readonly cache: EntitlementsCache,
    private readonly lifecycle: EntitlementsLifecycle,
    private readonly entitlements: EntitlementsService,
  ) {}

  private assertDev(): void {
    if (!isDevEnv()) throw forbidden('dev.developmentOnly');
  }

  @Post('shift-subscription')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Move the dates of the live subscription and re-arm the expiry job' })
  async shiftSubscription(@Body() body: unknown) {
    this.assertDev();
    const dto = shiftSubscriptionSchema.parse(body ?? {});
    const subject = dto.subject as EntitlementSubjectRef;
    const live = await this.entitlements.liveSubscriptionOf(subject);
    if (!live) throw notFound('entitlement.subscriptionNotFound');
    const updated = await this.db.subjectSubscription.update({
      where: { id: live.id },
      data: {
        ...(dto.trialEndsAt !== undefined ? { trialEndsAt: new Date(dto.trialEndsAt) } : {}),
        ...(dto.currentPeriodEnd !== undefined ? { currentPeriodEnd: dto.currentPeriodEnd ? new Date(dto.currentPeriodEnd) : null } : {}),
        ...(dto.graceUntil !== undefined ? { graceUntil: dto.graceUntil ? new Date(dto.graceUntil) : null } : {}),
      },
    });
    await this.entitlements.scheduleExpiry(null, updated);
    await this.cache.bump(subject);
    return { success: true, data: { id: updated.id, status: updated.status } };
  }

  @Post('shift-grant')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Move validUntil of a grant' })
  async shiftGrant(@Body() body: unknown) {
    this.assertDev();
    const dto = shiftGrantSchema.parse(body ?? {});
    const g = await this.db.entitlementGrant.update({ where: { id: dto.grantId }, data: { validUntil: new Date(dto.validUntil) } });
    await this.cache.bump({ type: g.subjectType as EntitlementSubjectRef['type'], id: g.subjectId });
    return { success: true, data: { id: g.id } };
  }

  @Post('run-expiry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Run the expiry transition for the live subscription of a subject now' })
  async runExpiry(@Body() body: unknown) {
    this.assertDev();
    const { subject } = subjectBody.parse(body ?? {});
    const live = await this.entitlements.liveSubscriptionOf(subject as EntitlementSubjectRef);
    if (live) await this.lifecycle.applySubscriptionExpiry(live.id);
    return { success: true, data: { ran: !!live } };
  }

  @Post('run-trial-warnings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Run the trial-ending warnings sweep now' })
  async runTrialWarnings() {
    this.assertDev();
    return { success: true, data: { sent: await this.lifecycle.runTrialWarnings() } };
  }

  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Run the quota reconcile now' })
  async reconcile() {
    this.assertDev();
    return { success: true, data: await this.lifecycle.runQuotaReconcile() };
  }

  @Post('bump')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Bump the subject epoch after a direct DB write by a suite' })
  async bump(@Body() body: unknown) {
    this.assertDev();
    const { subject } = subjectBody.parse(body ?? {});
    await this.cache.bump(subject as EntitlementSubjectRef);
    return { success: true, data: { ok: true } };
  }

  @Post('consume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Consume a quota key of a subject (mechanics of the counter, lazy period reset)' })
  async consume(@Body() body: unknown) {
    this.assertDev();
    const dto = z
      .object({ subject: entitlementSubjectSchema, key: z.string(), delta: z.number().int().min(0) })
      .strict()
      .parse(body ?? {});
    if (!isEntitlementKey(dto.key)) throw notFound('entitlement.keyNotForSubject', { key: dto.key });
    const key = dto.key;
    const res = await this.db.$transaction((tx) => this.entitlements.consume(tx, dto.subject as EntitlementSubjectRef, key, dto.delta));
    return { success: true, data: res };
  }

  @Post('release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Release a quota unit back (the refund path of a failed side effect)' })
  async release(@Body() body: unknown) {
    this.assertDev();
    const dto = z
      .object({ subject: entitlementSubjectSchema, key: z.string(), delta: z.number().int().min(1) })
      .strict()
      .parse(body ?? {});
    if (!isEntitlementKey(dto.key)) throw notFound('entitlement.keyNotForSubject', { key: dto.key });
    const key = dto.key;
    const subject = dto.subject as EntitlementSubjectRef;
    await this.db.$transaction((tx) => this.entitlements.release(tx, subject, key, dto.delta));
    const state = await this.entitlements.quotaState(subject, key);
    return { success: true, data: { used: state.used, limit: state.limit } };
  }

  @Get('raw')
  @ApiOperation({ summary: '[dev] Raw cached snapshot of a subject' })
  async raw(@Query('type') type: string, @Query('id') id: string) {
    this.assertDev();
    const subject = entitlementSubjectSchema.parse({ type, id }) as EntitlementSubjectRef;
    return { success: true, data: await this.entitlements.subjectSnapshot(subject) };
  }
}
