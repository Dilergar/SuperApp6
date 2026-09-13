import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  ANALYTICS_ERROR_CODES,
  ANALYTICS_LIMITS,
  analyticsClientEventSchema,
  analyticsCollectSchema,
  analyticsConsentSchema,
  analyticsEventDef,
  analyticsIdentifySchema,
  type AnalyticsCollectResultDto,
} from '@superapp/shared';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
import { DeferWorkspaceCheck } from '../../shared/decorators/defer-workspace-check.decorator';
import { WorkspaceContextService } from '../../shared/context/workspace-context.service';
import { badRequest } from '../../shared/errors/api-error';
import { analyticsEnv, type AnalyticsIngestEvent, type AnalyticsIngestReject } from './analytics.constants';
import { normalizePageProps, parseUserAgent, sanitizeKey, shapeOf, templateRoute, uuidOrNull } from './analytics.enrich';
import { AnalyticsService } from './analytics.service';

/** Потолок тела авторизованного приёма: батч клиента режется по 60 КБ, плюс запас на обёртку. */
const AUTHED_MAX_BYTES = 64_000;

/**
 * Корзина лимита — ЧЕЛОВЕК, а не адрес: организация за одним NAT (офис на 50 сотрудников,
 * каждая вкладка шлёт батч раз в 5 с) не делит один потолок на всех. `sub` читается из
 * тела токена БЕЗ проверки подписи — гард JWT идёт следом и подделку отвергнет; IP
 * остаётся в ключе, чтобы чужой `sub` в поддельном токене не исчерпывал корзину жертвы.
 * Без токена (анонимная ручка, битый заголовок) — корзина адреса, как везде.
 */
function personTracker(req: Record<string, unknown>): string {
  const ip = typeof req.ip === 'string' ? req.ip : 'unknown';
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  const auth = typeof headers.authorization === 'string' ? headers.authorization : '';
  if (!/^bearer /i.test(auth)) return ip;
  try {
    const payload = auth.slice(7).trim().split('.')[1] ?? '';
    const sub = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown }).sub;
    return uuidOrNull(sub) ? `${ip}:${uuidOrNull(sub)}` : ip;
  } catch {
    return ip;
  }
}

interface Caller {
  userId: string | null;
  loginSid: string | null;
  anonymous: boolean;
  maxBytes: number;
}

/**
 * Приём событий клиентов, склейка личности и тумблер согласия.
 *
 * ИНВАРИАНТ: на пути приёма нет ни одного запроса к Postgres — валидация по реестру
 * в памяти, XADD одной записью на батч, 202. Организация берётся из `X-Workspace-Id`
 * без проверки членства (`@DeferWorkspaceCheck`) — проверяет консьюмер. Ошибки схемы
 * не ломают интерфейс: плохое событие уходит в `dropped` и карантин; отказом
 * отвечают только `400 analytics.payload_too_large` и `429`.
 */
