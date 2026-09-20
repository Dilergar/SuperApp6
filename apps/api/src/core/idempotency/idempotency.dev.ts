import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DatabaseService } from '../../shared/database/database.service';
import { isDevEnv } from '../../shared/config/env.validation';
import { CurrentUser, type JwtPayload } from '../../shared/decorators/current-user.decorator';
import { Idempotent, SkipIdempotency } from '../../shared/decorators/idempotency.decorator';
import { badRequest, conflict, forbidden } from '../../shared/errors/api-error';
import { runInternal } from '../../shared/idempotency/binding';
import { IdempotencyService } from './idempotency.service';

/** Маркер «эффект случился». Живёт в таблице ящика: у неё уже есть нужный уникум. */
const DEV_SOURCE = 'idem_dev';

const tagBody = z.object({ tag: z.string().min(4).max(64) }).strict();
const simulateBody = z
  .object({
    /** Во что превратить строку ключа: «процесс умер после заявки» | «…после коммита эффекта» */
    state: z.enum(['in_progress', 'committed']),
    /**
     * Что сделать с арендой: `expire` — состарить (повтор увидит брошенную попытку),
     * `extend` — продлить (повтор увидит ЖИВУЮ попытку), `keep` — не трогать.
     */
    lease: z.enum(['expire', 'extend', 'keep']).default('expire'),
    /** Сдвинуть номер попытки — прошлая становится устаревшей (проверка fencing) */
    bumpAttempt: z.boolean().default(false),
    /**
     * Какие заявки трогать: по умолчанию только дев-полигон. Хвост маршрута
     * (`/wallet/currency/mint`) позволяет прогнать учение на НАСТОЯЩЕЙ форме —
     * именно так проверяется веб-часть («могло пройти», «уже выполнено»).
     */
    routeSuffix: z.string().min(3).max(120).regex(/^[A-Za-z0-9/:_-]+$/).optional(),
  })
  .strict();

/**
 * Дев-полигон движка идемпотентности (только development/test — в production
 * контроллера нет вовсе). Настоящую смерть процесса в сьюте не воспроизвести,
 * поэтому её МОДЕЛИРУЕТ `/simulate`: он приводит строку ключа ровно в то
 * состояние, в котором её оставил бы упавший инстанс.
 *
 * Эффект — строка-маркер: сьют считает их и видит, случился ли эффект дважды.
 */
@ApiTags('Idempotency')
@ApiBearerAuth()
@Controller('idempotency/dev')
export class IdempotencyDevController {
  constructor(
    private readonly db: DatabaseService,
    private readonly idem: IdempotencyService,
  ) {}

  private assertDev(): void {
    if (!isDevEnv()) throw forbidden('dev.developmentOnly');
  }

  /** Один эффект = одна строка-маркер. Пишется В транзакции — как настоящая мутация. */
  private async effect(tag: string, userId: string): Promise<string> {
    const id = randomUUID();
    await this.db.$transaction(async (tx) => {
      await tx.idempotencyInbox.create({ data: { source: DEV_SOURCE, account: `${userId}:${tag}`, eventId: id } });
    });
    return id;
  }

  @Get('effects')
  @SkipIdempotency('no_side_effects')
  @ApiOperation({ summary: '[dev] How many effects were recorded under this tag' })
  async effects(@CurrentUser() user: JwtPayload, @Query('tag') tag?: string) {
    this.assertDev();
    if (!tag) throw badRequest('validation.required', { path: 'tag' });
    const count = await this.db.idempotencyInbox.count({ where: { source: DEV_SOURCE, account: `${user.sub}:${tag}` } });
    return { success: true, data: { tag, count } };
  }

