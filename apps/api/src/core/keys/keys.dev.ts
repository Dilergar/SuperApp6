import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { SIGNING_AUDIENCES, type KeysStatusDto, type KeyScopeRef } from '@superapp/shared';
import { isDevEnv } from '../../shared/config/env.validation';
import { forbidden } from '../../shared/errors/api-error';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { KEK_NAME, PLATFORM_SCOPE, userScope, workspaceScope } from './keys.constants';
import { KeysEnvelopeService } from './keys.envelope.service';
import { KeysMacService } from './keys.mac.service';
import { AUDIENCE_MAX_TTL_SEC, KeysRotationJobs } from './keys.rotation.jobs';
import { KeysSigningService } from './keys.signing.service';
import { KeysStoreService } from './keys.store.service';
import { KeysPiiService } from './pii/keys.pii.service';
import { KeysUsageCron } from './api-keys/keys.usage.cron';
import { KEYS_REDIS } from '@superapp/shared';
import { RedisService } from '../../shared/redis/redis.service';

const audienceBody = z.object({ audience: z.enum(SIGNING_AUDIENCES) }).strict();
const kidBody = z.object({ kid: z.string().uuid() }).strict();
const scopeBody = z.object({ type: z.enum(['workspace', 'user']), id: z.string().uuid() }).strict();
const roundtripBody = z.object({ scope: scopeBody.optional(), plaintext: z.string().max(4096) }).strict();

/**
 * Дев-полигон движка (только development/test, регистрируется модулем лишь в dev):
 * учения ротации подписи и KEK за секунды, заморозка скоупа, roundtrip шифрования.
 * Личность — залогиненный пользователь (dev): в production контроллера нет вовсе.
 */
@ApiTags('Keys')
@ApiBearerAuth()
@Controller('keys/dev')
export class KeysDevController {
  constructor(
    private readonly store: KeysStoreService,
    private readonly signing: KeysSigningService,
    private readonly rotation: KeysRotationJobs,
    private readonly envelope: KeysEnvelopeService,
    private readonly mac: KeysMacService,
    private readonly pii: KeysPiiService,
    private readonly usage: KeysUsageCron,
    private readonly redis: RedisService,
  ) {}

  private assertDev(): void {
    if (!isDevEnv()) throw forbidden('dev.developmentOnly');
  }

  @Get('status')
  @ApiOperation({ summary: '[dev] Keystore status: provider, root fingerprint, signing and mac keys' })
  async status(): Promise<{ success: true; data: KeysStatusDto }> {
    this.assertDev();
    const signing: KeysStatusDto['signing'] = [];
    for (const aud of SIGNING_AUDIENCES) {
      const k = await this.store.getKey(PLATFORM_SCOPE, 'sign', aud);
      signing.push({ audience: aud, primaryKid: k?.primaryKid ?? null, versions: k?.versions.length ?? 0 });
    }
    const platform = await this.store.listScope(PLATFORM_SCOPE);
    const macs = platform.filter((k) => k.purpose === 'mac').map((k) => ({ name: k.name, primaryKid: k.primaryKid, versions: k.versions.length }));
    return {
      success: true,
      data: {
        provider: this.store.provider.kind,
        rootKid: this.store.provider.rootKid,
        signing,
        mac: macs,
        kekCount: await this.store.countKeks(),
        legacyHs256Until: this.signing.status().legacyHs256Until,
      },
    };
  }