@ApiTags('Analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly ctx: WorkspaceContextService,
  ) {}

  @ApiBearerAuth()
  @Post('collect')
  @HttpCode(HttpStatus.ACCEPTED)
  @DeferWorkspaceCheck()
  @Throttle({ long: { limit: 120, ttl: 60_000, getTracker: personTracker } })
  @ApiOperation({ summary: 'Accept a batch of client events (≤ 50). Identity comes from the JWT, never from the body' })
  async collect(@CurrentUser() user: JwtPayload, @Body() body: unknown, @Req() req: Request) {
    const data = await this.accept(body, req, { userId: user.sub, loginSid: user.sid ?? null, anonymous: false, maxBytes: AUTHED_MAX_BYTES });
    return { success: true, data };
  }

  @Public()
  @Post('collect/anon')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ long: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Accept pre-login events: only registry keys marked anonymous' })
  async collectAnon(@Body() body: unknown, @Req() req: Request) {
    const data = await this.accept(body, req, { userId: null, loginSid: null, anonymous: true, maxBytes: ANALYTICS_LIMITS.anonMaxBodyBytes });
    return { success: true, data };
  }

  @ApiBearerAuth()
  @Post('identify')
  @HttpCode(HttpStatus.OK)
  // Склейка пишет в БД и сканирует сырьё анонима: раз на вход человека, не сотни в минуту
  @Throttle({ long: { limit: 20, ttl: 60_000, getTracker: personTracker } })
  @ApiOperation({ summary: 'Link an anonymous id to the account (the first link wins; a second account marks it contested)' })
  async identify(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const dto = analyticsIdentifySchema.parse(body ?? {});
    return { success: true, data: await this.analytics.link(dto.anonymousId, user.sub, 'identify') };
  }

  @ApiBearerAuth()
  @Get('consent')
  @ApiOperation({ summary: 'Usage analytics opt-out state of the caller' })
  async getConsent(@CurrentUser() user: JwtPayload) {
    return { success: true, data: { optOut: await this.analytics.getOptOut(user.sub) } };
  }

  @ApiBearerAuth()
  @Patch('consent')
  @ApiOperation({ summary: 'Opt out of (or back into) usage analytics; business facts are still recorded' })
  async setConsent(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    const dto = analyticsConsentSchema.parse(body ?? {});
    return { success: true, data: await this.analytics.setOptOut(user.sub, dto.optOut) };
  }

  // ------------------------------------------------------------

  private async accept(body: unknown, req: Request, who: Caller): Promise<AnalyticsCollectResultDto> {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > who.maxBytes) {
      throw badRequest('analytics.payload_too_large', { max: who.maxBytes }, { code: ANALYTICS_ERROR_CODES.payloadTooLarge });
    }
    const batchLen = Array.isArray((body as { batch?: unknown })?.batch) ? Math.min((body as { batch: unknown[] }).batch.length, ANALYTICS_LIMITS.maxBatch) : 1;
    if (!analyticsEnv().enabled) return { accepted: 0, dropped: batchLen };

    const envelope = analyticsCollectSchema.safeParse(body);
    if (!envelope.success) {
      await this.analytics.publish({ v: 1, events: [], rejects: [{ key: '(envelope)', reason: 'schema', shape: shapeOf(body) }] });
      await this.analytics.bumpCounters({ dropped: batchLen });
      return { accepted: 0, dropped: batchLen };
    }

    const { app, context, batch } = envelope.data;
    const receivedAt = new Date().toISOString();
    const ua = parseUserAgent(typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null);
    const gpc = req.headers['sec-gpc'] === '1' || context?.gpc === true;
    const claimedWorkspaceId = who.anonymous ? null : uuidOrNull(this.ctx.get()?.claimedWorkspaceId);
    const fill = this.analytics.streamFill();

    const events: AnalyticsIngestEvent[] = [];
    const rejects: AnalyticsIngestReject[] = [];
    let blocked = 0;
    let shed = 0;

    for (const raw of batch) {
      const parsed = analyticsClientEventSchema.safeParse(raw);
      if (!parsed.success) {
        rejects.push({ key: sanitizeKey((raw as { key?: unknown })?.key), reason: 'schema', shape: shapeOf(raw) });
        continue;
      }
      const e = parsed.data;
      const def = analyticsEventDef(e.key);
      if (!def) {
        rejects.push({ key: sanitizeKey(e.key), reason: 'unknown_key', shape: shapeOf(e.props) });
        continue;
      }
      // Серверный факт с HTTP — попытка накрутки: реестр не пускает его в клиентские данные
      if (def.source === 'server') {
        rejects.push({ key: e.key, reason: 'server_key_from_client', shape: shapeOf(e.props) });
        continue;
      }
      if (who.anonymous && (!def.anonymous || !e.anonymousId)) {
        rejects.push({ key: e.key, reason: def.anonymous ? 'schema' : 'anon_not_allowed', shape: shapeOf(e.props) });
        continue;
      }
      if (def.status === 'blocked') {
        blocked++;
        continue;
      }
      const props = def.props.safeParse(e.props ?? {});
      if (!props.success) {
        rejects.push({ key: e.key, reason: 'schema', shape: shapeOf(e.props) });
        continue;
      }
      // Политика сброса при переполнении: телеметрия — с 80 %, продуктовые — с 95 %
      if ((def.class === 'telemetry' && fill > 0.8) || (def.class === 'product' && fill > 0.95)) {
        shed++;
        continue;
      }
      events.push({
        eventId: e.eventId.toLowerCase(),
        key: e.key,
        occurredAt: e.occurredAt,
        receivedAt,
        platform: app.platform,
        appVersion: app.version ?? null,
        userId: who.userId,
        anonymousId: uuidOrNull(e.anonymousId),
        workspaceId: null,
        claimedWorkspaceId,
        role: null,
        sessionId: uuidOrNull(e.sessionId),
        deviceId: uuidOrNull(e.deviceId),
        loginSid: uuidOrNull(who.loginSid),
        deviceClass: ua.deviceClass,
        os: ua.os,
        browser: ua.browser,
        locale: context?.locale ?? null,
        tz: context?.tz ?? null,
        route: templateRoute(e.route),
        refType: null,
        refId: null,
        props: e.key === 'navigation.page.viewed' ? normalizePageProps(props.data) : (props.data as Record<string, unknown>),
        sampleRate: e.sampleRate ?? 1,
        gpc,
      });
    }

    const published = await this.analytics.publish({ v: 1, events, rejects });
    const lost = published ? 0 : events.length;
    await this.analytics.bumpCounters({ dropped: rejects.length + lost, blocked, shed });
    return { accepted: events.length - lost, dropped: rejects.length + blocked + shed + lost };
  }
}