  /** Обычная мутация: одна транзакция, один эффект. Ключ необязателен. */
  @Post('effect')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '[dev] One effect in one transaction' })
  async one(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const dto = tagBody.parse(body ?? {});
    const id = await this.effect(dto.tag, user.sub);
    return { success: true, data: { id, derived: this.idem.deriveKey('dev.effect') } };
  }

  /** Обещание `atomic`: ровно одна транзакция ⇒ брошенную попытку безопасно повторить. */
  @Post('atomic')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent({ required: true, atomic: true })
  @ApiOperation({ summary: '[dev] atomic:true — exactly one transaction' })
  async atomic(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const dto = tagBody.parse(body ?? {});
    const id = await this.effect(dto.tag, user.sub);
    return { success: true, data: { id } };
  }

  /** Необратимая операция: ключ обязателен. */
  @Post('required')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent({ required: true })
  @ApiOperation({ summary: '[dev] required:true — the key is mandatory' })
  async required(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const dto = tagBody.parse(body ?? {});
    const id = await this.effect(dto.tag, user.sub);
    return { success: true, data: { id } };
  }

  /** Ответ несёт секрет: снимок не хранится, повтор получит `already_completed`. */
  @Post('secret')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent({ required: true, store: 'none' })
  @ApiOperation({ summary: '[dev] store:none — the body is never stored' })
  async secret(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const dto = tagBody.parse(body ?? {});
    const id = await this.effect(dto.tag, user.sub);
    return { success: true, data: { id, secret: `sa6dev_${randomUUID()}` } };
  }

  /** Тело больше потолка снимка ⇒ повтор без тела (`already_completed`). */
  @Post('big')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent({ required: true })
  @ApiOperation({ summary: '[dev] A response larger than the snapshot cap' })
  async big(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const dto = tagBody.parse(body ?? {});
    const id = await this.effect(dto.tag, user.sub);
    return { success: true, data: { id, filler: 'x'.repeat(80 * 1024) } };
  }

  /** Наблюдаемого эффекта нет: ключ обязан быть отпущен (`released`). */
  @Post('readonly')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[dev] A read-only POST — nothing to protect' })
  async readonly(@CurrentUser() user: JwtPayload) {
    this.assertDev();
    const count = await this.db.idempotencyInbox.count({ where: { source: DEV_SOURCE, account: { startsWith: `${user.sub}:` } } });
    return { success: true, data: { count } };
  }

  /** Отказ БЕЗ коммита эффекта: ключ отпускается, повтор с исправленным телом законен. */
  @Post('fail')
  @Idempotent({ required: true })
  @ApiOperation({ summary: '[dev] Fail before or after committing the effect' })
  async fail(@CurrentUser() user: JwtPayload, @Body() body: unknown, @Query('after') after?: string) {
    this.assertDev();
    const dto = tagBody.parse(body ?? {});
    if (after === 'commit') {
      await this.effect(dto.tag, user.sub);
      throw conflict('dev.simulatedFailure');
    }
    throw conflict('dev.simulatedFailure');
  }

  /**
   * Вложенная и параллельная транзакции: отметку трогает только первая, остальные
   * дают `dirty`. Если бы их пускали к отметке, второй UPDATE той же строки с другого
   * соединения устроил бы само-дедлок, невидимый для Postgres.
   */
  @Post('nested')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent({ required: true })
  @ApiOperation({ summary: '[dev] Nested + parallel transactions must not deadlock' })
  async nested(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const dto = tagBody.parse(body ?? {});
    await this.db.$transaction(async (tx) => {
      await tx.idempotencyInbox.create({ data: { source: DEV_SOURCE, account: `${user.sub}:${dto.tag}`, eventId: randomUUID() } });
      // Вложенная: корневой клиент внутри чужой транзакции — законный приём каскадов
      await this.db.$transaction(async (inner) => {
        await inner.idempotencyInbox.create({ data: { source: DEV_SOURCE, account: `${user.sub}:${dto.tag}:nested`, eventId: randomUUID() } });
      });
    });
    // Параллельные — стартуют одновременно после первой
    await Promise.all([
      this.db.$transaction(async (tx) => {
        await tx.idempotencyInbox.create({ data: { source: DEV_SOURCE, account: `${user.sub}:${dto.tag}:p1`, eventId: randomUUID() } });
      }),
      this.db.$transaction(async (tx) => {
        await tx.idempotencyInbox.create({ data: { source: DEV_SOURCE, account: `${user.sub}:${dto.tag}:p2`, eventId: randomUUID() } });
      }),
    ]);
    return { success: true, data: { ok: true } };
  }

  /** Ручка дольше аренды: heartbeat обязан удержать заявку. */
  @Post('slow')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent({ required: true })
  @ApiOperation({ summary: '[dev] A handler that runs longer than the lease' })
  async slow(@CurrentUser() user: JwtPayload, @Body() body: unknown, @Query('ms') ms?: string) {
    this.assertDev();
    const dto = tagBody.parse(body ?? {});
    const wait = Math.min(120_000, Math.max(0, Number(ms) || 0));
    await new Promise((resolve) => setTimeout(resolve, wait));
    const id = await this.effect(dto.tag, user.sub);
    return { success: true, data: { id } };
  }

  /**
   * Смерть процесса: привести строку ключа в то состояние, в котором её оставил бы
   * упавший инстанс. `in_progress` + истёкшая аренда = «умер после заявки»;
   * `committed` = «эффект закоммичен, ответ не собран».
   */
  @Post('simulate')
  @HttpCode(HttpStatus.OK)
  @SkipIdempotency('own_mechanism')
  @ApiOperation({ summary: '[dev] Leave the key row as a crashed instance would' })
  async simulate(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    this.assertDev();
    const dto = simulateBody.parse(body ?? {});
    const n = await runInternal(() =>
      this.db.$executeRawUnsafe(
        `UPDATE idem.keys SET
           state = $2,
           attempt = attempt + CASE WHEN $3 THEN 1 ELSE 0 END,
           lease_until = CASE $4
                           WHEN 'expire' THEN (now() AT TIME ZONE 'UTC') - make_interval(mins => 5)
                           WHEN 'extend' THEN (now() AT TIME ZONE 'UTC') + make_interval(mins => 5)
                           ELSE lease_until
                         END,
           http_status = NULL, error_code = NULL, response_id = NULL, response_at = NULL, completed_at = NULL
         WHERE user_id = $1::uuid AND route LIKE $5`,
        user.sub,
        dto.state,
        dto.bumpAttempt,
        dto.lease,
        dto.routeSuffix ? `%${dto.routeSuffix}%` : '%/idempotency/dev/%',
      ),
    );
    return { success: true, data: { rows: n } };
  }

  /** Убрать следы учения: маркеры эффектов и строки ключей дев-полигона. */
  @Post('reset')
  @HttpCode(HttpStatus.OK)
  @SkipIdempotency('own_mechanism')
  @ApiOperation({ summary: '[dev] Remove this account markers and dev key rows' })
  async reset(@CurrentUser() user: JwtPayload) {
    this.assertDev();
    const markers = await this.db.idempotencyInbox.deleteMany({
      where: { source: DEV_SOURCE, account: { startsWith: `${user.sub}:` } },
    });
    const keys = await runInternal(() =>
      this.db.$executeRawUnsafe(
        `DELETE FROM idem.keys WHERE user_id = $1::uuid AND route LIKE '%/idempotency/dev/%'`,
        user.sub,
      ),
    );
    return { success: true, data: { markers: markers.count, keys } };
  }
}