  @Post('signing/rotate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Rotate the signing key of an audience: pending version + activation job at the production delay (activate now — POST signing/activate)' })
  async rotateSigning(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const { audience } = audienceBody.parse(body ?? {});
    // Джоб активации — с боевой задержкой, а не «сейчас»: иначе воркер джобов активировал бы
    // pending-версию между ротацией и проверкой «до активации подписывает старая» (гонка
    // в verify-keys). Учение активирует явно ручкой signing/activate; поздний джоб — no-op
    // (activate переводит только pending → active).
    const res = await this.signing.rotate(audience, { actorId: user.sub, reason: 'dev drill', retireAfterSec: AUDIENCE_MAX_TTL_SEC[audience] });
    return { success: true, data: res };
  }

  @Post('signing/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Activate a pending signing version now (skips the JWKS cache delay)' })
  async activate(@Body() body: unknown) {
    this.assertDev();
    const { kid } = kidBody.parse(body ?? {});
    const v = await this.store.version(kid);
    const key = v ? await this.store.getKey(v.scope, v.purpose, v.name) : null;
    const previousKid = key?.primaryKid ?? null;
    await this.rotation.signingActivate({ kid, previousKid, retireAfterSec: v && v.purpose === 'sign' ? AUDIENCE_MAX_TTL_SEC[v.name as keyof typeof AUDIENCE_MAX_TTL_SEC] ?? 0 : 0 });
    return { success: true, data: { activated: (await this.store.version(kid))?.state === 'active' } };
  }

  @Post('signing/retire')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Retire a non-primary signing version now (destroy_scheduled)' })
  async retire(@Body() body: unknown) {
    this.assertDev();
    const { kid } = kidBody.parse(body ?? {});
    await this.rotation.signingRetire({ kid });
    return { success: true, data: { state: (await this.store.version(kid))?.state ?? null } };
  }

  @Post('signing/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Disable a non-primary signing version (kill-switch drill)' })
  async disableSigning(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const { kid } = kidBody.parse(body ?? {});
    const v = await this.store.version(kid);
    const key = v ? await this.store.getKey(v.scope, v.purpose, v.name) : null;
    if (!v || v.purpose !== 'sign' || key?.primaryKid === kid) throw forbidden('dev.developmentOnly');
    await this.store.disable(kid, { actorId: user.sub, reason: 'dev drill' });
    return { success: true, data: { state: (await this.store.version(kid))?.state ?? null } };
  }

  @Post('signing/compromise')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Mark a signing version compromised (archival verification rejects it forever)' })
  async compromiseSigning(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const { audience, kid } = audienceBody.merge(kidBody).strict().parse(body ?? {});
    return { success: true, data: await this.signing.compromise(audience, kid, { actorId: user.sub, actorKind: 'user', reason: 'dev drill' }) };
  }

  @Post('kek/rotate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Rotate the KEK of a scope and rewrap its rows synchronously' })
  async rotateKek(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const scope = scopeBody.parse(body ?? {});
    const s = scope.type === 'workspace' ? workspaceScope(scope.id) : userScope(scope.id);
    const kid = await this.rotation.rotateKek(s, { actorId: user.sub, reason: 'dev drill' });
    await this.rotation.rewrap({ scope: s });
    return { success: true, data: { kid } };
  }

  // ---- Учения смены ключа слепых индексов: три шага по отдельности (сьют проверяет окно dual-write) ----

  @Get('blind-index/status')
  @ApiOperation({ summary: '[dev] Blind index key: versions with their slot and state' })
  async blindIndexStatus() {
    this.assertDev();
    const key = await this.store.getKey(PLATFORM_SCOPE, 'mac', 'blind_index');
    return { success: true, data: { primaryKid: key?.primaryKid ?? null, versions: (key?.versions ?? []).map((v) => ({ kid: v.kid, version: v.version, state: v.state, slot: v.slot ?? 0 })) } };
  }

  @Post('blind-index/rotate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Step 1: a pending blind index version in the opposite slot (writes become dual)' })
  async blindIndexRotate(@CurrentUser() user: JwtPayload) {
    this.assertDev();
    return { success: true, data: await this.rotation.rotateBlindIndex({ actorId: user.sub, reason: 'dev drill' }) };
  }

  @Post('blind-index/reindex')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Step 2: fill the pending slot and activate it now (skips the cache window)' })
  async blindIndexReindex() {
    this.assertDev();
    await this.rotation.reindex({ force: true });
    return this.blindIndexStatus();
  }

  @Post('blind-index/retire')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Step 3: retire the previous version and clear its slot column' })
  async blindIndexRetire(@Body() body: unknown) {
    this.assertDev();
    const { kid } = kidBody.parse(body ?? {});
    await this.rotation.blindIndexRetire({ kid });
    return this.blindIndexStatus();
  }

  // ---- Учения ротации корня (окно двух корней: API поднят с KEYS_ROOT_KEY_FILE_NEXT) ----

  @Get('root/status')
  @ApiOperation({ summary: '[dev] Root rotation: current/next fingerprints and versions under each' })
  async rootStatus() {
    this.assertDev();
    return { success: true, data: { ...(await this.store.rootRotationStatus()), started: await this.store.rootRotationStarted() } };
  }

  @Post('root/rewrap')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Re-wrap every key version under the next root now (batches)' })
  async rootRewrap() {
    this.assertDev();
    await this.rotation.assertFleetHoldsRoot(this.store.provider.nextRootKid ?? '');
    await this.rotation.rootRewrap();
    return this.rootStatus();
  }

  @Post('scope/freeze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Freeze all key versions of a scope (kill-switch drill)' })
  async freeze(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const scope = scopeBody.parse(body ?? {});
    const s = scope.type === 'workspace' ? workspaceScope(scope.id) : userScope(scope.id);
    return { success: true, data: { versions: await this.store.freezeScope(s, { actorId: user.sub, actorKind: 'user', reason: 'dev drill' }) } };
  }

  @Post('scope/unfreeze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Unfreeze a scope' })
  async unfreeze(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const scope = scopeBody.parse(body ?? {});
    const s = scope.type === 'workspace' ? workspaceScope(scope.id) : userScope(scope.id);
    return { success: true, data: { versions: await this.store.unfreezeScope(s, { actorId: user.sub, actorKind: 'user', reason: 'dev drill' }) } };
  }

  @Post('roundtrip')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Encrypt → decrypt a value under the caller scope (or a given one) and HMAC it' })
  async roundtrip(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const dto = roundtripBody.parse(body ?? {});
    const scope: KeyScopeRef = dto.scope ? { type: dto.scope.type, id: dto.scope.id } : { type: 'user', id: user.sub };
    const ctx = { entity: 'dev', field: 'roundtrip', ownerType: scope.type, ownerId: scope.id };
    const stored = await this.envelope.encrypt(scope, ctx, dto.plaintext);
    const back = await this.envelope.decrypt(scope, ctx, stored);
    const foreign = await this.envelope.tryDecrypt(scope, { ...ctx, field: 'other' }, stored);
    const mac = await this.mac.tagged('verify_otp', dto.plaintext);
    const macOk = await this.mac.verifyTagged('verify_otp', dto.plaintext, mac);
    const bi = await this.envelope.blindIndex('phone', dto.plaintext);
    const kek = await this.store.getKey(this.envelope.scopeKey(scope), 'kek', KEK_NAME);
    return { success: true, data: { stored, back, roundtripOk: back === dto.plaintext, aadBound: !foreign.ok, kekKid: this.envelope.kekKidOf(stored), primaryKid: kek?.primaryKid ?? null, mac, macOk, blindIndex: bi } };
  }

  @Get('pii/status')
  @ApiOperation({ summary: '[dev] PII layer: read mode and rows still without _enc per model/field' })
  async piiStatus() {
    this.assertDev();
    return { success: true, data: await this.pii.status() };
  }

  @Post('pii/mode')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Switch the PII read mode of THIS process (legacy | encrypted) for drills' })
  async piiMode(@Body() body: unknown) {
    this.assertDev();
    const { mode } = z.object({ mode: z.enum(['legacy', 'encrypted']) }).strict().parse(body ?? {});
    // Только dev: в production режим задаёт деплой (env), переключение на лету запрещено
    process.env.KEYS_PII_READ_MODE = mode;
    return { success: true, data: { mode } };
  }

  @Post('pii/backfill')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Run the PII backfill (_enc/_bi for plaintext rows) synchronously' })
  async piiBackfill() {
    this.assertDev();
    return { success: true, data: { values: await this.pii.backfill() } };
  }

  @Post('usage/flush')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Flush key usage (last_used, access log) from Redis to the DB now' })
  async usageFlush() {
    this.assertDev();
    const keys = await this.usage.flushLastUsed();
    const log = await this.usage.flushAccessLog();
    return { success: true, data: { keys, log } };
  }

  /**
   * Учение потолков: выставить счётчик ключа (`rate` — корзина текущей минуты, `export` —
   * строки за сегодня) в значение — следующий запрос ключом упрётся в 429. Сьют не может
   * честно сделать 600 запросов в минуту и выгрузить 200 000 строк.
   */
  @Post('usage/throttle')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Seed the per-key rate / export counters to drill the 429 paths' })
  async usageThrottle(@Body() body: unknown) {
    this.assertDev();
    const { keyId, kind, value } = z.object({ keyId: z.string().uuid(), kind: z.enum(['rate', 'export']), value: z.number().int().min(0) }).strict().parse(body ?? {});
    const client = this.redis.getClient();
    const key = kind === 'rate' ? KEYS_REDIS.rate(keyId, Math.floor(Date.now() / 60_000)) : KEYS_REDIS.exportRows(keyId, new Date().toISOString().slice(0, 10));
    if (value === 0) await client.del(key);
    else await client.set(key, String(value), 'EX', kind === 'rate' ? 120 : 2 * 86_400);
    return { success: true, data: { key, value } };
  }

  @Post('usage/partitions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Create api_access_log partitions ahead and drop the ones past retention (security log partitions: /audit/dev/partitions)' })
  async usagePartitions() {
    this.assertDev();
    await this.usage.partitions.ensureAhead();
    const access = await this.usage.partitions.dropExpired();
    return { success: true, data: { access: { dropped: access, partitions: (await this.usage.partitions.list()).map((p) => p.name) } } };
  }

  @Post('usage/daily')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Run the daily key sweep now (expiring / expired notifications; access-log retention — core/lifecycle)' })
  async usageDaily() {
    this.assertDev();
    const notified = await this.usage.notifyExpiring();
    const purged = (await this.usage.partitions.dropExpired()).length;
    return { success: true, data: { notified, purged } };
  }

  @Post('legacy/reencrypt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Re-encrypt legacy rows (derived keys / plaintext) into envelopes now' })
  async reencrypt() {
    this.assertDev();
    return { success: true, data: { rows: await this.rotation.reencryptLegacy() } };
  }

  @Post('signing/sign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] Sign a short-lived test token for an audience and verify it back' })
  async signTest(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const { audience } = audienceBody.parse(body ?? {});
    const token = await this.signing.sign(audience, { sub: user.sub, drill: true }, { ttlSec: 60, typ: 'test+jwt' });
    const payload = await this.signing.verify(audience, token, { typ: 'test+jwt' });
    return { success: true, data: { token, kid: JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()).kid, payload } };
  }
}
